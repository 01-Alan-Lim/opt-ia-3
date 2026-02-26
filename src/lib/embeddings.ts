// src/lib/embeddings.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;

/**
 * gemini-embedding-001: 3072 por defecto, pero se puede truncar (ej. 768).
 * Mantén este número igual a la dimensión de tu columna/vector en Supabase.
 */
const TARGET_DIM = Number(process.env.GEMINI_EMBED_DIM ?? "768");

const modelName = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

if (!apiKey) {
  console.warn("⚠️ GEMINI_API_KEY no está definida en las variables de entorno.");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function embedText(text: string): Promise<number[]> {
  if (!genAI) throw new Error("Gemini no está configurado (falta GEMINI_API_KEY).");

  const input = (text ?? "").trim().slice(0, 4000);
  if (!input) return [];

  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.embedContent(input);

  const values = result.embedding?.values;
  if (!values || values.length === 0) {
    throw new Error(`No se recibió embedding desde Gemini usando modelo: ${modelName}`);
  }

  // ✅ Normaliza dimensión para que coincida con pgvector en Supabase
  if (values.length === TARGET_DIM) return values;
  if (values.length > TARGET_DIM) return values.slice(0, TARGET_DIM);

  // Si llega más pequeño, no hay forma segura de “rellenar”
  throw new Error(
    `Embedding dimension inesperada: got ${values.length}, expected ${TARGET_DIM}. ` +
      `Revisa GEMINI_EMBED_DIM / modelo o tu schema pgvector.`
  );
}
