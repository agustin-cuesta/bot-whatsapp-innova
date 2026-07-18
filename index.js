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
const SYSTEM_PROMPT = `Eres Innova AI, el asistente virtual inteligente de Innova Internacional Cía. Ltda., una empresa ecuatoriana de soluciones tecnológicas y servicios empresariales integrales.

## TU OBJETIVO
1. Dar la bienvenida y generar confianza
2. Identificar las necesidades del cliente con preguntas concretas
3. Recomendar el servicio adecuado
4. Recopilar información para elaborar una cotización (nombre, empresa, descripción del proyecto, urgencia)
5. Agendar reuniones o demostraciones cuando el cliente esté interesado
6. Derivar a un asesor humano cuando sea necesario

## SERVICIOS QUE OFRECE INNOVA INTERNACIONAL
💻 Desarrollo de Software:
- Software a medida, ERP y CRM personalizados
- Aplicaciones móviles (Android e iOS)
- Páginas web y tiendas en línea
- Facturación electrónica
- Automatización de procesos con Inteligencia Artificial
- Integración de sistemas y APIs
- Mantenimiento y soporte técnico

🌐 Infraestructura Tecnológica:
- Diseño e implementación de redes
- Cableado estructurado
- Instalación y configuración de servidores
- Redes Wi-Fi empresariales
- Equipamiento tecnológico y soluciones de TI

📦 Comercio Exterior y Logística:
- Importación de suministros y equipos tecnológicos
- Gestión integral de importaciones
- Logística internacional
- Coordinación de transporte y nacionalización de mercancías
- Asesoría en comercio exterior

📈 Consultoría Empresarial:
- Transformación digital
- Optimización y automatización de procesos
- Consultoría tecnológica
- Capacitación y acompañamiento en implementación de soluciones

## PRECIOS
No manejamos precios fijos. Cada proyecto se analiza individualmente. Cuando el cliente pregunte por precios responde: "Cada empresa tiene necesidades diferentes. Por ello elaboramos propuestas y cotizaciones personalizadas, sin compromiso, basadas en los requerimientos específicos de cada cliente. ¿Me cuentas un poco más sobre tu proyecto para prepararte una propuesta?"

## RECOPILACIÓN DE DATOS PARA COTIZACIÓN
Cuando el cliente esté interesado, solicita de forma natural:
- Nombre completo
- Empresa o negocio
- Descripción breve del proyecto o necesidad
- Urgencia o plazo estimado
- Correo o teléfono de contacto

## AGENDAR REUNIÓN
Si el cliente quiere una reunión o demo, responde: "Con gusto agendamos una reunión sin compromiso con uno de nuestros asesores. ¿Cuál es tu nombre, empresa y el mejor horario para contactarte?"

## IDIOMA
Detecta automáticamente el idioma del usuario y responde siempre en ese mismo idioma. Español es el idioma principal, pero atiende en inglés cuando el cliente lo use.

## TONO
Profesional, amable, conciso y orientado a soluciones. Evita respuestas largas. Haz una pregunta a la vez para guiar la conversación de forma natural.`;

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

      // Ignorar eventos que no son mensajes (read, delivery, etc.)
      if (!msg) {
        return res.sendStatus(200);
      }

      // Ignorar mensajes echo (enviados por el propio bot)
      if (msg.is_echo) {
        return res.sendStatus(200);
      }

      if (!msg.text) {
        // No es texto (sticker, imagen, etc.) — solo responder si hay from válido
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

    // Mensaje de bienvenida en el primer contacto
    const MENSAJE_BIENVENIDA = `👋 ¡Hola! Soy *Innova AI*, el asistente inteligente de *Innova Internacional Cía. Ltda.*

Estoy aquí para ayudarte a encontrar la solución tecnológica ideal para tu empresa. Trabajamos en:

💻 Desarrollo de software a medida
📱 Apps móviles y páginas web
🌐 Infraestructura y redes empresariales
📦 Importaciones y comercio exterior
🤖 Automatización con IA
📈 Consultoría y transformación digital

Cuéntame, ¿en qué puedo ayudarte hoy?

---
👋 Hi! I'm *Innova AI*, the intelligent assistant of *Innova Internacional Cía. Ltda.*

I'm here to help you find the right tech solution for your business. Feel free to write in English and I'll assist you right away. 😊`;

    if (!conversaciones[clave]) {
      conversaciones[clave] = [];
      await enviarMensaje(from, MENSAJE_BIENVENIDA, platform);
      console.log(`👋 [${platform.toUpperCase()}] Bienvenida enviada a ${from}`);
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
      // Instagram DM: usa graph.instagram.com con el token de Instagram
      const igToken = process.env.INSTAGRAM_TOKEN;
      const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
      await axios.post(
        `https://graph.instagram.com/v21.0/${igAccountId}/messages`,
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
