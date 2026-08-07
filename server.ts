import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Increase payload limit for base64 audio chunks
app.use(express.json({ limit: "25mb" }));

// Initialize GoogleGenAI
const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is missing.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
};

// API Endpoint: Transcribe Audio Chunk
app.post("/api/transcribe-chunk", async (req, res) => {
  try {
    const { audioBase64, mimeType, previousContext = "", targetLanguage = "auto" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "No audio data provided." });
    }

    const ai = getGenAI();

    // Clean base64 string if data URL prefix exists
    const cleanBase64 = audioBase64.replace(/^data:audio\/[a-z0-9]+;base64,/, "");

    const promptText = `
Analiza el fragmento de audio proporcionado de una transmisión en vivo y transcribe con alta precisión lo que se habla.

INSTRUCCIONES IMPORTANTES:
1. Transcribe FIELMENTE el habla que escuchas en el idioma original en el que se está hablando (generalmente español o inglés).
2. Si la opción de idioma preferido está fijada en '${targetLanguage}' y no es 'auto', procura transcribir o adaptar la salida principal a ${targetLanguage}, o mantén el idioma original si es lo más natural.
3. Contexto anterior de la conversación para continuidad: "${previousContext.slice(-300)}"
4. Si no se escucha ningún habla clara (solo silencio, música instrumental o ruido de fondo), responde con un texto vacío "".
5. Identifica de manera aproximada si hay cambio de hablante si es relevante.

Responde estrictamente en formato JSON con el esquema solicitado.
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || "audio/webm",
              data: cleanBase64,
            },
          },
          {
            text: promptText,
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: {
              type: Type.STRING,
              description: "El texto transcrito exacto de este fragmento de audio.",
            },
            detectedLanguage: {
              type: Type.STRING,
              description: "El idioma detectado (ej: 'Español', 'Inglés').",
            },
            speaker: {
              type: Type.STRING,
              description: "Identificación o etiqueta del hablante si se puede inferir.",
            },
            hasSpeech: {
              type: Type.BOOLEAN,
              description: "Indica si se detectó voz o habla comprensible.",
            },
          },
          required: ["transcript", "hasSpeech"],
        },
      },
    });

    const jsonText = response.text || "{}";
    let parsed = { transcript: "", detectedLanguage: "Español", speaker: "", hasSpeech: false };
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed.transcript = response.text || "";
      parsed.hasSpeech = Boolean(parsed.transcript.trim());
    }

    return res.json(parsed);
  } catch (error: any) {
    console.error("Error in /api/transcribe-chunk:", error);
    return res.status(500).json({ error: error?.message || "Error al procesar el audio" });
  }
});

// API Endpoint: Summarize & Extract Insights from Transcript
app.post("/api/summarize-transcript", async (req, res) => {
  try {
    const { fullTranscript } = req.body;

    if (!fullTranscript || !fullTranscript.trim()) {
      return res.status(400).json({ error: "Transcripción vacía." });
    }

    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `
Analiza la siguiente transcripción en tiempo real tomada de una pestaña o audio y genera un resumen ejecutivo estructurado en español.

Transcripción:
"""
${fullTranscript}
"""

Responde estrictamente en JSON con el siguiente formato:
{
  "summary": "Resumen conciso en 2-3 oraciones clave.",
  "keyPoints": ["Punto clave 1", "Punto clave 2", "Punto clave 3"],
  "topics": ["Tema 1", "Tema 2"],
  "actionItems": ["Conclusión o elemento relevante 1"]
}
`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            keyPoints: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            topics: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            actionItems: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["summary", "keyPoints", "topics"],
        },
      },
    });

    const result = JSON.parse(response.text || "{}");
    return res.json(result);
  } catch (error: any) {
    console.error("Error in /api/summarize-transcript:", error);
    return res.status(500).json({ error: error?.message || "Error al resumir transcripción." });
  }
});

// API Endpoint: Translate Transcript Segment or Full
app.post("/api/translate-transcript", async (req, res) => {
  try {
    const { text, targetLanguage = "Inglés" } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto vacío." });
    }

    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `Traduce de manera fluida y precisa el siguiente texto al idioma ${targetLanguage}. Mantén el tono natural y la puntuación adecuada:\n\n"${text}"`,
    });

    return res.json({ translatedText: response.text?.trim() || text });
  } catch (error: any) {
    console.error("Error in /api/translate-transcript:", error);
    return res.status(500).json({ error: error?.message || "Error al traducir." });
  }
});

// API Endpoint: Ask Questions about the Transcript and Screen
app.post("/api/chat-transcript", async (req, res) => {
  try {
    const { fullTranscript, question, imageBase64 } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: "Pregunta vacía." });
    }

    const ai = getGenAI();

    const promptText = `
Eres VoxStream, un asistente IA en vivo para análisis de pantalla y audio transmitido.
Responde de forma clara, directa, precisa y útil. Si hay preguntas de opción múltiple, examen o ejercicios en pantalla, proporciona la respuesta directa primero.

Transcripción acumulada del audio en vivo:
"""
${fullTranscript || "(Sin transcripción de audio previa)"}
"""

Pregunta o instrucción del usuario:
${question}
`;

    let contentsPayload: any;

    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z0-9]+;base64,/, "");
      contentsPayload = {
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: cleanBase64,
            },
          },
          {
            text: promptText,
          },
        ],
      };
    } else {
      contentsPayload = promptText;
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: contentsPayload,
    });

    return res.json({ answer: response.text?.trim() || "No pude generar una respuesta." });
  } catch (error: any) {
    console.error("Error in /api/chat-transcript:", error);
    return res.status(500).json({ error: error?.message || "Error al responder pregunta." });
  }
});

// API Endpoint: Fast Vision Query for Screen/Tab Captures (Exam Helper)
app.post("/api/fast-vision-query", async (req, res) => {
  try {
    const { imageBase64, prompt, mode = "fast_answer" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No se proporcionó imagen de la pantalla." });
    }

    const ai = getGenAI();

    // Clean base64 image data
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z0-9]+;base64,/, "");

    let systemInstruction = "";
    if (mode === "fast_answer") {
      systemInstruction = `
Eres un asistente de evaluación y respuesta rápida de pantalla.
Analiza la imagen capturada de la pestaña en vivo y responde la pregunta o ejercicio que aparece en pantalla de forma ULTRA CONCISA, RÁPIDA Y EXACTA.
- Si es una pregunta de opción múltiple (A, B, C, D), indica PRIMERO en negrita la opción correcta con una breve justificación de 1 frase.
- Si es un problema o concepto, da la solución directa primero.
- Sé extremadamente breve, claro y directo. Sin saludos ni rodeos innecesarios.
`;
    } else if (mode === "explain") {
      systemInstruction = `
Analiza la captura de pantalla y explica el concepto o gráfica mostrado de manera muy concisa en 2 o 3 viñetas breves.
`;
    } else {
      systemInstruction = `
Responde de forma clara, directa y concisa a la consulta del usuario basándote en la captura de la pantalla enviada.
`;
    }

    const userQuery = prompt || "Analiza el contenido visible y responde la pregunta o ejercicio mostrado.";

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: cleanBase64,
            },
          },
          {
            text: `${systemInstruction}\n\nConsulta específica: ${userQuery}`,
          },
        ],
      },
    });

    return res.json({
      answer: response.text?.trim() || "No se detectó una pregunta clara en la imagen.",
    });
  } catch (error: any) {
    console.error("Error in /api/fast-vision-query:", error);
    return res.status(500).json({ error: error?.message || "Error al analizar la imagen de pantalla." });
  }
});

async function startServer() {
  // Vite dev middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
