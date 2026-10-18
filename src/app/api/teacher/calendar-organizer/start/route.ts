// src/app/api/teacher/calendar-organizer/start/route.ts
//
// POST: un docente inicia la conexión de la cuenta organizadora de Google Calendar. Devuelve la
// URL de autorización de Google (calendar.events + email, acceso offline) y deja la cookie CSRF
// que comprobará /callback. Solo docentes.

import { NextResponse } from "next/server";

import { failResponse } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { buildOrganizerAuthUrl, encodeOrganizerState, organizerRedirectUri, readOAuthClientConfig } from "@/lib/calendar/googleOAuth";
import { newOrganizerCsrf, setOrganizerCsrfCookie } from "@/lib/calendar/organizerCsrf";
import { getCalendarTokenKey } from "@/lib/calendar/tokenCipher";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const config = readOAuthClientConfig();
  if (!config) {
    return failResponse("CALENDAR_NOT_CONFIGURED", "Falta configurar el cliente OAuth de Google en el servidor.", 503);
  }
  if (!getCalendarTokenKey().ok) {
    return failResponse("CALENDAR_NOT_CONFIGURED", "Falta configurar la clave de cifrado del calendario en el servidor.", 503);
  }

  const csrf = newOrganizerCsrf();
  const url = buildOrganizerAuthUrl({
    clientId: config.clientId,
    redirectUri: organizerRedirectUri(new URL(req.url).origin),
    state: encodeOrganizerState(csrf),
  });
  const res = NextResponse.json({ ok: true, data: { url } }, { headers: { "Cache-Control": "no-store" } });
  setOrganizerCsrfCookie(res, req, csrf);
  return res;
}
