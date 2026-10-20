// src/lib/chat/academicRag.ts
//
// Recuperación de la Biblioteca Académica para el Asistente General (/api/chat). Solo usa
// documentos activos, listos y con vectores del motor actual (match_academic_chunks, M6): nunca
// los legacy-768 ni el demo inactivo. Si la búsqueda falla no hay respaldo: la RPC antigua
// (match_document_chunks, sin esos filtros) no se usa. Sin material compatible el asistente
// responde con su conocimiento general.
// El usuario lo pasa la ruta, resuelto en el servidor con Supabase Auth; la RPC solo admite los
// documentos globales y los de ese usuario. La pregunta se embebe con embedQuery
// (RETRIEVAL_QUERY, 768 dimensiones normalizadas) y solo si hay material que buscar.

import { z } from "zod";

import type { EmbeddingEngine } from "@/lib/embeddingEngine";
import { getEmbeddingEngine } from "@/lib/embeddings";
import { supabaseServer } from "@/lib/supabaseServer";

export const DEFAULT_MATCH_COUNT = 5;
export const MAX_MATCH_COUNT = 10;
// Similitud coseno mínima de un fragmento. Valor inicial: se calibra con las guías reindexadas.
export const DEFAULT_MIN_SIMILARITY = 0.5;

export type AcademicRagConfig = { matchCount: number; minSimilarity: number };

// ACADEMIC_RAG_MATCH_COUNT: fragmentos por pregunta (0 apaga la búsqueda; tope MAX_MATCH_COUNT).
// ACADEMIC_RAG_MIN_SIMILARITY: entre 0 y 1. Un valor inválido toma el valor por defecto.
export function readAcademicRagConfig(env: Record<string, string | undefined>): AcademicRagConfig {
  const count = Number(env.ACADEMIC_RAG_MATCH_COUNT?.trim() || DEFAULT_MATCH_COUNT);
  const similarity = Number(env.ACADEMIC_RAG_MIN_SIMILARITY?.trim() || DEFAULT_MIN_SIMILARITY);
  return {
    matchCount: Number.isInteger(count) ? Math.min(Math.max(count, 0), MAX_MATCH_COUNT) : DEFAULT_MATCH_COUNT,
    minSimilarity: Number.isFinite(similarity) ? Math.min(Math.max(similarity, 0), 1) : DEFAULT_MIN_SIMILARITY,
  };
}

export type AcademicRagOutcome =
  | { status: "used"; chunks: string[] }
  // Hay material compatible, pero nada parecido a la pregunta.
  | { status: "no_match" }
  // No hay ningún documento activo y listo con el modelo actual: ni se llama a Gemini.
  | { status: "no_library" }
  | { status: "disabled" }
  | { status: "error"; stage: "config" | "availability" | "embedding" | "search" };

const MatchRowsSchema = z.array(z.object({ content: z.string(), similarity: z.number() }));

export async function retrieveAcademicContext(input: {
  userId: string;
  question: string;
  config?: AcademicRagConfig;
}): Promise<AcademicRagOutcome> {
  const config = input.config ?? readAcademicRagConfig(process.env);
  if (config.matchCount === 0 || !input.question.trim()) return { status: "disabled" };

  let engine: EmbeddingEngine;
  try {
    engine = getEmbeddingEngine();
  } catch {
    return { status: "error", stage: "config" };
  }

  // Antes de gastar un embedding: ¿hay algo que buscar para este usuario?
  const available = await supabaseServer.rpc("academic_library_available", {
    p_embedding_model: engine.modelId,
    p_user_id: input.userId,
  });
  if (available.error) return { status: "error", stage: "availability" };
  if (available.data !== true) return { status: "no_library" };

  let embedding: number[];
  try {
    embedding = await engine.embedQuery(input.question);
  } catch {
    return { status: "error", stage: "embedding" };
  }

  const matches = await supabaseServer.rpc("match_academic_chunks", {
    query_embedding: embedding,
    match_count: config.matchCount,
    p_embedding_model: engine.modelId,
    p_user_id: input.userId,
    p_min_similarity: config.minSimilarity,
  });
  if (matches.error) return { status: "error", stage: "search" };
  const rows = MatchRowsSchema.safeParse(matches.data ?? []);
  if (!rows.success) return { status: "error", stage: "search" };

  const chunks = rows.data.map((row) => row.content.trim()).filter(Boolean);
  return chunks.length > 0 ? { status: "used", chunks } : { status: "no_match" };
}

// Material recuperado, numerado, para el prompt. Es solo para el modelo: el estudiante no ve
// fuentes ni títulos (la RPC tampoco los devuelve).
export function academicPromptSection(chunks: readonly string[]): string {
  return chunks.map((chunk, index) => `(${index + 1}) ${chunk}`).join("\n");
}
