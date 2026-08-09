type ApiRequest = {
  method?: string;
  url?: string;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | string>;
};

type ApiResponse = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

const getGeminiApiKey = () =>
  process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || "";

const getGenAI = async () => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY environment variable is missing.");
  }

  const { GoogleGenAI, Type } = await import("@google/genai");
  return {
    ai: new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    }),
    Type,
  };
};

const sendJson = (res: ApiResponse, status: number, payload: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const readJsonBody = async (req: ApiRequest) => {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      return req.body ? JSON.parse(req.body) : {};
    }
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString("utf8");
      return text ? JSON.parse(text) : {};
    }
    return req.body as Record<string, any>;
  }

  if (!req[Symbol.asyncIterator]) {
    return {};
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as any) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 50 * 1024 * 1024) {
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
};

const transcribeChunk = async (body: Record<string, any>, res: ApiResponse) => {
  try {
    const { audioBase64, mimeType, previousContext = "", targetLanguage = "auto" } = body;

    if (!audioBase64) {
      return sendJson(res, 400, { error: "No audio data provided." });
    }

    if (!getGeminiApiKey()) {
      return sendJson(res, 503, {
        error: "Gemini no está configurado. Falta GEMINI_API_KEY o GOOGLE_API_KEY en el servidor.",
        code: "GEMINI_API_KEY_MISSING",
        transcript: "",
        hasSpeech: false,
      });
    }

    const { ai, Type } = await getGenAI();
    const cleanBase64 = audioBase64.includes(",")
      ? audioBase64.split(",")[1]
      : audioBase64.replace(/^data:[^;]+;base64,/, "");

    let cleanMimeType = (mimeType || "audio/webm").split(";")[0].trim();
    if (!cleanMimeType || cleanMimeType === "application/octet-stream") {
      cleanMimeType = "audio/webm";
    }

    const promptText = `
Transcribe con absoluta fidelidad y precisión todo el diálogo, voz o habla que se escuche en este fragmento de audio.

INSTRUCCIONES OBLIGATORIAS:
1. Transcribe palabra por palabra en el idioma original en el que se habla (principalmente Español o Inglés).
2. Si el usuario solicitó idioma objetivo '${targetLanguage}' y no es 'auto', adecúa la transcripción o tradúcela si es apropiado, pero prioriza reflejar fielmente lo que se dice.
3. Si el fragmento contiene habla comprensible, establece "hasSpeech": true y pon el texto transcrito en "transcript".
4. Si el fragmento contiene solo silencio o música sin voz, establece "transcript": "" y "hasSpeech": false.
5. Contexto reciente para coherencia: "${String(previousContext).slice(-200)}"

Responde estrictamente en formato JSON.
`;

    const modelsToTry = ["gemini-3.6-flash", "gemini-flash-latest"];
    let jsonText = "";
    const providerErrors: string[] = [];

    for (const modelName of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: {
            parts: [
              { inlineData: { mimeType: cleanMimeType, data: cleanBase64 } },
              { text: promptText },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                transcript: { type: Type.STRING },
                detectedLanguage: { type: Type.STRING },
                speaker: { type: Type.STRING },
                hasSpeech: { type: Type.BOOLEAN },
              },
              required: ["transcript", "hasSpeech"],
            },
          },
        });
        if (response.text) {
          jsonText = response.text;
          break;
        }
      } catch (error: any) {
        providerErrors.push(`${modelName} (schema): ${error?.message || String(error)}`);
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [
                { inlineData: { mimeType: cleanMimeType, data: cleanBase64 } },
                {
                  text: `${promptText}\n\nDevuelve ÚNICAMENTE un objeto JSON válido con los campos: "transcript" (string), "detectedLanguage" (string), "speaker" (string), "hasSpeech" (boolean).`,
                },
              ],
            },
          });
          if (response.text) {
            jsonText = response.text;
            break;
          }
        } catch (fallbackError: any) {
          providerErrors.push(
            `${modelName} (simple): ${fallbackError?.message || String(fallbackError)}`,
          );
        }
      }
    }

    if (!jsonText) {
      console.error("[VERCEL /api/transcribe-chunk] Gemini errors:", providerErrors);
      return sendJson(res, 502, {
        error: "Gemini no pudo procesar el fragmento de audio. Revisa la clave, la cuota y los permisos del modelo.",
        code: "TRANSCRIPTION_PROVIDER_ERROR",
        transcript: "",
        hasSpeech: false,
      });
    }

    let parsed = {
      transcript: "",
      detectedLanguage: "Español",
      speaker: "",
      hasSpeech: false,
    };
    try {
      const sanitized = jsonText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      parsed = JSON.parse(sanitized);
    } catch {
      parsed.transcript = jsonText;
      parsed.hasSpeech = Boolean(jsonText.trim());
    }

    return sendJson(res, 200, parsed);
  } catch (error) {
    console.error("[VERCEL /api/transcribe-chunk ERROR]", error);
    return sendJson(res, 500, {
      error: "Ocurrió un error interno al procesar el audio.",
      code: "TRANSCRIPTION_INTERNAL_ERROR",
      transcript: "",
      hasSpeech: false,
    });
  }
};

