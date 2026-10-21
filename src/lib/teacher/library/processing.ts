// src/lib/teacher/library/processing.ts
//
// Biblioteca Académica, lado servidor: subir un PDF digital o un DOCX, reindexar una guía que ya
// está en Storage y procesarlos por pasos.
//   - createLibraryDocument: valida el archivo (firma, estructura, texto y límites), detecta un
//     duplicado por SHA-256, lo guarda en Storage (documents/library/<id>.<ext>) y crea la fila
//     de documents en processing e inactiva.
//   - startLibraryReindex: reclama un documento pending con su archivo en Storage (las guías de
//     mypes/), sin volver a subirlo: valida el archivo igual que una subida, guarda su hash y lo
//     pasa a processing e inactivo. No cambia el id, el título ni la ruta, y no toca sus
//     fragmentos legacy-768.
//   - processLibraryDocumentStep: un paso acotado. Vuelve a leer el archivo de Storage (y verifica
//     su hash), regenera los mismos fragmentos, pide los embeddings de un lote de los que faltan
//     (RETRIEVAL_DOCUMENT, 768 dimensiones reales, normalizadas) y los guarda con la etiqueta del
//     motor. Marca ready solo cuando están todos y coinciden con el archivo, y lo deja inactivo.
//   - setLibraryDocumentActive: activa (solo un documento listo con los fragmentos del modelo
//     actual completos) o desactiva. El RAG usa solo lo activo y listo.
// Cada paso entra con holgura en el tiempo de una función de Vercel: el panel los encadena y
// muestra el progreso. Un fallo deja failed con el motivo; los fragmentos ya guardados se
// conservan y un reintento sigue desde ahí (el índice único de M4 impide duplicarlos). Un
// documento processing o failed no es "listo": el RAG nuevo filtra por status = 'ready'.
// Todo con service role: las rutas ya comprobaron el rol docente.

import { z } from "zod";

import type { ApiErrorCode } from "@/lib/api/response";
import {
  EmbeddingError,
  embeddingModelId,
  isRetryableEmbeddingError,
  readEmbeddingConfig,
  type EmbeddingEngine,
} from "@/lib/embeddingEngine";
import { getEmbeddingEngine } from "@/lib/embeddings";
import { extractPdfContent } from "@/lib/pdfText";
import { supabaseServer } from "@/lib/supabaseServer";
import {
  activationProblem,
  LIBRARY_STORAGE_PREFIX,
  LibraryChunkTagRowSchema,
  LibraryDocumentRowSchema,
  librarySourceExtension,
  summarizeLibraryDocuments,
  uploadExtensionOf,
  type LibraryDocument,
  type LibraryExtractionReport,
  type LibraryUploadExtension,
} from "./catalog";
import {
  checkDocxStructure,
  checkSignature,
  extractionWarnings,
  LibraryFileError,
  MAX_PDF_PAGES,
  prepareLibraryText,
  sha256Hex,
  titleFromFileName,
} from "./ingest";

export const LIBRARY_BUCKET = "documents";
// Fragmentos por paso: un solo lote de embeddings (batchEmbedContents admite 100) y unas decenas
// de miles de tokens, lejos del límite por minuto de Gemini.
export const PROCESS_BATCH = 50;
// Espera sugerida al panel cuando Gemini limita las solicitudes (429) o falla el servicio.
const RATE_LIMIT_RETRY_MS = 20_000;
const SERVICE_RETRY_MS = 5_000;

export const LIBRARY_DOCUMENT_COLUMNS =
  "id, title, path, file_type, status, is_active, processing_error, created_at, updated_at";

const CONTENT_TYPE: Record<LibraryUploadExtension, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const ProcessRowSchema = LibraryDocumentRowSchema.extend({ content_hash: z.string().nullable() });

// Máximo de filas por respuesta que PostgREST aplica por defecto en Supabase.
const PAGE_SIZE = 1000;

// Error de lectura o escritura de Supabase o Storage: se registra en el servidor y el cliente
// recibe un código sin detalles.
export class LibraryStoreError extends Error {
  readonly source: string;
  readonly detail: unknown;

  constructor(source: string, detail: unknown) {
    super(`LIBRARY_STORE:${source}`);
    this.name = "LibraryStoreError";
    this.source = source;
    this.detail = detail;
  }
}

// Una columna que falta (42703) es una base sin M4: la biblioteca no está lista, no es un fallo.
export function isSchemaNotReady(err: unknown): boolean {
  if (!(err instanceof LibraryStoreError)) return false;
  return typeof err.detail === "object" && err.detail !== null && (err.detail as { code?: unknown }).code === "42703";
}

