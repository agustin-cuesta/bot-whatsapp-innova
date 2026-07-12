require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// Historial de conversaciones por número (para mantener contexto)
const conversaciones = {};

// Prompt del sistema — personalidad del bot para InnovaInternacional
const SYSTEM_PROMPT = `Eres un asistente virtual amable y profesional de InnovaInternacional, 
una tienda de venta de ropa. Tu trabajo es ayudar a los clientes con:
- Información sobre productos y colecciones disponibles
- Tallas, precios y disponibilidad
- Proceso de compra y formas de pago
- Envíos y tiempos de entrega
- Devoluciones y cambios
- Cualquier consulta relacionada con la tienda

Responde siempre en español, de forma cordial y concisa. 
Si no tienes información específica sobre un producto, sugiere al cliente 
que se comunique directamente con la tienda para más detalles.
Mantén las respuestas cortas y directas, ideales para WhatsApp.`;

// ─── Webhook: verificación de Meta ───────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verificación fallida");
    res.sendStatus(403);
  }
});

// ─── Webhook: recibir mensajes ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      return res.sendStatus(200);
    }

    const message = messages[0];
    const from = message.from;
    const messageType = message.type;

    // Solo procesamos mensajes de texto
    if (messageType !== "text") {
      await enviarMensaje(from, "Por el momento solo puedo responder mensajes de texto. 😊");
      return res.sendStatus(200);
    }

    const textoRecibido = message.text.body;
    console.log(`📩 Mensaje de ${from}: ${textoRecibido}`);

    // Inicializar historial si es primera vez
    if (!conversaciones[from]) {
      conversaciones[from] = [];
    }

    // Agregar mensaje del usuario al historial
    conversaciones[from].push({ role: "user", parts: [{ text: textoRecibido }] });

    // Limitar historial a últimos 10 mensajes
    if (conversaciones[from].length > 10) {
      conversaciones[from] = conversaciones[from].slice(-10);
    }

    // Obtener respuesta de Gemini
    const respuesta = await obtenerRespuestaGemini(conversaciones[from]);

    // Agregar respuesta al historial
    conversaciones[from].push({ role: "model", parts: [{ text: respuesta }] });

    // Enviar respuesta por WhatsApp
    await enviarMensaje(from, respuesta);
    console.log(`✅ Respuesta enviada a ${from}: ${respuesta}`);

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook:", error.message);
    if (error.response) {
      console.error("📋 Status:", error.response.status);
      console.error("📋 Data:", JSON.stringify(error.response.data, null, 2));
    }
    res.sendStatus(500);
  }
});

// ─── Función: consultar Groq ──────────────────────────────────────────────────
async function obtenerRespuestaGemini(historial) {
  try {
    // Convertir historial de Gemini a formato OpenAI/Groq
    const mensajes = [
      { role: "system", content: SYSTEM_PROMPT },
      ...historial.map(m => ({
        role: m.role === "model" ? "assistant" : "user",
        content: m.parts[0].text
      }))
    ];

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: mensajes,
        max_tokens: 500,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error con Groq:", error.message);
    if (error.response) {
      console.error("📋 Groq Status:", error.response.status);
      console.error("📋 Groq Data:", JSON.stringify(error.response.data, null, 2));
    }
    return "Lo siento, tuve un problema técnico. Por favor intenta de nuevo en un momento. 🙏";
  }
}

// ─── Función: enviar mensaje por WhatsApp ─────────────────────────────────────
async function enviarMensaje(to, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("❌ Error enviando mensaje WhatsApp:", error.message);
    if (error.response) {
      console.error("📋 WhatsApp Status:", error.response.status);
      console.error("📋 WhatsApp Data:", JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot InnovaInternacional corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
});
