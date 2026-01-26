// src/app/api/hours/route.ts
import { z } from "zod";

import { supabaseServer } from "@/lib/supabaseServer";
import { requireUser } from "@/lib/auth/supabase";
import { ok, failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

// -----------------------------
// Helpers
// -----------------------------
function toDateOnlyUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatYYYYMMDD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Convierte 'YYYY-MM-DD' (date en Supabase) a Date UTC (00:00:00Z)
 */
function parseDateOnlyUTC(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function diffDaysUTC(a: Date, b: Date): number {
  return Math.floor((toDateOnlyUTC(a).getTime() - toDateOnlyUTC(b).getTime()) / 86400000);
}

/**
 * Periodo semanal anclado a un sábado inicial definido por el docente:
 * - period_start: sábado (YYYY-MM-DD)
 * - period_end: viernes (YYYY-MM-DD) [rango inclusivo de 7 días]
 */
function computeWeeklyPeriodFromAnchor(now: Date, anchorSaturday: Date) {
  const today = toDateOnlyUTC(now);
  const anchor = toDateOnlyUTC(anchorSaturday);

  // Si hoy es antes del sábado inicial, usamos la primera semana desde el anchor
  const daysFromAnchor = Math.max(0, diffDaysUTC(today, anchor));
  const weeksSince = Math.floor(daysFromAnchor / 7);

  const start = new Date(anchor.getTime() + weeksSince * 7 * 86400000); // sábado
  const end = new Date(start.getTime() + 6 * 86400000); // viernes

  return {
    period_start: formatYYYYMMDD(start),
    period_end: formatYYYYMMDD(end),
  };
}


// -----------------------------
// Validation
// -----------------------------
const PostSchema = z.object({
  hours: z.number().min(0).max(200), // ajusta si quieres
  activity: z.string().min(3).max(500),
});

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    // Gate: solo estudiantes aquí
    if (authed.role !== "student") {
      return failResponse("FORBIDDEN", "Solo estudiantes pueden ver/registrar horas.", 403);
    }

    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "20") || 20, 100);

    // Perfil extendido para cohorte + estado de registro + ventana
    const { data: profile, error: profErr } = await supabaseServer
      .from("profiles")
      .select("user_id,role,cohort_id,registration_status,access_starts_at,access_ends_at")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (profErr) {
      return failResponse("INTERNAL", "No se pudo leer el perfil.", 500, profErr);
    }
    if (!profile) {
      return failResponse("NOT_FOUND", "Perfil no encontrado.", 404);
    }

    // Gates mínimos
    if (profile.role && profile.role !== "student") {
      return failResponse("FORBIDDEN", "Perfil no autorizado para horas.", 403);
    }
    if (profile.registration_status && profile.registration_status !== "approved") {
      return failResponse("FORBIDDEN", "Registro pendiente o no aprobado.", 403, {
        registration_status: profile.registration_status,
      });
    }
    if (!profile.cohort_id) {
      return failResponse("FORBIDDEN", "No tienes cohorte asignada.", 403);
    }

    // Ventana de acceso (si existe)
    const now = new Date();
    const startsAt = profile.access_starts_at ? new Date(profile.access_starts_at) : null;
    const endsAt = profile.access_ends_at ? new Date(profile.access_ends_at) : null;
    if (startsAt && now < startsAt) {
      return failResponse("FORBIDDEN", "Tu acceso aún no inició.", 403);
    }
    if (endsAt && now > endsAt) {
      return failResponse("FORBIDDEN", "Tu acceso ya finalizó.", 403);
    }

    const { data, error } = await supabaseServer
      .from("hours_entries")
      .select("id,user_id,cohort_id,period_start,period_end,hours,activity,created_at,updated_at")
      .eq("user_id", authed.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return failResponse("INTERNAL", "No se pudo listar horas.", 500, error);
    }

    return ok({ items: data ?? [] });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "No autenticado.", 401);
    if (msg === "FORBIDDEN_DOMAIN")
      return failResponse("FORBIDDEN_DOMAIN", "Dominio no permitido.", 403);
    return failResponse("INTERNAL", "Error interno.", 500, { message: msg });
  }
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    if (authed.role !== "student") {
      return failResponse("FORBIDDEN", "Solo estudiantes pueden registrar horas.", 403);
    }

    const body = await req.json().catch(() => null);
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return failResponse("BAD_REQUEST", "Payload inválido.", 400, parsed.error.flatten());
    }

    // Perfil extendido
    const { data: profile, error: profErr } = await supabaseServer
      .from("profiles")
      .select("user_id,role,cohort_id,registration_status,access_starts_at,access_ends_at")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (profErr) return failResponse("INTERNAL", "No se pudo leer el perfil.", 500, profErr);
    if (!profile) return failResponse("NOT_FOUND", "Perfil no encontrado.", 404);

    if (profile.role && profile.role !== "student") {
      return failResponse("FORBIDDEN", "Perfil no autorizado para horas.", 403);
    }
    if (profile.registration_status && profile.registration_status !== "approved") {
      return failResponse("FORBIDDEN", "Registro pendiente o no aprobado.", 403, {
        registration_status: profile.registration_status,
      });
    }
    if (!profile.cohort_id) {
      return failResponse("FORBIDDEN", "No tienes cohorte asignada.", 403);
    }

    // Ventana de acceso (si existe)
    const now = new Date();
    const startsAt = profile.access_starts_at ? new Date(profile.access_starts_at) : null;
    const endsAt = profile.access_ends_at ? new Date(profile.access_ends_at) : null;
    if (startsAt && now < startsAt) {
      return failResponse("FORBIDDEN", "Tu acceso aún no inició.", 403);
    }
    if (endsAt && now > endsAt) {
      return failResponse("FORBIDDEN", "Tu acceso ya finalizó.", 403);
    }

    // Cohorte: necesitamos el ancla del primer sábado (hours_start_at)
    const { data: cohort, error: cohErr } = await supabaseServer
    .from("cohorts")
    .select("id,hours_start_at")
    .eq("id", profile.cohort_id)
    .maybeSingle();

    if (cohErr) return failResponse("INTERNAL", "No se pudo leer la cohorte.", 500, cohErr);
    if (!cohort) return failResponse("NOT_FOUND", "Cohorte no encontrada.", 404);

    if (!cohort.hours_start_at) {
    return failResponse(
        "INTERNAL",
        "La cohorte no tiene configurado el primer sábado (hours_start_at).",
        500,
        { cohort_id: profile.cohort_id }
    );
    }

    // hours_start_at viene como ISO; lo convertimos a Date y lo llevamos a date-only UTC (sábado)
    const anchor = parseDateOnlyUTC(String(cohort.hours_start_at));
    // Validación: debe ser sábado (UTC)
    if (anchor.getUTCDay() !== 6) {
    return failResponse(
        "BAD_REQUEST",
        "hours_start_at debe ser sábado (UTC).",
        400,
        { hours_start_at: cohort.hours_start_at }
    );
    }
    
    const period = computeWeeklyPeriodFromAnchor(now, anchor);

    // NO edición: INSERT-only (unique user_id + period_start => 409 si ya existe)
    const payload = {
      user_id: authed.userId,
      cohort_id: profile.cohort_id,
      period_start: period.period_start,
      period_end: period.period_end,
      hours: parsed.data.hours,
      activity: parsed.data.activity,
    };

    const { data: saved, error: insErr } = await supabaseServer
        .from("hours_entries")
        .insert(payload)
        .select("id,user_id,cohort_id,period_start,period_end,hours,activity,created_at,updated_at")
        .single();

    if (insErr) {
        // 23505 = unique_violation (Postgres)
        // En Supabase suele venir como code: "23505"
        const pgCode = (insErr as any)?.code;

        if (pgCode === "23505") {
            return failResponse(
            "CONFLICT",
            "Ya registraste tus horas para este periodo. No se permite editar.",
            409,
            {
                period_start: payload.period_start,
                period_end: payload.period_end,
            }
            );
        }

        return failResponse("INTERNAL", "No se pudo registrar horas (insert).", 500, insErr);
    }

    return ok({ saved, period, cadenceDays: 7 });

  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "No autenticado.", 401);
    if (msg === "FORBIDDEN_DOMAIN")
      return failResponse("FORBIDDEN_DOMAIN", "Dominio no permitido.", 403);
    return failResponse("INTERNAL", "Error interno.", 500, { message: msg });
  }
}