export type LibraryFailure = { ok: false; code: ApiErrorCode; status: number; message: string };

function failure(code: ApiErrorCode, status: number, message: string): LibraryFailure {
  return { ok: false, code, status, message };
}

type PageResult = { data: unknown[] | null; error: unknown };

export async function fetchAllLibraryRows<T>(
  source: string,
  schema: z.ZodType<T>,
  page: (from: number, to: number) => PromiseLike<PageResult>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new LibraryStoreError(source, error);
    const parsed = z.array(schema).safeParse(data ?? []);
    if (!parsed.success) throw new LibraryStoreError(source, parsed.error.issues);
    rows.push(...parsed.data);
    if (parsed.data.length < PAGE_SIZE) return rows;
  }
}

function parseRow<T>(source: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new LibraryStoreError(source, parsed.error.issues);
  return parsed.data;
}

// Etiqueta de los vectores del motor actual, o null con una configuración inválida.
export function libraryEmbeddingModel(): string | null {
  try {
    return embeddingModelId(readEmbeddingConfig(process.env));
  } catch {
    return null;
  }
}

// Texto del archivo, sin OCR, sus páginas y las letras de cada una (null en un DOCX). PDF con
// pdf-parse (hasta MAX_PDF_PAGES) y DOCX con mammoth, después de revisar su estructura de zip.
async function extractLibraryContent(
  extension: LibraryUploadExtension,
  bytes: Uint8Array
): Promise<{ text: string; pages: number | null; pageLetters: number[] | null }> {
  if (extension === "pdf") {
    let content: { text: string; pages: number; pageLetters: number[] };
    try {
      content = await extractPdfContent(bytes, { maxPages: MAX_PDF_PAGES });
    } catch {
      throw new LibraryFileError("INVALID_FILE", "No se pudo leer el PDF: puede estar dañado o protegido con contraseña.");
    }
    if (content.pages > MAX_PDF_PAGES) {
      throw new LibraryFileError("DOCUMENT_TOO_LONG", `El PDF tiene ${content.pages} páginas; el máximo es ${MAX_PDF_PAGES}.`);
    }
    return content;
  }

  checkDocxStructure(bytes);
  try {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: value ?? "", pages: null, pageLetters: null };
  } catch {
    throw new LibraryFileError("INVALID_FILE", "No se pudo leer el DOCX: puede estar dañado.");
  }
}

export async function extractLibraryText(extension: LibraryUploadExtension, bytes: Uint8Array): Promise<string> {
  return (await extractLibraryContent(extension, bytes)).text;
}

type LibraryFileContent = { chunks: string[]; extraction: LibraryExtractionReport };

// Los fragmentos de un archivo, los mismos en la subida, en la reindexación y en cada paso del
// procesamiento, con lo que se extrajo.
async function readLibraryFile(extension: LibraryUploadExtension, bytes: Uint8Array): Promise<LibraryFileContent> {
  checkSignature(bytes, extension);
  const { text, pages, pageLetters } = await extractLibraryContent(extension, bytes);
  const prepared = prepareLibraryText(text);
  return {
    chunks: prepared.chunks,
    extraction: { pages, characters: prepared.text.length, warnings: extractionWarnings(pageLetters) },
  };
}

async function chunkTagsOf(documentId: string) {
  return fetchAllLibraryRows("document_chunks", LibraryChunkTagRowSchema, (from, to) =>
    supabaseServer
      .from("document_chunks")
      .select("document_id, embedding_model, chunk_index")
      .eq("document_id", documentId)
      .order("id", { ascending: true })
      .range(from, to)
  );
}

// Índices de fragmento ya guardados para el documento con el modelo actual.
async function storedIndices(documentId: string, model: string): Promise<Set<number>> {
  const rows = await fetchAllLibraryRows("document_chunks", z.object({ chunk_index: z.number().int() }), (from, to) =>
    supabaseServer
      .from("document_chunks")
      .select("chunk_index")
      .eq("document_id", documentId)
      .eq("embedding_model", model)
      .order("chunk_index", { ascending: true })
      .range(from, to)
  );
  return new Set(rows.map((row) => row.chunk_index));
}

