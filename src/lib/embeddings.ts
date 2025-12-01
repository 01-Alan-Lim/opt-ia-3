// src/lib/embeddings.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
const embedModelName =
  process.env.GEMINI_EMBED_MODEL || "text-embedding-004";

if (!apiKey) {
  console.warn("⚠️ GEMINI_API_KEY no está definida en las variables de entorno.");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function embedText(text: string): Promise<number[]> {
  if (!genAI) {
    throw new Error("Gemini no está configurado (falta GEMINI_API_KEY).");
  }

  const model = genAI.getGenerativeModel({ model: embedModelName });

  const result = await model.embedContent(text);
  const embedding = result.embedding?.values;

  if (!embedding) {
    throw new Error("No se recibió embedding desde Gemini.");
  }

  return embedding;
}
