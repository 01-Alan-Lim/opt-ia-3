// src/app/api/teacher/calendar-organizer/withdraw/route.ts
//
// POST: cancela todas las invitaciones futuras enviadas por la cuenta organizadora conectada (Google
// avisa a cada estudiante). Sirve para cambiar de cuenta organizadora sin dejar invitaciones
// duplicadas. Las de fechas pasadas solo se marcan como retiradas, sin avisos. Solo docentes.

import { ok } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { withdrawAllInvitations } from "@/lib/calendar/invitationTriggers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;
  return ok({ calendar: await withdrawAllInvitations(new URL(req.url).origin) });
}