async function loadLibraryDocument(documentId: string, model: string | null, now: Date): Promise<LibraryDocument | null> {
  const { data, error } = await supabaseServer
    .from("documents")
    .select(LIBRARY_DOCUMENT_COLUMNS)
    .eq("id", documentId)
    .is("user_id", null)
    .maybeSingle();
  if (error) throw new LibraryStoreError("documents", error);
  if (!data) return null;
  const row = parseRow("documents", LibraryDocumentRowSchema, data);
  return summarizeLibraryDocuments([row], await chunkTagsOf(documentId), { currentModel: model, now })[0];
}

// Un documento fallido nunca queda activo.
async function markFailed(documentId: string, reason: string): Promise<void> {
  const { error } = await supabaseServer
    .from("documents")
    .update({ status: "failed", processing_error: reason.slice(0, 300), is_active: false })
    .eq("id", documentId);
  if (error) throw new LibraryStoreError("documents", error);
}

async function removeStoredFile(path: string): Promise<void> {
  const { error } = await supabaseServer.storage.from(LIBRARY_BUCKET).remove([path]);
  if (error) console.error("[teacher] library: no se pudo borrar el archivo huérfano", path);
}

export type LibraryUploadResult = { ok: true; document: LibraryDocument; totalChunks: number } | LibraryFailure;

// Subida de un archivo ya autorizado por la ruta. Si algo falla antes de crear la fila, no queda
// nada guardado: el archivo en Storage se borra si la fila no se pudo crear.
export async function createLibraryDocument(input: {
  fileName: string;
  bytes: Uint8Array;
  title?: string;
  now: Date;
}): Promise<LibraryUploadResult> {
  const extension = uploadExtensionOf(input.fileName);
  if (!extension) return failure("INVALID_FILE", 400, "Solo se aceptan archivos PDF o DOCX.");

  try {
    checkSignature(input.bytes, extension);
  } catch (err: unknown) {
    if (err instanceof LibraryFileError) return failure(err.code, 400, err.message);
    throw err;
  }

  // Antes de extraer: un duplicado no necesita el trabajo de leerlo.
  const contentHash = sha256Hex(input.bytes);
  const { data: duplicate, error: duplicateError } = await supabaseServer
    .from("documents")
    .select("id, title")
    .eq("content_hash", contentHash)
    .is("user_id", null)
    .maybeSingle();
  if (duplicateError) throw new LibraryStoreError("documents", duplicateError);
  if (duplicate) {
    const title = typeof duplicate.title === "string" ? duplicate.title : "otro documento";
    return failure("CONFLICT", 409, `Este archivo ya está en la biblioteca como «${title}».`);
  }

  let chunks: string[];
  try {
    chunks = (await readLibraryFile(extension, input.bytes)).chunks;
  } catch (err: unknown) {
    if (err instanceof LibraryFileError) return failure(err.code, 400, err.message);
    throw err;
  }

  const id = crypto.randomUUID();
  const path = `${LIBRARY_STORAGE_PREFIX}${id}.${extension}`;
  const upload = await supabaseServer.storage
    .from(LIBRARY_BUCKET)
    .upload(path, Buffer.from(input.bytes), { contentType: CONTENT_TYPE[extension], upsert: false });
  if (upload.error) throw new LibraryStoreError("storage.upload", upload.error);

  const { data, error } = await supabaseServer
    .from("documents")
    .insert({
      id,
      title: input.title?.trim() || titleFromFileName(input.fileName),
      path,
      description: null,
      user_id: null,
      file_type: extension,
      status: "processing",
      is_active: false,
      content_hash: contentHash,
    })
    .select(LIBRARY_DOCUMENT_COLUMNS)
    .single();
  if (error || !data) {
    await removeStoredFile(path);
    if (error?.code === "23505") return failure("CONFLICT", 409, "Este archivo ya está en la biblioteca.");
    throw new LibraryStoreError("documents", error);
  }

  const row = parseRow("documents", LibraryDocumentRowSchema, data);
  const [document] = summarizeLibraryDocuments([row], [], { currentModel: libraryEmbeddingModel(), now: input.now });
  return { ok: true, document, totalChunks: chunks.length };
}

export type LibraryStepResult =
  | {
      ok: true;
      document: LibraryDocument;
      processedChunks: number;
      totalChunks: number;
      done: boolean;
      retryAfterMs: number | null;
      extraction: LibraryExtractionReport | null;
    }
  | LibraryFailure;

function upstreamStatus(err: unknown): unknown {
  return err instanceof EmbeddingError ? (err.cause as { status?: unknown } | null | undefined)?.status : undefined;
}

