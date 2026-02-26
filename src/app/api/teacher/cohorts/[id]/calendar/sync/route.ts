// src/app/api/teacher/cohorts/[id]/calendar/sync/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import {
  exchangeRefreshTokenForAccessToken,
  createCalendarEvent,
  patchCalendarEvent,
  type CalendarEventInput,
} from "@/lib/googleCalendar";

export const runtime = "nodejs";

type RouteParams = { id: string };

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z
  .object({
    dryRun: z.boolean().optional(),
    // límite de usuarios a procesar (MVP para no colgarse)
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || "America/La_Paz";

function labelForEventKind(kind: string, index: number | null) {
  if (kind === "FORM_INITIAL") return "Formulario inicial";
  if (kind === "FORM_FINAL") return "Formulario final";
  if (kind === "FORM_MONTHLY") return `Formulario mensual ${index ?? ""}`.trim();
  if (kind === "ADVANCE") return `Avance ${index ?? ""}`.trim();
  return kind;
}

function buildDateTimeISO(params: { date: string; hour: number; minute: number }) {
  const { date, hour, minute } = params;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  const start = `${date}T${hh}:${mm}:00`;
  const endMinuteTotal = hour * 60 + minute + 30;
  const endH = String(Math.floor(endMinuteTotal / 60)).padStart(2, "0");
  const endM = String(endMinuteTotal % 60).padStart(2, "0");
  const end = `${date}T${endH}:${endM}:00`;

  return { start, end };
}


// Next.js 15+: params en Route Handlers llega como Promise y debe await
export async function POST(req: Request, { params }: { params: Promise<RouteParams> }) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(
        fail("FORBIDDEN", "Solo docentes pueden sincronizar calendarios."),
        { status: 403 }
      );
    }

    const { id } = await params;
    const { id: cohortId } = ParamsSchema.parse({ id });

    const body = await req.json().catch(() => null);
    const parsed = BodySchema?.safeParse(body);
    if (parsed && !parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Payload inválido."), { status: 400 });
    }

    const dryRun = parsed?.success ? Boolean(parsed.data?.dryRun) : false;
    const limit = parsed?.success ? parsed.data?.limit ?? 200 : 200;

    // 1) Leer config de cohorte
    const { data: cohort, error: cohortErr } = await supabaseServer
      .from("cohorts")
      .select("id, name, reminder_hour, reminder_minute, form_initial_url, form_monthly_url, form_final_url")
      .eq("id", cohortId)
      .maybeSingle();

    if (cohortErr) {
      return NextResponse.json(
        fail("INTERNAL", "Error leyendo configuración de cohorte.", cohortErr),
        { status: 500 }
      );
    }
    if (!cohort?.id) {
      return NextResponse.json(fail("NOT_FOUND", "Cohorte no encontrada."), { status: 404 });
    }

    const reminderHour = Number(cohort.reminder_hour ?? 11);
    const reminderMin = Number(cohort.reminder_minute ?? 0);

    // 2) Leer eventos habilitados
    const { data: events, error: eventsErr } = await supabaseServer
      .from("cohort_events")
      .select("id, event_kind, event_index, event_date, remind_before_days, is_enabled")
      .eq("cohort_id", cohort.id)
      .eq("is_enabled", true)
      .order("event_date", { ascending: true });

    if (eventsErr) {
      return NextResponse.json(fail("INTERNAL", "Error leyendo cohort_events.", eventsErr), { status: 500 });
    }
    if (!events || events.length === 0) {
      return ok({
        dryRun,
        cohort: { id: cohort.id, name: cohort.name },
        processed: 0,
        connected: 0,
        created: 0,
        updated: 0,
        totalEvents: 0,
      });
    }

    // 3) Leer estudiantes de la cohorte
    const { data: profiles, error: profErr } = await supabaseServer
      .from("profiles")
      .select("user_id")
      .eq("cohort_id", cohort.id)
      .limit(limit);

    if (profErr) {
      return NextResponse.json(fail("INTERNAL", "Error leyendo perfiles de cohorte.", profErr), { status: 500 });
    }

    const userIds = (profiles ?? []).map((p: any) => p.user_id).filter(Boolean);
    if (userIds.length === 0) {
      return ok({
        dryRun,
        cohort: { id: cohort.id, name: cohort.name },
        processed: 0,
        connected: 0,
        created: 0,
        updated: 0,
        totalEvents: events.length,
      });
    }

    // 4) Leer tokens conectados
    const { data: tokens, error: tokErr } = await supabaseServer
      .from("user_google_calendar_tokens")
      .select("user_id, refresh_token, calendar_id")
      .in("user_id", userIds)
      .eq("provider", "google");

    if (tokErr) {
      return NextResponse.json(fail("INTERNAL", "Error leyendo tokens de calendario.", tokErr), { status: 500 });
    }

    const byUser = new Map<string, { refresh_token: string; calendar_id: string | null }>();
    for (const t of tokens ?? []) {
      if (t?.user_id && t?.refresh_token) {
        byUser.set(t.user_id, { refresh_token: t.refresh_token, calendar_id: t.calendar_id ?? null });
      }
    }

    let processed = 0;
    let connected = 0;
    let created = 0;
    let updated = 0;

    // 5) Sync por usuario (secuencial MVP)
    for (const userId of userIds) {
      processed += 1;
      const tok = byUser.get(userId);
      if (!tok) continue;

      connected += 1;
      const calendarId = tok.calendar_id || "primary";

      const accessToken = dryRun
        ? "DRY_RUN"
        : await exchangeRefreshTokenForAccessToken({ refreshToken: tok.refresh_token });

      for (const e of events) {
        const kind = String(e.event_kind);
        const index = e.event_index === null || e.event_index === undefined ? null : Number(e.event_index);
        const date = String(e.event_date);
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

        const { data: mapRow, error: mapErr } = await supabaseServer
          .from("user_google_calendar_event_map")
          .select("id, google_event_id")
          .eq("user_id", userId)
          .eq("cohort_event_id", e.id)
          .maybeSingle();

        if (mapErr) {
          return NextResponse.json(fail("INTERNAL", "Error leyendo mapeo de eventos.", mapErr), { status: 500 });
        }

        if (dryRun) continue;

        if (!mapRow?.google_event_id) {
          const createdEvent = await createCalendarEvent({ accessToken, calendarId, event: eventPayload });

          const { error: upErr } = await supabaseServer
            .from("user_google_calendar_event_map")
            .upsert(
              {
                user_id: userId,
                cohort_event_id: e.id,
                calendar_id: calendarId,
                google_event_id: createdEvent.id,
              },
              { onConflict: "user_id,cohort_event_id" }
            );

          if (upErr) {
            return NextResponse.json(fail("INTERNAL", "Error guardando mapeo google_event_id.", upErr), { status: 500 });
          }

          created += 1;
        } else {
          await patchCalendarEvent({ accessToken, calendarId, eventId: mapRow.google_event_id, event: eventPayload });
          updated += 1;
        }
      }
    }

    return ok({
      dryRun,
      cohort: { id: cohort.id, name: cohort.name },
      processed,
      connected,
      created,
      updated,
      totalEvents: events.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}