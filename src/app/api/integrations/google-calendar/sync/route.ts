// src/app/api/integrations/google-calendar/sync/route.ts
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";
import {
  exchangeRefreshTokenForAccessToken,
  createCalendarEvent,
  patchCalendarEvent,
  type CalendarEventInput,
} from "@/lib/googleCalendar";

export const runtime = "nodejs";

const BodySchema = z
  .object({
    // Para test manual: si true, solo simula y NO crea eventos.
    dryRun: z.boolean().optional(),
  })
  .optional();

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || "America/La_Paz";

function buildDateTimeISO(params: {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  // Nota: usamos ISO sin offset; Google toma timeZone
}): { start: string; end: string } {
  const { date, hour, minute } = params;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  // 30 min de duración del “evento recordatorio”
  const start = `${date}T${hh}:${mm}:00`;
  const endMinuteTotal = hour * 60 + minute + 30;
  const endH = String(Math.floor(endMinuteTotal / 60)).padStart(2, "0");
  const endM = String(endMinuteTotal % 60).padStart(2, "0");
  const end = `${date}T${endH}:${endM}:00`;

  return { start, end };
}

function labelForEventKind(kind: string, index: number | null) {
  if (kind === "FORM_INITIAL") return "Formulario inicial";
  if (kind === "FORM_FINAL") return "Formulario final";
  if (kind === "FORM_MONTHLY") return `Formulario mensual ${index ?? ""}`.trim();
  if (kind === "ADVANCE") return `Avance ${index ?? ""}`.trim();
  return kind;
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const body = await req.json().catch(() => null);
    const parsed = BodySchema?.safeParse(body);
    if (parsed && !parsed.success) {
      return failResponse("BAD_REQUEST", "Payload inválido.", 400, parsed.error.issues);
    }

    const dryRun = parsed?.success ? Boolean(parsed.data?.dryRun) : false;

    // 1) Token guardado (refresh_token)
    const { data: tokenRow, error: tokenErr } = await supabaseServer
      .from("user_google_calendar_tokens")
      .select("refresh_token, calendar_id, scope")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (tokenErr) {
      return failResponse("INTERNAL", "Error leyendo token de calendario.", 500, tokenErr);
    }
    if (!tokenRow?.refresh_token) {
      return failResponse(
        "CONFLICT",
        "Google Calendar no está conectado. Conéctalo primero para sincronizar.",
        409
      );
    }

    const calendarId = tokenRow.calendar_id || "primary";

    // 2) Cohorte del estudiante (según tu onboarding: profiles.cohort_id)
    const { data: profile, error: profileErr } = await supabaseServer
      .from("profiles")
      .select("cohort_id")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (profileErr) {
      return failResponse("INTERNAL", "Error leyendo perfil del estudiante.", 500, profileErr);
    }
    if (!profile?.cohort_id) {
      return failResponse("CONFLICT", "No tienes cohorte asignada.", 409);
    }

    // 3) Cohort config (reminder_hour/min + urls)
    const { data: cohort, error: cohortErr } = await supabaseServer
      .from("cohorts")
      .select(
        "id, name, reminder_hour, reminder_minute, form_initial_url, form_monthly_url, form_final_url"
      )
      .eq("id", profile.cohort_id)
      .maybeSingle();

    if (cohortErr) {
      return failResponse("INTERNAL", "Error leyendo configuración de cohorte.", 500, cohortErr);
    }
    if (!cohort?.id) {
      return failResponse("NOT_FOUND", "Cohorte no encontrada.", 404);
    }

    const reminderHour = Number(cohort.reminder_hour ?? 11);
    const reminderMin = Number((cohort as any).reminder_minute ?? 0);

    // 4) Events habilitados
    const { data: events, error: eventsErr } = await supabaseServer
      .from("cohort_events")
      .select("id, event_kind, event_index, event_date, remind_before_days, is_enabled")
      .eq("cohort_id", cohort.id)
      .eq("is_enabled", true)
      .order("event_date", { ascending: true });

    if (eventsErr) {
      return failResponse("INTERNAL", "Error leyendo cohort_events.", 500, eventsErr);
    }

    if (!events || events.length === 0) {
      return ok({ synced: 0, message: "No hay eventos habilitados para sincronizar." });
    }

    // 5) Access token para Calendar
    const accessToken = dryRun
      ? "DRY_RUN"
      : await exchangeRefreshTokenForAccessToken({ refreshToken: tokenRow.refresh_token });

    // 6) Iterar y upsert en Calendar (con mapeo)
    let created = 0;
    let updated = 0;

    for (const e of events) {
      const kind = String(e.event_kind);
      const index = e.event_index === null || e.event_index === undefined ? null : Number(e.event_index);
      const date = String(e.event_date); // YYYY-MM-DD
      const remindDays = Number(e.remind_before_days ?? 2);

      const label = labelForEventKind(kind, index);
      const { start, end } = buildDateTimeISO({ date, hour: reminderHour, minute: reminderMin });

      let urlLine = "";
      if (kind === "FORM_INITIAL" && cohort.form_initial_url) urlLine = `Link: ${cohort.form_initial_url}`;
      if (kind === "FORM_MONTHLY" && cohort.form_monthly_url) urlLine = `Link base: ${cohort.form_monthly_url}`;
      if (kind === "FORM_FINAL" && cohort.form_final_url) urlLine = `Link: ${cohort.form_final_url}`;

      const description =
        `Cohorte: ${cohort.name}\n` +
        `Actividad: ${label}\n` +
        `Fecha: ${date}\n` +
        (urlLine ? `${urlLine}\n` : "") +
        "\nGenerado por OPT-IA (recordatorio académico).";

      const eventPayload: CalendarEventInput = {
        summary: `OPT-IA • ${label}`,
        description,
        startDateTime: start,
        endDateTime: end,
        timeZone: DEFAULT_TZ,
        reminders: {
          minutesBefore: Math.max(0, remindDays * 24 * 60),
          alsoAtStart: true,
        },
      };

      // Buscar mapeo existente
      const { data: mapRow, error: mapErr } = await supabaseServer
        .from("user_google_calendar_event_map")
        .select("id, google_event_id")
        .eq("user_id", authed.userId)
        .eq("cohort_event_id", e.id)
        .maybeSingle();

      if (mapErr) {
        return failResponse("INTERNAL", "Error leyendo mapeo de eventos.", 500, mapErr);
      }

      if (dryRun) continue;

      if (!mapRow?.google_event_id) {
        // Crear
        const createdEvent = await createCalendarEvent({
          accessToken,
          calendarId,
          event: eventPayload,
        });

        const { error: upErr } = await supabaseServer
          .from("user_google_calendar_event_map")
          .upsert(
            {
              user_id: authed.userId,
              cohort_event_id: e.id,
              calendar_id: calendarId,
              google_event_id: createdEvent.id,
            },
            { onConflict: "user_id,cohort_event_id" }
          );

        if (upErr) {
          return failResponse("INTERNAL", "Error guardando mapeo google_event_id.", 500, upErr);
        }

        created += 1;
      } else {
        // Update (PATCH)
        await patchCalendarEvent({
          accessToken,
          calendarId,
          eventId: mapRow.google_event_id,
          event: eventPayload,
        });
        updated += 1;
      }
    }

    return ok({
      cohort: { id: cohort.id, name: cohort.name },
      calendarId,
      created,
      updated,
      total: events.length,
      dryRun,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    if (msg === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }
    if (msg === "GOOGLE_OAUTH_MISSING") {
      return failResponse(
        "INTERNAL",
        "Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en env.",
        500
      );
    }

    return failResponse("INTERNAL", "Error interno en sync de Google Calendar.", 500, { msg });
  }
}