// Motivo que queda en processing_error (hasta 300 caracteres; el panel lo muestra).
function embeddingFailureReason(err: unknown): string {
  if (err instanceof EmbeddingError) {
    if (err.code === "DIMENSION_MISMATCH") {
      return `EMBEDDING_DIMENSION: Gemini devolvió vectores de otra dimensión (${err.message}). No se guardó ese lote.`;
    }
    if (err.code === "INVALID_VECTOR" || err.code === "ZERO_VECTOR" || err.code === "BATCH_MISMATCH") {
      return "EMBEDDING_INVALID: Gemini devolvió vectores inválidos o incompletos. No se guardó ese lote.";
    }
    if (err.code === "UPSTREAM") return "EMBEDDING_FAILED: Gemini rechazó la solicitud de embeddings.";
  }
  return "EMBEDDING_FAILED: no se pudieron generar los embeddings.";
}

// Fragmentos guardados con el modelo actual, con su texto (para la verificación final).
async function storedChunkContents(documentId: string, model: string) {
  return fetchAllLibraryRows("document_chunks", z.object({ chunk_index: z.number().int(), content: z.string() }), (from, to) =>
    supabaseServer
      .from("document_chunks")
      .select("chunk_index, content")
      .eq("document_id", documentId)
      .eq("embedding_model", model)
      .order("chunk_index", { ascending: true })
      .range(from, to)
  );
}

// Antes de marcar ready: lo guardado con el modelo actual son exactamente los fragmentos del
// archivo, índices 0..n-1 (ni uno de más) con el mismo texto. Si no (la fragmentación cambió entre
// pasos, o alguien escribió fuera de la Biblioteca), el documento no queda listo.
async function storedChunksMatch(documentId: string, model: string, chunks: readonly string[]): Promise<boolean> {
  const rows = await storedChunkContents(documentId, model);
  return rows.length === chunks.length && rows.every((row) => chunks[row.chunk_index] === row.content);
}

async function loadProcessRow(documentId: string) {
  const { data, error } = await supabaseServer
    .from("documents")
    .select(`${LIBRARY_DOCUMENT_COLUMNS}, content_hash`)
    .eq("id", documentId)
    .is("user_id", null)
    .maybeSingle();
  if (error) throw new LibraryStoreError("documents", error);
  return data ? parseRow("documents", ProcessRowSchema, data) : null;
}

