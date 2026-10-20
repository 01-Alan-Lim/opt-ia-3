// src/lib/teacher/library/catalog.ts
//
// Biblioteca Académica del panel docente (por ahora solo lectura): las filas que lee
// /api/teacher/library, el resumen de cada documento y las funciones puras de la vista (filtros,
// etiquetas y lectura defensiva de la respuesta). Sin React ni fetch.
//
// Un documento de la biblioteca es global (user_id NULL). Sus fragmentos se cuentan por etiqueta
// de modelo (M4): los del motor actual son los que usará el RAG nuevo; los legacy-768 hay que
// reindexarlos.

import { z } from "zod";

export const LEGACY_EMBEDDING_MODEL = "legacy-768";

// Un documento que lleva más que esto en processing quedó interrumpido.
export const STALLED_PROCESSING_MS = 15 * 60 * 1000;

// Carpeta de Storage (bucket documents) de lo que sube la Biblioteca. Solo esos documentos se
// procesan desde el panel; las guías antiguas (mypes/) esperan la reindexación.
export const LIBRARY_STORAGE_PREFIX = "library/";

// Tope de un archivo subido. Vercel corta el cuerpo de una petición en 4,5 MB, con el multipart
// incluido: 4 MB deja margen.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const LIBRARY_UPLOAD_EXTENSIONS = ["pdf", "docx"] as const;
export type LibraryUploadExtension = (typeof LIBRARY_UPLOAD_EXTENSIONS)[number];

export const LIBRARY_UPLOAD_ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function uploadExtensionOf(fileName: string): LibraryUploadExtension | null {
  const ext = fileName.trim().toLowerCase().split(".").pop() ?? "";
  return (LIBRARY_UPLOAD_EXTENSIONS as readonly string[]).includes(ext) ? (ext as LibraryUploadExtension) : null;
}

// Revisión previa en el navegador (solo para avisar antes de subir; el servidor valida todo).
export function uploadCandidateProblem(file: { name: string; size: number }): string | null {
  if (!uploadExtensionOf(file.name)) return "Solo se aceptan archivos PDF o DOCX.";
  if (file.size === 0) return "El archivo está vacío.";
  if (file.size > MAX_UPLOAD_BYTES) return "El archivo supera los 4 MB.";
  return null;
}

export const LIBRARY_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export const LIBRARY_FILE_TYPES = ["pdf", "docx", "txt"] as const;
export type LibraryFileType = (typeof LIBRARY_FILE_TYPES)[number];

export const LIBRARY_STATUS_LABEL: Record<LibraryStatus, string> = {
  pending: "Pendiente de indexar",
  processing: "Procesando",
  ready: "Listo",
  failed: "Con error",
};

export const LIBRARY_FILE_TYPE_LABEL: Record<LibraryFileType, string> = {
  pdf: "PDF",
  docx: "DOCX",
  txt: "TXT",
};

// Columnas de documents que lee la API. path solo se usa en el servidor: no sale en la respuesta.
export const LibraryDocumentRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  file_type: z.enum(LIBRARY_FILE_TYPES),
  status: z.enum(LIBRARY_STATUSES),
  is_active: z.boolean(),
  processing_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LibraryDocumentRow = z.infer<typeof LibraryDocumentRowSchema>;

// De cada fragmento solo interesa a qué documento pertenece y con qué modelo se generó.
export const LibraryChunkTagRowSchema = z.object({
  document_id: z.string(),
  embedding_model: z.string(),
});
export type LibraryChunkTagRow = z.infer<typeof LibraryChunkTagRowSchema>;

const ChunkCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  current: z.number().int().nonnegative(),
  legacy: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});
export type LibraryChunkCounts = z.infer<typeof ChunkCountsSchema>;

export const LibraryDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  fileType: z.enum(LIBRARY_FILE_TYPES),
  status: z.enum(LIBRARY_STATUSES),
  isActive: z.boolean(),
  processingError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  chunks: ChunkCountsSchema,
  stalled: z.boolean(),
  // Subido por la Biblioteca y sin terminar (processing o failed): se puede continuar o reintentar.
  canProcess: z.boolean(),
});
export type LibraryDocument = z.infer<typeof LibraryDocumentSchema>;

const LibraryResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    documents: z.array(LibraryDocumentSchema),
    currentEmbeddingModel: z.string().nullable(),
  }),
});
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>["data"];

// POST /api/teacher/library: el documento creado (processing, inactivo) y cuántos fragmentos tendrá.
const UploadResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ document: LibraryDocumentSchema, totalChunks: z.number().int().positive() }),
});
export type LibraryUploadResponse = z.infer<typeof UploadResponseSchema>["data"];

// POST /api/teacher/library/:id/process: un paso del procesamiento. done = listo y completo;
// retryAfterMs = Gemini pidió esperar (el documento sigue en processing).
const ProcessResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    document: LibraryDocumentSchema,
    processedChunks: z.number().int().nonnegative(),
    totalChunks: z.number().int().nonnegative(),
    done: z.boolean(),
    retryAfterMs: z.number().int().positive().nullable(),
  }),
});
export type LibraryProcessResponse = z.infer<typeof ProcessResponseSchema>["data"];

