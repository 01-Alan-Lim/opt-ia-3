// src/lib/embeddingEngine.ts
//
// Motor de embeddings de la Biblioteca Académica. Todavía no lo usa ninguna ruta: el RAG actual
// sigue con embedText (embeddings.ts) hasta que las guías se reindexen con este motor.
// - Consulta (RETRIEVAL_QUERY) y documento (RETRIEVAL_DOCUMENT) van por funciones separadas.
// - Las dimensiones se piden a la API (outputDimensionality) y la respuesta tiene que traer
//   exactamente esas: un vector de otro tamaño (p. ej. los 3072 nativos de gemini-embedding-001,
//   si la API ignorara el pedido) se rechaza. Recortarlo daría otra representación con la misma
//   etiqueta.
// - Todo vector se valida (tamaño, valores finitos, norma) y se normaliza a norma 1: la API solo
//   normaliza el de 3072, y un vector sin normalizar cambia el orden por distancia.
// - embeddingModelId ("gemini-embedding-001:768") etiqueta lo que genera el motor: un vector
//   guardado y una consulta solo se comparan si la etiqueta coincide.

import {
  TaskType,
  type BatchEmbedContentsRequest,
  type BatchEmbedContentsResponse,
  type EmbedContentRequest,
  type EmbedContentResponse,
} from "@google/generative-ai";

// document_chunks.embedding es vector(768): el motor solo produce vectores de ese tamaño.
export const STORED_EMBEDDING_DIM = 768;
// Tamaño nativo de gemini-embedding-001.
export const GEMINI_EMBEDDING_NATIVE_DIM = 3072;
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
// Mismo tope de caracteres que embedText. Una consulta más larga se recorta; un fragmento de
// documento no: lo tiene que respetar quien trocea, para no perder texto sin aviso.
export const MAX_EMBED_INPUT_CHARS = 4000;
// Tope de peticiones por llamada a batchEmbedContents.
export const MAX_EMBED_BATCH = 100;

const UNIT_NORM_TOLERANCE = 1e-6;
const MIN_RAW_NORM = 1e-6;

export type EmbeddingErrorCode =
  | "CONFIG"
  | "EMPTY_INPUT"
  | "INPUT_TOO_LONG"
  | "DIMENSION_MISMATCH"
  | "INVALID_VECTOR"
  | "ZERO_VECTOR"
  | "BATCH_MISMATCH"
  | "UPSTREAM";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
    this.code = code;
  }
}

// Un fallo de Gemini que conviene reintentar más tarde: límite de solicitudes (429), error del
// servicio (500, 503) o sin respuesta (red). Un 400 o 403 (pedido inválido, clave) no se reintenta.
export function isRetryableEmbeddingError(err: unknown): boolean {
  if (!(err instanceof EmbeddingError) || err.code !== "UPSTREAM") return false;
  const status = (err.cause as { status?: unknown } | null | undefined)?.status;
  return status === undefined || status === 429 || status === 500 || status === 503;
}

export type EmbeddingConfig = { model: string; dimension: number };

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: DEFAULT_EMBEDDING_MODEL,
  dimension: STORED_EMBEDDING_DIM,
};

export function embeddingModelId(config: EmbeddingConfig): string {
  return `${config.model}:${config.dimension}`;
}

// GEMINI_EMBED_MODEL y GEMINI_EMBED_DIM con los mismos valores por defecto que embedText. Un tamaño
// distinto de la columna es un error de configuración, no un vector que la base rechace después.
export function readEmbeddingConfig(env: Record<string, string | undefined>): EmbeddingConfig {
  const model = env.GEMINI_EMBED_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const dimension = Number(env.GEMINI_EMBED_DIM?.trim() || STORED_EMBEDDING_DIM);
  if (dimension !== STORED_EMBEDDING_DIM) {
    throw new EmbeddingError(
      "CONFIG",
      `GEMINI_EMBED_DIM no coincide con vector(${STORED_EMBEDDING_DIM}) de document_chunks.`
    );
  }
  return { model, dimension };
}

export function vectorNorm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

export function isStoredEmbedding(values: readonly number[], dimension = STORED_EMBEDDING_DIM): boolean {
  return (
    values.length === dimension &&
    values.every((value) => Number.isFinite(value)) &&
    Math.abs(vectorNorm(values) - 1) <= UNIT_NORM_TOLERANCE
  );
}

