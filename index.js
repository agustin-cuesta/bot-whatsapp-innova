require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// Historial de conversaciones por número/plataforma (para mantener contexto)
const conversaciones = {};

// Palabras clave que indican que el cliente quiere hablar con un humano
const PALABRAS_HUMANO = [
  "hablar con alguien", "hablar con un humano", "hablar con una persona",
  "hablar con agente", "atención al cliente", "servicio al cliente",
  "un agente", "una persona", "un humano", "quiero hablar con",
  "necesito hablar con", "atenderme", "atención personalizada",
  "transferir", "transferirme", "conversar con", "asesor humano",
  "representante", "ejecutivo", "encargado", "dueño", "gerente"
];

function detectarSolicitudHumano(texto) {
  const textoLower = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return PALABRAS_HUMANO.some(palabra => textoLower.includes(palabra));
}

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
Mantén las respuestas cortas y directas.`;

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

// ─── Endpoint de prueba ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "InnovaBot", platforms: ["whatsapp", "facebook", "instagram"] });
});

// ─── Webhook: recibir mensajes ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const object = body.object;

    console.log(`📥 Webhook recibido - object: ${object}`);
    console.log(`📥 Body completo:`, JSON.stringify(body, null, 2));

    // Aceptar mensajes de WhatsApp, Facebook e Instagram
    const plataformasValidas = [
      "whatsapp_business_account",
      "page",
      "instagram"
    ];

    if (!plataformasValidas.includes(object)) {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const platform = object === "whatsapp_business_account" ? "whatsapp" : object;

    // WhatsApp: entry.changes[0].value.messages
    // Facebook/Instagram: entry.messaging (directo en entry)
    let rawMessages;
    if (platform === "whatsapp") {
      const change = entry?.changes?.[0];
      const value = change?.value;
      rawMessages = value?.messages;
    } else {
      // Messenger e Instagram usan entry.messaging directamente
      rawMessages = entry?.messaging;
    }

    if (!rawMessages || rawMessages.length === 0) {
      return res.sendStatus(200);
    }

    const raw = rawMessages[0];
    let from = "";
    let textoRecibido = "";

    if (platform === "whatsapp") {
      // WhatsApp: { from, type: "text", text: { body } }
      from = raw.from;
      if (raw.type !== "text") {
        await enviarMensaje(from, "Por el momento solo puedo responder mensajes de texto. 😊", platform);
        return res.sendStatus(200);
      }
      textoRecibido = raw.text?.body || "";
    } else {
      // Facebook/Instagram: { sender: { id }, message: { text } }
      from = raw.sender?.id;
      const msg = raw.message;
      if (!msg || !msg.text) {
        // No es texto (sticker, imagen, etc.)
        if (from) {
          await enviarMensaje(from, "Por el momento solo puedo responder mensajes de texto. 😊", platform);
        }
        return res.sendStatus(200);
      }
      textoRecibido = msg.text;
    }

    if (!from || !textoRecibido) {
      return res.sendStatus(200);
    }

    console.log(`📩 [${platform.toUpperCase()}] Mensaje de ${from}: ${textoRecibido}`);

    // Detectar si el cliente quiere hablar con un humano
    if (detectarSolicitudHumano(textoRecibido)) {
      const respuestaHumano = "Un agente se comunicará contigo en breve. Gracias por tu paciencia. 😊";
      await enviarMensaje(from, respuestaHumano, platform);

      if (process.env.OWNER_PHONE) {
        await enviarMensaje(
          process.env.OWNER_PHONE,
          `🔔 *Cliente necesita atención humana*\n\n📱 Plataforma: ${platform}\n📞 ID: ${from}\n💬 Mensaje: "${textoRecibido}"`,
          "whatsapp"
        );
      }

      console.log(`🔔 Notificación enviada al dueño - Cliente: ${from} (${platform})`);
      res.sendStatus(200);
      return;
    }

    // Clave única por plataforma + usuario
    const clave = `${platform}:${from}`;

    // Inicializar historial si es primera vez
    if (!conversaciones[clave]) {
      conversaciones[clave] = [];
    }

    // Agregar mensaje del usuario al historial
    conversaciones[clave].push({ role: "user", parts: [{ text: textoRecibido }] });

    // Limitar historial a últimos 10 mensajes
    if (conversaciones[clave].length > 10) {
      conversaciones[clave] = conversaciones[clave].slice(-10);
    }

    // Obtener respuesta de la IA
    const respuesta = await obtenerRespuesta(conversaciones[clave]);

    // Agregar respuesta al historial
    conversaciones[clave].push({ role: "model", parts: [{ text: respuesta }] });

    // Enviar respuesta por la misma plataforma
    await enviarMensaje(from, respuesta, platform);
    console.log(`✅ [${platform.toUpperCase()}] Respuesta enviada a ${from}: ${respuesta}`);

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
async function obtenerRespuesta(historial) {
  try {
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

// ─── Función: enviar mensaje por cualquier plataforma ─────────────────────────
async function enviarMensaje(to, texto, platform = "whatsapp") {
  try {
    if (platform === "whatsapp") {
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
    } else if (platform === "page") {
      // Facebook Messenger
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PAGE_ID}/messages`,
        {
          recipient: { id: to },
          message: { text: texto },
          messaging_type: "RESPONSE",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAGE_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
    } else if (platform === "instagram") {
      // Instagram DM usa el Page Access Token (vinculado a la página de Facebook)
      const igToken = process.env.INSTAGRAM_TOKEN || process.env.PAGE_ACCESS_TOKEN;
      await axios.post(
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: to },
          message: { text: texto },
          messaging_type: "RESPONSE",
        },
        {
          headers: {
            Authorization: `Bearer ${igToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    }
  } catch (error) {
    console.error(`❌ Error enviando mensaje [${platform}]:`, error.message);
    if (error.response) {
      console.error("📋 Status:", error.response.status);
      console.error("📋 Data:", JSON.stringify(error.response.data, null, 2));
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