// Un paso del procesamiento de un documento con su archivo en library/ o mypes/. Uno pending (una
// guía sin reindexar) no: primero se reclama con startLibraryReindex.
export async function processLibraryDocumentStep(documentId: string, now: Date): Promise<LibraryStepResult> {
  let engine: EmbeddingEngine;
  try {
    engine = getEmbeddingEngine();
  } catch {
    return failure("EMBEDDINGS_NOT_CONFIGURED", 503, "El motor de embeddings no está configurado en el servidor.");
  }
  const model = engine.modelId;

  const row = await loadProcessRow(documentId);
  if (!row) return failure("NOT_FOUND", 404, "El documento no existe.");
  const extension = librarySourceExtension(row);
  if (!extension || !row.content_hash || row.status === "pending") {
    return failure(
      "CONFLICT",
      409,
      row.status === "pending" && extension
        ? "Este documento todavía no se reindexó: empieza con «Reindexar»."
        : "Este documento no se procesa desde la biblioteca."
    );
  }

  async function step(
    processed: number,
    total: number,
    done: boolean,
    retryAfterMs: number | null,
    extraction: LibraryExtractionReport | null = null
  ): Promise<LibraryStepResult> {
    const document = await loadLibraryDocument(documentId, model, now);
    if (!document) return failure("NOT_FOUND", 404, "El documento no existe.");
    return { ok: true, document, processedChunks: processed, totalChunks: total, done, retryAfterMs, extraction };
  }

  const before = await storedIndices(documentId, model);
  if (row.status === "ready") return step(before.size, before.size, true, null);

  if (row.status === "failed") {
    const { error: reopenError } = await supabaseServer
      .from("documents")
      .update({ status: "processing", processing_error: null })
      .eq("id", documentId)
      .eq("status", "failed");
    if (reopenError) throw new LibraryStoreError("documents", reopenError);
  }

  // El archivo guardado, verificado contra su hash, da los mismos fragmentos que la subida.
  const file = await supabaseServer.storage.from(LIBRARY_BUCKET).download(row.path);
  if (file.error || !file.data) {
    await markFailed(documentId, "STORAGE: no se encontró el archivo en Storage.");
    return step(before.size, 0, false, null);
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (sha256Hex(bytes) !== row.content_hash) {
    await markFailed(documentId, "FILE_MISMATCH: el archivo guardado no coincide con el que se subió.");
    return step(before.size, 0, false, null);
  }
  let content: LibraryFileContent;
  try {
    content = await readLibraryFile(extension, bytes);
  } catch (err: unknown) {
    if (!(err instanceof LibraryFileError)) throw err;
    await markFailed(documentId, `${err.code}: ${err.message}`);
    return step(before.size, 0, false, null);
  }
  const { chunks, extraction } = content;

  const total = chunks.length;
  const missing = chunks.map((_, index) => index).filter((index) => !before.has(index));
  const batch = missing.slice(0, PROCESS_BATCH);

  if (batch.length > 0) {
    let vectors: number[][];
    try {
      vectors = await engine.embedDocuments(batch.map((index) => chunks[index]));
    } catch (err: unknown) {
      if (isRetryableEmbeddingError(err)) {
        const retryAfterMs = upstreamStatus(err) === 429 ? RATE_LIMIT_RETRY_MS : SERVICE_RETRY_MS;
        return step(before.size, total, false, retryAfterMs, extraction);
      }
      await markFailed(documentId, embeddingFailureReason(err));
      return step(before.size, total, false, null, extraction);
    }

    const { error: insertError } = await supabaseServer.from("document_chunks").insert(
      batch.map((index, k) => ({
        document_id: documentId,
        chunk_index: index,
        content: chunks[index],
        embedding: vectors[k],
        embedding_model: model,
      }))
    );
    // 23505: otro paso guardó esos índices al mismo tiempo; se recuentan abajo.
    if (insertError && insertError.code !== "23505") {
      console.error("[teacher] library: guardado de fragmentos", insertError.code);
      await markFailed(documentId, "SAVE: no se pudieron guardar los fragmentos. Reintenta para continuar.");
      return step(before.size, total, false, null, extraction);
    }
  }

  // Listo solo si están todos los índices, contados de nuevo en la base, y coinciden con el archivo.
  const stored = await storedIndices(documentId, model);
  const processed = chunks.filter((_, index) => stored.has(index)).length;
  if (processed < total) return step(processed, total, false, null, extraction);

  if (!(await storedChunksMatch(documentId, model, chunks))) {
    await markFailed(
      documentId,
      "INDEX_MISMATCH: los fragmentos guardados con el modelo actual no coinciden con el archivo; no se marcó como listo. Hay que borrar esos fragmentos antes de reintentar."
    );
    return step(processed, total, false, null, extraction);
  }
  // Listo e inactivo: se activa aparte, cuando el docente lo revisa.
  const { error: readyError } = await supabaseServer
    .from("documents")
    .update({ status: "ready", processing_error: null, is_active: false })
    .eq("id", documentId)
    .eq("status", "processing");
  if (readyError) throw new LibraryStoreError("documents", readyError);
  return step(processed, total, true, null, extraction);
}

export type LibraryReindexResult =
  | {
      ok: true;
      document: LibraryDocument;
      started: boolean;
      totalChunks: number | null;
      extraction: LibraryExtractionReport | null;
    }
  | LibraryFailure;

// Reclama para reindexar un documento global pending cuyo archivo está en Storage (library/ o
// mypes/): lo descarga, lo valida y fragmenta como una subida, calcula su hash y lo pasa a
// processing e inactivo con una escritura condicional (status = 'pending'), así dos pestañas no lo
// reclaman dos veces. Si el archivo falta, no se lee, no tiene texto, supera los límites o es un
// duplicado, responde el motivo y el documento queda como estaba. No genera embeddings: eso lo
// hacen los pasos de processLibraryDocumentStep, que el panel encadena después. Un documento que
// ya no está pending (otra pestaña lo empezó, quedó a medias o ya está listo) se devuelve tal
// cual, con started false.
export async function startLibraryReindex(documentId: string, now: Date): Promise<LibraryReindexResult> {
  let model: string;
  try {
    model = getEmbeddingEngine().modelId;
  } catch {
    return failure("EMBEDDINGS_NOT_CONFIGURED", 503, "El motor de embeddings no está configurado en el servidor.");
  }

  const row = await loadProcessRow(documentId);
  if (!row) return failure("NOT_FOUND", 404, "El documento no existe.");
  const extension = librarySourceExtension(row);
  if (!extension) return failure("CONFLICT", 409, "Este documento no se puede reindexar desde la biblioteca.");

  async function current(): Promise<LibraryReindexResult> {
    const document = await loadLibraryDocument(documentId, model, now);
    if (!document) return failure("NOT_FOUND", 404, "El documento no existe.");
    return { ok: true, document, started: false, totalChunks: null, extraction: null };
  }

  if (row.status !== "pending") return current();

  const file = await supabaseServer.storage.from(LIBRARY_BUCKET).download(row.path);
  if (file.error || !file.data) {
    return failure("CONFLICT", 409, "No se encontró el archivo del documento en Storage.");
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const contentHash = sha256Hex(bytes);
  if (row.content_hash && row.content_hash !== contentHash) {
    return failure("CONFLICT", 409, "El archivo de Storage no coincide con el registrado para este documento.");
  }

  let content: LibraryFileContent;
  try {
    content = await readLibraryFile(extension, bytes);
  } catch (err: unknown) {
    if (err instanceof LibraryFileError) return failure(err.code, 422, err.message);
    throw err;
  }

  const { data: duplicate, error: duplicateError } = await supabaseServer
    .from("documents")
    .select("id, title")
    .eq("content_hash", contentHash)
    .is("user_id", null)
    .neq("id", documentId)
    .maybeSingle();
  if (duplicateError) throw new LibraryStoreError("documents", duplicateError);
  if (duplicate) {
    const title = typeof duplicate.title === "string" ? duplicate.title : "otro documento";
    return failure("CONFLICT", 409, `Este archivo ya está en la biblioteca como «${title}».`);
  }

  const { data: claimed, error: claimError } = await supabaseServer
    .from("documents")
    .update({ status: "processing", content_hash: contentHash, processing_error: null, is_active: false })
    .eq("id", documentId)
    .is("user_id", null)
    .eq("status", "pending")
    .select("id");
  if (claimError) {
    // Mismo hash en un documento que no es de la biblioteca: no se revela cuál.
    if (claimError.code === "23505") return failure("CONFLICT", 409, "Este archivo ya está en la biblioteca.");
    throw new LibraryStoreError("documents", claimError);
  }
  if (!claimed || claimed.length === 0) return current();

  const document = await loadLibraryDocument(documentId, model, now);
  if (!document) return failure("NOT_FOUND", 404, "El documento no existe.");
  return { ok: true, document, started: true, totalChunks: content.chunks.length, extraction: content.extraction };
}

export type LibraryActivationResult = { ok: true; document: LibraryDocument } | LibraryFailure;

// Activa o desactiva un documento global. Desactivar siempre se puede (deja de usarse en el RAG).
// Activar solo si activationProblem no encuentra nada, contando de nuevo en la base los fragmentos
// del modelo actual, y con una escritura condicional (status = 'ready'): si el documento cambió
// entre la revisión y la escritura, no se activa. No toca el archivo, los fragmentos ni el estado.
export async function setLibraryDocumentActive(
  documentId: string,
  active: boolean,
  now: Date
): Promise<LibraryActivationResult> {
  const model = libraryEmbeddingModel();
  const row = await loadProcessRow(documentId);
  if (!row) return failure("NOT_FOUND", 404, "El documento no existe.");

  async function result(): Promise<LibraryActivationResult> {
    const document = await loadLibraryDocument(documentId, model, now);
    return document ? { ok: true, document } : failure("NOT_FOUND", 404, "El documento no existe.");
  }

  if (!active) {
    if (!row.is_active) return result();
    const { error } = await supabaseServer
      .from("documents")
      .update({ is_active: false })
      .eq("id", documentId)
      .is("user_id", null);
    if (error) throw new LibraryStoreError("documents", error);
    return result();
  }

  if (!model) return failure("EMBEDDINGS_NOT_CONFIGURED", 503, "El motor de embeddings no está configurado en el servidor.");
  const problem = activationProblem(row, [...(await storedIndices(documentId, model))]);
  if (problem) return failure("CONFLICT", 409, problem);
  if (row.is_active) return result();

  const { data, error } = await supabaseServer
    .from("documents")
    .update({ is_active: true })
    .eq("id", documentId)
    .is("user_id", null)
    .eq("status", "ready")
    .select("id");
  if (error) throw new LibraryStoreError("documents", error);
  if (!data || data.length === 0) {
    return failure("CONFLICT", 409, "El documento cambió mientras se activaba. Actualiza la lista y vuelve a intentarlo.");
  }
  return result();
}
