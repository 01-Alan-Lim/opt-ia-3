// src/app/api/teacher/cohorts/[id]/calendar/sync/route.ts
//
// POST: sincroniza las invitaciones de Calendar de una cohorte desde la cuenta organizadora (el
// panel la llama al guardar fechas, hora del recordatorio o enlaces). Solo docentes. Crea las que
// faltan, actualiza las que cambiaron y cancela las que ya no corresponden; ver invitationSync.ts.

import { z } from "zod";

import { ok, failResponse } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { syncCohortInvitations } from "@/lib/calendar/invitationTriggers";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(req: Request, ctx: RouteContext<"/api/teacher/cohorts/[id]/calendar/sync">) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return failResponse("BAD_REQUEST", "ID de cohorte inválido.", 400);

  const { data: cohort, error } = await supabaseServer.from("cohorts").select("id").eq("id", params.data.id).maybeSingle();
  if (error) return failResponse("INTERNAL", "No se pudo leer la cohorte.", 500);
  if (!cohort) return failResponse("NOT_FOUND", "Cohorte no encontrada.", 404);

  const calendar = await syncCohortInvitations(params.data.id, new URL(req.url).origin);
  return ok({ calendar });
}
