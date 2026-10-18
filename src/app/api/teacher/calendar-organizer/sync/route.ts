// src/app/api/teacher/calendar-organizer/sync/route.ts
//
// POST: sincroniza todas las invitaciones (botón "Sincronizar" del panel y justo después de
// conectar la cuenta organizadora). Solo docentes.

import { ok } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { syncAllInvitations } from "@/lib/calendar/invitationTriggers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;
  return ok({ calendar: await syncAllInvitations(new URL(req.url).origin) });
}