const summarizeTranscript = async (body: Record<string, any>, res: ApiResponse) => {
  try {
    const { fullTranscript } = body;
    if (!fullTranscript || !fullTranscript.trim()) {
      return sendJson(res, 400, { error: "Transcripción vacía." });
    }

    const { ai, Type } = await getGenAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `
Analiza la siguiente transcripción en tiempo real tomada de una pestaña o audio y genera un resumen ejecutivo estructurado en español.

Transcripción:
"""
${fullTranscript}
"""

Responde estrictamente en JSON con un resumen, puntos clave, temas y acciones.
`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
            topics: { type: Type.ARRAY, items: { type: Type.STRING } },
            actionItems: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["summary", "keyPoints", "topics"],
        },
      },
    });
    return sendJson(res, 200, JSON.parse(response.text || "{}"));
  } catch (error: any) {
    console.error("[VERCEL /api/summarize-transcript ERROR]", error);
    return sendJson(res, 200, {
      summary: "No se pudo generar el resumen en este momento.",
      keyPoints: [],
      topics: [],
      actionItems: [],
      error: error?.message,
    });
  }
};

const translateTranscript = async (body: Record<string, any>, res: ApiResponse) => {
  const { text, targetLanguage = "Inglés" } = body;
  if (!text || !text.trim()) {
    return sendJson(res, 400, { error: "Texto vacío." });
  }

  try {
    const { ai } = await getGenAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: `Traduce de manera fluida y precisa el siguiente texto al idioma ${targetLanguage}. Mantén el tono natural y la puntuación adecuada:\n\n"${text}"`,
    });
    return sendJson(res, 200, { translatedText: response.text?.trim() || text });
  } catch (error: any) {
    console.error("[VERCEL /api/translate-transcript ERROR]", error);
    return sendJson(res, 200, { translatedText: text, error: error?.message });
  }
};

const chatTranscript = async (body: Record<string, any>, res: ApiResponse) => {
  const { fullTranscript, question, imageBase64 } = body;
  if (!question || !question.trim()) {
    return sendJson(res, 400, { error: "Pregunta vacía." });
  }

  try {
    const { ai } = await getGenAI();
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

    const contents = imageBase64
      ? {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: imageBase64.includes(",")
                  ? imageBase64.split(",")[1]
                  : imageBase64.replace(/^data:[^;]+;base64,/, ""),
              },
            },
            { text: promptText },
          ],
        }
      : promptText;

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents,
    });
    return sendJson(res, 200, {
      answer: response.text?.trim() || "No pude generar una respuesta.",
    });
  } catch (error) {
    console.error("[VERCEL /api/chat-transcript ERROR]", error);
    return sendJson(res, 200, {
      answer: "Ocurrió un inconveniente al procesar la pregunta. Inténtalo de nuevo.",
    });
  }
};

const fastVisionQuery = async (body: Record<string, any>, res: ApiResponse) => {
  const { imageBase64, prompt, mode = "fast_answer" } = body;
  if (!imageBase64) {
    return sendJson(res, 400, { error: "No se proporcionó imagen de la pantalla." });
  }

  try {
    const { ai } = await getGenAI();
    const cleanBase64 = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64.replace(/^data:[^;]+;base64,/, "");

    let systemInstruction =
      "Responde de forma clara, directa y concisa a la consulta del usuario basándote en la captura de la pantalla enviada.";
    if (mode === "fast_answer") {
      systemInstruction =
        "Analiza la captura y responde la pregunta o ejercicio de forma ultra concisa, rápida y exacta. En opción múltiple, indica primero la opción correcta y una justificación breve.";
    } else if (mode === "explain") {
      systemInstruction =
        "Analiza la captura y explica el concepto o gráfica de manera concisa en 2 o 3 viñetas.";
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } },
          {
            text: `${systemInstruction}\n\nConsulta específica: ${
              prompt || "Analiza el contenido visible y responde la pregunta o ejercicio mostrado."
            }`,
          },
        ],
      },
    });
    return sendJson(res, 200, {
      answer: response.text?.trim() || "No se detectó una pregunta clara en la imagen.",
    });
  } catch (error) {
    console.error("[VERCEL /api/fast-vision-query ERROR]", error);
    return sendJson(res, 200, {
      answer: "No se pudo analizar la imagen de pantalla en este momento.",
    });
  }
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const path = String(req.url || "").split("?")[0];

  if (req.method === "GET" && path === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      geminiConfigured: Boolean(getGeminiApiKey()),
    });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(req);
  } catch (error: any) {
    return sendJson(res, error?.statusCode === 413 ? 413 : 400, {
      error: "Payload size too large or malformed body",
      code: "INVALID_REQUEST_BODY",
    });
  }

  switch (path) {
    case "/api/transcribe-chunk":
      return transcribeChunk(body, res);
    case "/api/summarize-transcript":
      return summarizeTranscript(body, res);
    case "/api/translate-transcript":
      return translateTranscript(body, res);
    case "/api/chat-transcript":
      return chatTranscript(body, res);
    case "/api/fast-vision-query":
      return fastVisionQuery(body, res);
    default:
      return sendJson(res, 404, { error: "API route not found." });
  }
}
