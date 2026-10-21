// src/app/api/teacher/library/[id]/process/route.ts
//
// POST /api/teacher/library/:id/process
// Un paso del procesamiento de un documento subido por la Biblioteca Académica o de una guía en
// reindexación: un lote de embeddings y su guardado (src/lib/teacher/library/processing.ts). El
// panel llama hasta que responde done (listo, completo y verificado), el documento queda failed
// (con su motivo) o Gemini pide esperar (retryAfterMs; el documento sigue en processing). Sirve
// también para continuar uno interrumpido o reintentar uno fallido: retoma desde los fragmentos ya
// guardados.
//
// Autoridad: requireTeacher, como el resto de /api/teacher/*; después, service role.

import { z } from "zod";

import { failResponse, ok } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { isSchemaNotReady, LibraryStoreError, processLibraryDocumentStep } from "@/lib/teacher/library/processing";

export const runtime = "nodejs";
export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return failResponse("BAD_REQUEST", "Documento inválido.", 400);

  try {
    const step = await processLibraryDocumentStep(params.data.id, new Date());
    if (!step.ok) return failResponse(step.code, step.message, step.status);
    return ok({
      document: step.document,
      processedChunks: step.processedChunks,
      totalChunks: step.totalChunks,
      done: step.done,
      retryAfterMs: step.retryAfterMs,
      extraction: step.extraction,
    });
  } catch (err: unknown) {
    if (isSchemaNotReady(err)) {
      return failResponse("SCHEMA_NOT_READY", "La biblioteca todavía no está preparada en la base de datos.", 503);
    }
    console.error("[teacher] library: procesamiento", err instanceof LibraryStoreError ? err.source : err);
    return failResponse("INTERNAL_ERROR", "No se pudo procesar el documento. Puedes reintentarlo.", 500);
  }
}
