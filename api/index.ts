export default async function handler(req: any, res: any) {
  const requestPath = String(req.url || "").split("?")[0];

  if (req.method === "GET" && requestPath === "/api/health") {
    const apiKey =
      process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      status: "ok",
      geminiConfigured: Boolean(apiKey),
    }));
  }

  try {
    const { default: app } = await import("../app");
    return app(req, res);
  } catch (error) {
    console.error("[VERCEL API STARTUP ERROR]", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      error: "La función de API no pudo iniciar.",
      code: "API_APP_LOAD_FAILED",
    }));
  }
}
