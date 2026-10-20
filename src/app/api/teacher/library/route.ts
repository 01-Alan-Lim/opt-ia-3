// src/app/api/teacher/library/route.ts
//
// Biblioteca Académica del panel docente.
//   GET  -> los documentos globales (user_id NULL) con formato, estado, fechas y cantidad de
//           fragmentos por modelo de embedding (M4). No devuelve texto, embeddings, rutas de
//           Storage ni documentos de estudiantes.
//   POST -> multipart { file, title? }: sube un PDF digital o un DOCX (hasta 4 MB), lo valida y
//           crea el documento en processing e inactivo (src/lib/teacher/library/processing.ts).
//           Los embeddings se generan después, por pasos: POST /api/teacher/library/:id/process.
//
// Autoridad: requireTeacher (Supabase Auth + allowlist docente en el servidor), igual que el
// resto de /api/teacher/*. Recién después se lee y escribe con service role: documents,
// document_chunks y el bucket documents no tienen policies para docentes.

import { z } from "zod";

import { failResponse, ok } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { supabaseServer } from "@/lib/supabaseServer";
import {
  LibraryChunkTagRowSchema,
  LibraryDocumentRowSchema,
  MAX_UPLOAD_BYTES,
  summarizeLibraryDocuments,
  type LibraryChunkTagRow,
} from "@/lib/teacher/library/catalog";
import {
  createLibraryDocument,
  fetchAllLibraryRows,
  isSchemaNotReady,
  LIBRARY_DOCUMENT_COLUMNS,
  libraryEmbeddingModel,
  LibraryStoreError,
} from "@/lib/teacher/library/processing";

export const runtime = "nodejs";
export const maxDuration = 60;

// Ids por consulta de fragmentos, para no alargar la URL del filtro in.
const IDS_PER_QUERY = 100;
// Margen del multipart (límites, nombres de campos) sobre el tamaño del archivo.
const MULTIPART_MARGIN_BYTES = 64 * 1024;

const UploadFieldsSchema = z.object({
  title: z.string().trim().max(200, "El título no puede superar los 200 caracteres.").optional(),
});

function storeFailure(err: unknown, action: string): Response {
  if (isSchemaNotReady(err)) {
    console.error("[teacher] library: falta la migración M4", err instanceof LibraryStoreError ? err.source : err);
    return failResponse("SCHEMA_NOT_READY", "La biblioteca todavía no está preparada en la base de datos.", 503);
  }
  console.error(`[teacher] library: ${action}`, err instanceof LibraryStoreError ? err.source : err);
  return failResponse("INTERNAL_ERROR", action === "lectura" ? "No se pudo cargar la biblioteca." : "No se pudo guardar el documento.", 500);
}

export async function GET(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  try {
    const documents = await fetchAllLibraryRows("documents", LibraryDocumentRowSchema, (from, to) =>
      supabaseServer
        .from("documents")
        .select(LIBRARY_DOCUMENT_COLUMNS)
        .is("user_id", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
    );

    const ids = documents.map((doc) => doc.id);
    const chunkTags: LibraryChunkTagRow[] = [];
    for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
      const group = ids.slice(start, start + IDS_PER_QUERY);
      chunkTags.push(
        ...(await fetchAllLibraryRows("document_chunks", LibraryChunkTagRowSchema, (from, to) =>
          supabaseServer
            .from("document_chunks")
            .select("document_id, embedding_model")
            .in("document_id", group)
            .order("id", { ascending: true })
            .range(from, to)
        ))
      );
    }

    const currentEmbeddingModel = libraryEmbeddingModel();
    return ok({
      documents: summarizeLibraryDocuments(documents, chunkTags, { currentModel: currentEmbeddingModel, now: new Date() }),
      currentEmbeddingModel,
    });
  } catch (err: unknown) {
    return storeFailure(err, "lectura");
  }
}

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  // Un cuerpo declarado demasiado grande se rechaza sin leerlo.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_MARGIN_BYTES) {
    return failResponse("PAYLOAD_TOO_LARGE", "El archivo supera los 4 MB.", 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return failResponse("BAD_REQUEST", "Envía el archivo como formulario (multipart/form-data).", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return failResponse("BAD_REQUEST", "Falta el archivo.", 400);
  const rawTitle = form.get("title");
  const fields = UploadFieldsSchema.safeParse({ title: typeof rawTitle === "string" ? rawTitle : undefined });
  if (!fields.success) {
    return failResponse("BAD_REQUEST", fields.error.issues[0]?.message ?? "Datos inválidos.", 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) return failResponse("PAYLOAD_TOO_LARGE", "El archivo supera los 4 MB.", 413);

  try {
    const result = await createLibraryDocument({
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      title: fields.data.title,
      now: new Date(),
    });
    if (!result.ok) return failResponse(result.code, result.message, result.status);
    return ok({ document: result.document, totalChunks: result.totalChunks });
  } catch (err: unknown) {
    return storeFailure(err, "subida");
  }
}