export function isStalledProcessing(status: LibraryStatus, updatedAt: string, now: Date): boolean {
  if (status !== "processing") return false;
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && now.getTime() - at > STALLED_PROCESSING_MS;
}

// Une cada documento con sus fragmentos contados por etiqueta. Sin modelo actual (configuración
// inválida), ningún fragmento cuenta como actual. El error de procesamiento solo se muestra con
// status failed.
export function summarizeLibraryDocuments(
  rows: readonly LibraryDocumentRow[],
  chunkTags: readonly LibraryChunkTagRow[],
  options: { currentModel: string | null; now: Date }
): LibraryDocument[] {
  const counts = new Map<string, LibraryChunkCounts>();
  for (const tag of chunkTags) {
    const entry = counts.get(tag.document_id) ?? { total: 0, current: 0, legacy: 0, other: 0 };
    entry.total += 1;
    if (options.currentModel !== null && tag.embedding_model === options.currentModel) entry.current += 1;
    else if (tag.embedding_model === LEGACY_EMBEDDING_MODEL) entry.legacy += 1;
    else entry.other += 1;
    counts.set(tag.document_id, entry);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    fileType: row.file_type,
    status: row.status,
    isActive: row.is_active,
    processingError: row.status === "failed" ? row.processing_error : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chunks: counts.get(row.id) ?? { total: 0, current: 0, legacy: 0, other: 0 },
    stalled: isStalledProcessing(row.status, row.updated_at, options.now),
    canProcess: (row.status === "processing" || row.status === "failed") && row.path.startsWith(LIBRARY_STORAGE_PREFIX),
  }));
}

// Tiene fragmentos, pero ninguno con el modelo actual: el RAG nuevo no lo usará hasta reindexarlo.
export function needsReindex(doc: LibraryDocument): boolean {
  return doc.chunks.total > 0 && doc.chunks.current === 0;
}

export function describeChunks(doc: LibraryDocument): string {
  const { total, current, legacy, other } = doc.chunks;
  if (total === 0) return "Sin fragmentos";
  const parts: string[] = [];
  if (current) parts.push(`${current} con el modelo actual`);
  if (legacy) parts.push(`${legacy} con el modelo anterior`);
  if (other) parts.push(`${other} con otro modelo`);
  return parts.join(" · ");
}

export type LibraryStatusFilter = "all" | LibraryStatus;
export type LibraryAvailabilityFilter = "all" | "active" | "inactive";
export type LibraryFilters = {
  query: string;
  status: LibraryStatusFilter;
  availability: LibraryAvailabilityFilter;
};

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = { query: "", status: "all", availability: "all" };

export function isDefaultLibraryFilters(filters: LibraryFilters): boolean {
  return !filters.query.trim() && filters.status === "all" && filters.availability === "all";
}

// Sin mayúsculas ni tildes; los guiones bajos de los nombres de archivo cuentan como espacios.
function searchable(text: string): string {
  return text
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/_+/g, " ");
}

// Cada palabra buscada tiene que estar en el título: "balanceo linea" encuentra
// GUIA_14.1_BALANCEO_DE_LINEA.pdf.
export function filterLibraryDocuments(docs: readonly LibraryDocument[], filters: LibraryFilters): LibraryDocument[] {
  const terms = searchable(filters.query).split(/\s+/).filter(Boolean);
  return docs.filter((doc) => {
    if (filters.status !== "all" && doc.status !== filters.status) return false;
    if (filters.availability === "active" && !doc.isActive) return false;
    if (filters.availability === "inactive" && doc.isActive) return false;
    if (terms.length === 0) return true;
    const title = searchable(doc.title);
    return terms.every((term) => title.includes(term));
  });
}

export function countByStatus(docs: readonly LibraryDocument[]): Record<LibraryStatus, number> {
  const counts: Record<LibraryStatus, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
  for (const doc of docs) counts[doc.status] += 1;
  return counts;
}

// GET /api/teacher/library -> { ok: true, data: { documents, currentEmbeddingModel } }. Cualquier
// otra forma es un error para la vista.
export function readLibraryResponse(response: unknown): LibraryResponse | null {
  const parsed = LibraryResponseSchema.safeParse(response);
  return parsed.success ? parsed.data.data : null;
}

export function readUploadResponse(response: unknown): LibraryUploadResponse | null {
  const parsed = UploadResponseSchema.safeParse(response);
  return parsed.success ? parsed.data.data : null;
}

export function readProcessResponse(response: unknown): LibraryProcessResponse | null {
  const parsed = ProcessResponseSchema.safeParse(response);
  return parsed.success ? parsed.data.data : null;
}

// Mensaje de error de la API ({ ok: false, code, message }), si lo trae.
export function readLibraryErrorMessage(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const message = (response as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}