// Deja un vector de la API listo para guardar o consultar: `dimension` valores finitos con norma 1.
// Solo acepta el tamaño pedido; cualquier otro (incluido el nativo de 3072) es un error.
export function toStoredEmbedding(values: unknown, dimension: number): number[] {
  if (!Array.isArray(values)) {
    throw new EmbeddingError("INVALID_VECTOR", "La respuesta no trae un vector.");
  }
  if (values.length !== dimension) {
    throw new EmbeddingError(
      "DIMENSION_MISMATCH",
      `Se esperaban ${dimension} dimensiones y llegaron ${values.length}.`
    );
  }

  const vector: number[] = [];
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingError("INVALID_VECTOR", "El vector tiene valores no numéricos o no finitos.");
    }
    vector.push(value);
  }

  const norm = vectorNorm(vector);
  if (norm < MIN_RAW_NORM) {
    throw new EmbeddingError("ZERO_VECTOR", "El vector tiene norma cero.");
  }

  const unit = vector.map((value) => value / norm);
  if (!isStoredEmbedding(unit, dimension)) {
    throw new EmbeddingError("INVALID_VECTOR", "No se pudo normalizar el vector.");
  }
  return unit;
}

// Lo que el motor necesita del modelo de Gemini (GenerativeModel lo cumple). Las pruebas pasan uno
// simulado.
export type EmbeddingModelPort = {
  embedContent(request: EmbedContentRequest): Promise<EmbedContentResponse>;
  batchEmbedContents(request: BatchEmbedContentsRequest): Promise<BatchEmbedContentsResponse>;
};

export type EmbeddingEngine = {
  readonly modelId: string;
  readonly dimension: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
};

// La API REST acepta outputDimensionality en embedContent y batchEmbedContents. Los tipos del SDK
// 0.24.1 no lo declaran, pero el SDK envía la petición tal cual (JSON.stringify), así que llega.
type EmbedRequest = EmbedContentRequest & { outputDimensionality: number };

function buildRequest(text: string, taskType: TaskType, dimension: number): EmbedRequest {
  return { content: { role: "user", parts: [{ text }] }, taskType, outputDimensionality: dimension };
}

function queryInput(text: string): string {
  const input = (typeof text === "string" ? text.trim() : "").slice(0, MAX_EMBED_INPUT_CHARS);
  if (!input) throw new EmbeddingError("EMPTY_INPUT", "La consulta está vacía.");
  return input;
}

function documentInput(text: string): string {
  const input = typeof text === "string" ? text.trim() : "";
  if (!input) throw new EmbeddingError("EMPTY_INPUT", "El fragmento está vacío.");
  if (input.length > MAX_EMBED_INPUT_CHARS) {
    throw new EmbeddingError(
      "INPUT_TOO_LONG",
      `El fragmento tiene ${input.length} caracteres; el máximo es ${MAX_EMBED_INPUT_CHARS}.`
    );
  }
  return input;
}

export function createEmbeddingEngine(model: EmbeddingModelPort, config: EmbeddingConfig): EmbeddingEngine {
  if (!config.model.trim() || config.dimension !== STORED_EMBEDDING_DIM) {
    throw new EmbeddingError(
      "CONFIG",
      `El motor necesita un modelo y ${STORED_EMBEDDING_DIM} dimensiones (vector de document_chunks).`
    );
  }
  const { dimension } = config;

  async function embedOne(text: string, taskType: TaskType): Promise<number[]> {
    let response: EmbedContentResponse;
    try {
      response = await model.embedContent(buildRequest(text, taskType, dimension));
    } catch (err: unknown) {
      throw new EmbeddingError("UPSTREAM", "Gemini no devolvió el embedding.", { cause: err });
    }
    return toStoredEmbedding(response?.embedding?.values, dimension);
  }

  return {
    modelId: embeddingModelId(config),
    dimension,

    async embedQuery(text) {
      return embedOne(queryInput(text), TaskType.RETRIEVAL_QUERY);
    },

    async embedDocument(text) {
      return embedOne(documentInput(text), TaskType.RETRIEVAL_DOCUMENT);
    },

    // Se validan todos los fragmentos antes de la primera llamada: uno inválido no deja la mitad
    // del documento con embeddings. El resultado conserva el orden de `texts`.
    async embedDocuments(texts) {
      const inputs = texts.map((text) => documentInput(text));
      const vectors: number[][] = [];

      for (let start = 0; start < inputs.length; start += MAX_EMBED_BATCH) {
        const batch = inputs.slice(start, start + MAX_EMBED_BATCH);
        let response: BatchEmbedContentsResponse;
        try {
          response = await model.batchEmbedContents({
            requests: batch.map((text) => buildRequest(text, TaskType.RETRIEVAL_DOCUMENT, dimension)),
          });
        } catch (err: unknown) {
          throw new EmbeddingError("UPSTREAM", "Gemini no devolvió los embeddings.", { cause: err });
        }

        const embeddings = response?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
          throw new EmbeddingError(
            "BATCH_MISMATCH",
            `Se pidieron ${batch.length} embeddings y llegaron ${Array.isArray(embeddings) ? embeddings.length : 0}.`
          );
        }
        for (const embedding of embeddings) vectors.push(toStoredEmbedding(embedding?.values, dimension));
      }

      return vectors;
    },
  };
}
