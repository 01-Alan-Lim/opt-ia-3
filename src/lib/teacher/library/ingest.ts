// src/lib/teacher/library/ingest.ts
//
// Biblioteca Académica: reglas de un archivo subido, sin Supabase ni Gemini. Firma del archivo
// (PDF o DOCX), estructura del DOCX (zip con word/document.xml y tamaño descomprimido acotado),
// límites del texto, limpieza del texto extraído y fragmentación para el motor de embeddings.
// Todo es determinista: el mismo archivo da siempre los mismos fragmentos, y por eso el
// procesamiento por pasos puede retomar donde quedó.

import { createHash } from "node:crypto";

import { MAX_EMBED_INPUT_CHARS } from "@/lib/embeddingEngine";
import type { LibraryUploadExtension } from "./catalog";

// Menos letras y dígitos que esto es un documento sin texto (p. ej. un PDF escaneado: no hay OCR).
export const MIN_TEXT_CHARS = 200;
export const MAX_TEXT_CHARS = 400_000;
export const MAX_PDF_PAGES = 400;
// Un DOCX descomprime más que su tamaño: tope para que un zip inflado no agote la memoria.
export const MAX_DOCX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;
export const CHUNK_TARGET_CHARS = 1500;
export const CHUNK_OVERLAP_CHARS = 200;
export const MAX_CHUNKS = 300;

export type LibraryFileErrorCode = "INVALID_FILE" | "NO_EXTRACTABLE_TEXT" | "DOCUMENT_TOO_LONG";

export class LibraryFileError extends Error {
  readonly code: LibraryFileErrorCode;

  constructor(code: LibraryFileErrorCode, message: string) {
    super(message);
    this.name = "LibraryFileError";
    this.code = code;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Los primeros bytes tienen que corresponder a la extensión: %PDF- (pdf.js lo acepta dentro del
// primer KB) o la cabecera de un zip (PK\x03\x04) para DOCX.
export function checkSignature(bytes: Uint8Array, extension: LibraryUploadExtension): void {
  if (bytes.length === 0) throw new LibraryFileError("INVALID_FILE", "El archivo está vacío.");
  if (extension === "pdf") {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
    if (!head.includes("%PDF-")) throw new LibraryFileError("INVALID_FILE", "El archivo no es un PDF válido.");
    return;
  }
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!zip) {
    throw new LibraryFileError("INVALID_FILE", "El archivo no es un DOCX válido (o está protegido con contraseña).");
  }
}

export type ZipEntry = { name: string; uncompressedSize: number };

// Directorio central de un zip, sin descomprimir nada. null si el zip está dañado, truncado o es
// zip64 (un DOCX de pocos MB no lo usa).
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const EOCD_SIZE = 22;
  if (bytes.length < EOCD_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const stop = Math.max(0, bytes.length - EOCD_SIZE - 0xffff);
  for (let i = bytes.length - EOCD_SIZE; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset + directorySize > eocd) return null;

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) return null;
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > eocd || uncompressedSize === 0xffffffff) return null;
    entries.push({ name: decoder.decode(bytes.subarray(at + 46, nameEnd)), uncompressedSize });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

// Un DOCX es un zip con [Content_Types].xml y word/document.xml, y un tamaño descomprimido acotado.
export function checkDocxStructure(bytes: Uint8Array): void {
  const entries = readZipDirectory(bytes);
  if (!entries) throw new LibraryFileError("INVALID_FILE", "El DOCX está dañado o no es un archivo de Word.");
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has("word/document.xml") || !names.has("[Content_Types].xml")) {
    throw new LibraryFileError("INVALID_FILE", "El archivo no es un documento de Word (.docx).");
  }
  const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new LibraryFileError("DOCUMENT_TOO_LONG", "El DOCX descomprimido es demasiado grande.");
  }
}

// Texto extraído, limpio: saltos de línea uniformes, sin caracteres de control ni guiones suaves,
// las palabras cortadas al final de una línea ("produc-\nción") unidas, espacios simples y como
// mucho una línea en blanco seguida.
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/­/g, "")
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, "$1")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Dónde cortar un fragmento que llega hasta `end`: en el último fin de párrafo, de oración, de
// línea o espacio del último 40 % del tramo; si no hay ninguno, en `end`.
function breakPoint(text: string, start: number, end: number): number {
  const from = start + Math.floor((end - start) * 0.6);
  const tail = text.slice(from, end);

  const paragraph = tail.lastIndexOf("\n\n");
  if (paragraph >= 0) return from + paragraph + 2;

  let sentence = -1;
  for (const match of tail.matchAll(/[.!?…;:](?=\s)/g)) sentence = (match.index ?? -1) + 1;
  if (sentence > 0) return from + sentence;

  const line = tail.lastIndexOf("\n");
  if (line >= 0) return from + line + 1;
  const space = tail.lastIndexOf(" ");
  if (space >= 0) return from + space + 1;
  return end;
}

// Fragmentos de hasta `target` caracteres, cortados en un límite natural del texto, con `overlap`
// caracteres de solapamiento (desde el comienzo de una palabra) para no perder el contexto entre
// uno y el siguiente. Ninguno supera MAX_EMBED_INPUT_CHARS.
export function chunkText(text: string, target = CHUNK_TARGET_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const size = Math.min(target, MAX_EMBED_INPUT_CHARS);
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const limit = Math.min(start + size, text.length);
    const end = limit < text.length ? breakPoint(text, start, limit) : limit;
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;

    let next = Math.max(end - overlap, start + 1);
    const space = text.slice(next, end).search(/\s/);
    if (space >= 0) next += space + 1;
    start = next < end ? next : end;
  }

  return chunks;
}

export type PreparedLibraryText = { text: string; chunks: string[] };

// Del texto extraído a los fragmentos que se guardan, con los límites de la Biblioteca.
export function prepareLibraryText(rawText: string): PreparedLibraryText {
  const text = normalizeExtractedText(rawText);
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_TEXT_CHARS) {
    throw new LibraryFileError(
      "NO_EXTRACTABLE_TEXT",
      "No se encontró texto en el documento. Si es un PDF escaneado, no se puede usar: la Biblioteca no tiene OCR."
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new LibraryFileError("DOCUMENT_TOO_LONG", "El documento tiene demasiado texto para la Biblioteca.");
  }
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) {
    throw new LibraryFileError(
      "DOCUMENT_TOO_LONG",
      `El documento daría ${chunks.length} fragmentos; el máximo es ${MAX_CHUNKS}. Divídelo en partes.`
    );
  }
  return { text, chunks };
}

// Título a partir del nombre del archivo, si el docente no escribe uno.
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim();
  return (base || "Documento").slice(0, 200);
}
