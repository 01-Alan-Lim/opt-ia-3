// src/app/api/teacher/calendar-organizer/route.ts
//
// Cuenta organizadora de Google Calendar, para el panel docente. Solo docentes.
//   GET    -> estado público: cuenta conectada, estado, última sincronización, último error y
//             totales de invitaciones (nunca el token ni el texto cifrado).
//   DELETE -> desconecta: revoca el acceso en Google si puede y borra la conexión. Las
//             invitaciones ya enviadas siguen en los calendarios de los estudiantes. Solo desde
//             un entorno con el calendario configurado (un Preview sin la clave que comparta la
//             base no puede desconectar la cuenta de Production).

import { ok, failResponse } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { invitationTotals } from "@/lib/calendar/invitationSync";
import { disconnectOrganizer, organizerConfig, readOrganizerStatus } from "@/lib/calendar/organizer";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;
  const [organizer, invitations] = await Promise.all([readOrganizerStatus(), invitationTotals()]);
  return ok({ ...organizer, invitations }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;
  const config = organizerConfig();
  if (!config.oauth || !config.encryptionKey) {
    return failResponse("CALENDAR_NOT_CONFIGURED", "El calendario no está configurado en este entorno.", 503);
  }
  const result = await disconnectOrganizer();
  if (!result.ok) return failResponse("INTERNAL", "No se pudo desconectar la cuenta organizadora.", 500);
  return ok({ disconnected: true, revokedAtGoogle: result.revokedAtGoogle });
}
