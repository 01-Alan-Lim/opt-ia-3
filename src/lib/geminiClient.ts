//src/lib/geminiClient.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
const modelNameFromEnv = process.env.GEMINI_MODEL;

if (!apiKey) {
  console.warn("⚠️ GEMINI_API_KEY no está definida en las variables de entorno.");
}

if (!modelNameFromEnv) {
  console.warn(
    "⚠️ GEMINI_MODEL no está definida. Usaré gemini-1.5-flash por defecto."
  );
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Si no viene de la env, usamos un modelo por defecto
const MODEL_NAME = modelNameFromEnv || "gemini-1.5-flash";

export function getGeminiModel() {
  if (!genAI) {
    throw new Error("Gemini no está configurado (falta GEMINI_API_KEY).");
  }
  return genAI.getGenerativeModel({ model: MODEL_NAME });
}
