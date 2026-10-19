// src/app/api/teacher/calendar-organizer/callback/route.ts
//
// POST { code, state }: la página /auth/calendar-callback devuelve aquí el código de Google. Solo
// docentes y solo con el CSRF de /start (state = cookie). El código se canjea en el servidor; el
// refresh token se guarda cifrado y no vuelve al navegador. Si OPT-IA ya envió invitaciones desde
// otra cuenta, no se cambia de cuenta: esas invitaciones solo las puede actualizar o cancelar
// quien las envió.

import { NextResponse } from "next/server";
import { z } from "zod";

import { failResponse } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { exchangeOrganizerCode, organizerRedirectUri, readOAuthClientConfig, revokeGoogleToken } from "@/lib/calendar/googleOAuth";
import { saveOrganizerConnection } from "@/lib/calendar/organizer";
import { clearOrganizerCsrfCookie, organizerCsrfMatches } from "@/lib/calendar/organizerCsrf";
import { getCalendarTokenKey } from "@/lib/calendar/tokenCipher";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const BodySchema = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
});

const EXCHANGE_MESSAGES = {
  EXCHANGE_FAILED: "Google no aceptó el código de autorización. Vuelve a intentarlo.",
  MISSING_SCOPE: "Falta el permiso para gestionar eventos de Calendar. Vuelve a conectar y acéptalo.",
  NO_REFRESH_TOKEN: "Google no entregó acceso permanente. Quita OPT-IA de los permisos de la cuenta y vuelve a conectarla.",
  NO_EMAIL: "No se pudo confirmar el correo de la cuenta de Google.",
} as const;

function withClearedCookie(res: NextResponse, req: Request): NextResponse {
  clearOrganizerCsrfCookie(res, req);
  return res;
}

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return withClearedCookie(failResponse("BAD_REQUEST", "Faltan datos de la autorización de Google.", 400), req);

  if (!organizerCsrfMatches(req, body.data.state)) {
    return withClearedCookie(
      failResponse("FORBIDDEN", "La solicitud de conexión no es válida o caducó. Vuelve a iniciarla desde el panel docente.", 403),
      req,
    );
  }

  const config = readOAuthClientConfig();
  const key = getCalendarTokenKey();
  if (!config || !key.ok) {
    return withClearedCookie(failResponse("CALENDAR_NOT_CONFIGURED", "El calendario no está configurado en el servidor.", 503), req);
  }

  const exchange = await exchangeOrganizerCode({
    code: body.data.code,
    redirectUri: organizerRedirectUri(new URL(req.url).origin),
    config,
  });
  if (!exchange.ok) {
    return withClearedCookie(failResponse("GOOGLE_ERROR", EXCHANGE_MESSAGES[exchange.reason], 400), req);
  }

  const { data: foreign, error: foreignError } = await supabaseServer
    .from("user_google_calendar_event_map")
    .select("organizer_email")
    .eq("status", "invited")
    .neq("organizer_email", exchange.googleEmail)
    .limit(1);
  if (foreignError) {
    await revokeGoogleToken({ token: exchange.refreshToken });
    return withClearedCookie(failResponse("INTERNAL", "El calendario no está disponible todavía (falta preparar la base de datos).", 503), req);
  }
  const previous = (foreign as { organizer_email: string | null }[] | null)?.[0]?.organizer_email;
  if (previous) {
    await revokeGoogleToken({ token: exchange.refreshToken });
    return withClearedCookie(
      failResponse(
        "CONFLICT",
        `OPT-IA ya envió invitaciones desde ${previous}. Conecta esa misma cuenta o, antes de cambiarla, retira esas invitaciones desde el panel docente.`,
        409,
      ),
      req,
    );
  }

  const saved = await saveOrganizerConnection({
    key: key.key,
    googleEmail: exchange.googleEmail,
    refreshToken: exchange.refreshToken,
    scope: exchange.scope,
    connectedBy: auth.user.userId,
  });
  if (!saved) {
    await revokeGoogleToken({ token: exchange.refreshToken });
    return withClearedCookie(failResponse("INTERNAL", "No se pudo guardar la conexión del calendario.", 500), req);
  }

  return withClearedCookie(NextResponse.json({ ok: true, data: { googleEmail: exchange.googleEmail } }), req);
}
