// src/lib/auth/chatAccess.ts
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";

export type GateReason =
  | "NEEDS_ONBOARDING"
  | "PENDING_APPROVAL"
  | "COHORT_INACTIVE"
  | "ACCESS_NOT_STARTED"
  | "ACCESS_EXPIRED";

type GateResult =
  | { ok: true }
  | { ok: false; reason: GateReason; message: string };

function toDateOrNull(x: unknown): Date | null {
  if (typeof x !== "string" || !x) return null;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function assertChatAccess(req: Request): Promise<GateResult> {
  const authed = await requireUser(req);

  // Teachers no pasan por gates académicos
  if (authed.role === "teacher") return { ok: true };

  const { data: profile, error } = await supabaseServer
    .from("profiles")
    .select(
      "ru,first_name,last_name,semester,cohort_id,registration_status,access_starts_at,access_ends_at"
    )
    .eq("user_id", authed.userId)
    .maybeSingle();

  // Si no hay profile o faltan campos mínimos => onboarding
  const needsOnboarding =
    !profile ||
    !profile.ru ||
    !profile.first_name ||
    !profile.last_name ||
    !profile.semester ||
    !profile.cohort_id;

  if (needsOnboarding) {
    return {
      ok: false,
      reason: "NEEDS_ONBOARDING",
      message: "Debes completar tu registro antes de usar el asistente.",
    };
  }

  if (profile.registration_status !== "approved") {
    return {
      ok: false,
      reason: "PENDING_APPROVAL",
      message: "Tu registro está pendiente de aprobación.",
    };
  }

  // Gate por cohorte (fuente de verdad: cohorts.is_active)
  const { data: cohortRow } = await supabaseServer
    .from("cohorts")
    .select("is_active")
    .eq("id", profile.cohort_id)
    .maybeSingle();

  if (cohortRow && cohortRow.is_active === false) {
    return {
      ok: false,
      reason: "COHORT_INACTIVE",
      message: "Tu cohorte está inactiva. Puedes ver tu historial, pero no enviar mensajes.",
    };
  }

  const now = new Date();
  const startsAt = toDateOrNull(profile.access_starts_at);
  const endsAt = toDateOrNull(profile.access_ends_at);

  if (startsAt && now < startsAt) {
    return {
      ok: false,
      reason: "ACCESS_NOT_STARTED",
      message: "Tu acceso al asistente aún no ha iniciado.",
    };
  }

  if (endsAt && now > endsAt) {
    return {
      ok: false,
      reason: "ACCESS_EXPIRED",
      message: "Tu acceso al asistente ha finalizado.",
    };
  }

  return { ok: true };
}
