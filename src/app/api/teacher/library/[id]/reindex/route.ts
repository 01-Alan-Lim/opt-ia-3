// src/app/api/teacher/library/[id]/reindex/route.ts
//
// POST /api/teacher/library/:id/reindex
// Empieza la reindexación de un documento de la biblioteca que ya tiene su archivo en Storage (las
// guías de mypes/), sin volver a subirlo: lo valida, guarda su hash y lo pasa a processing e
// inactivo (src/lib/teacher/library/processing.ts, startLibraryReindex). No genera embeddings:
// después el panel encadena POST /api/teacher/library/:id/process, igual que tras una subida, y el
// documento queda listo e inactivo hasta que el docente lo active. Repetirlo no duplica nada: si
// ya no está pending, responde el documento tal cual (started false).
//
// Autoridad: requireTeacher, como el resto de /api/teacher/*; después, service role, y solo sobre
// documentos globales (user_id NULL): el id del cliente se valida y se busca con ese filtro.

import { z } from "zod";

import { failResponse, ok } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { isSchemaNotReady, LibraryStoreError, startLibraryReindex } from "@/lib/teacher/library/processing";

export const runtime = "nodejs";
export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return failResponse("BAD_REQUEST", "Documento inválido.", 400);

  try {
    const result = await startLibraryReindex(params.data.id, new Date());
    if (!result.ok) return failResponse(result.code, result.message, result.status);
    return ok({
      document: result.document,
      started: result.started,
      totalChunks: result.totalChunks,
      extraction: result.extraction,
    });
  } catch (err: unknown) {
    if (isSchemaNotReady(err)) {
      return failResponse("SCHEMA_NOT_READY", "La biblioteca todavía no está preparada en la base de datos.", 503);
    }
    console.error("[teacher] library: reindexación", err instanceof LibraryStoreError ? err.source : err);
    return failResponse("INTERNAL_ERROR", "No se pudo empezar la reindexación. Puedes reintentarla.", 500);
  }
}
