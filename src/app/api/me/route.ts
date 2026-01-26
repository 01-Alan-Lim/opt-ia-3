// src/app/api/me/route.ts
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail, failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

type RegistrationStatus = "pending" | "approved" | "rejected" | null;

function toDateOrNull(x: unknown): Date | null {
  if (typeof x !== "string" || !x) return null;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const { data: profile, error: profErr } = await supabaseServer
      .from("profiles")
      .select(
        "user_id,email,role,ru,first_name,last_name,semester,company_name,cohort_id,registration_status,access_starts_at,access_ends_at,created_at,updated_at"
      )
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (profErr) {
      return failResponse("INTERNAL", "No se pudo cargar el perfil.", 500, profErr);
    }

    // Gate: si no hay profile o faltan campos mínimos → necesita onboarding
    const needsOnboarding =
      authed.role === "student" &&
      (!profile ||
        !profile.ru ||
        !profile.first_name ||
        !profile.last_name ||
        !profile.semester ||
        !profile.cohort_id);

    const regStatus = (profile?.registration_status as RegistrationStatus) ?? null;

    const pendingApproval =
      authed.role === "student" && !needsOnboarding && regStatus !== "approved";

    const now = new Date();
    const startsAt = toDateOrNull(profile?.access_starts_at);
    const endsAt = toDateOrNull(profile?.access_ends_at);

    // Gate por cohorte activa (FUENTE DE VERDAD: cohorts.is_active)
    let cohortIsActive: boolean | null = null;

    if (authed.role === "student" && profile?.cohort_id) {
      const { data: cohortRow, error: cohErr } = await supabaseServer
        .from("cohorts")
        .select("is_active")
        .eq("id", profile.cohort_id)
        .maybeSingle();

      if (!cohErr && cohortRow) cohortIsActive = !!cohortRow.is_active;
    }


    const beforeStart = startsAt ? now < startsAt : false;
    const afterEnd = endsAt ? now > endsAt : false;

    const accessActive = authed.role !== "student" ? true : !beforeStart && !afterEnd;

    let reason:
      | "OK"
      | "NEEDS_ONBOARDING"
      | "PENDING_APPROVAL"
      | "COHORT_INACTIVE"
      | "ACCESS_NOT_STARTED"
      | "ACCESS_EXPIRED" = "OK";
  

    if (needsOnboarding) reason = "NEEDS_ONBOARDING";
    else if (pendingApproval) reason = "PENDING_APPROVAL";
    else if (cohortIsActive === false) reason = "COHORT_INACTIVE";
    else if (beforeStart) reason = "ACCESS_NOT_STARTED";
    else if (afterEnd) reason = "ACCESS_EXPIRED";

    const canUseChat = authed.role === "student" && reason === "OK";

    // ✅ IMPORTANTE: ok() ya retorna NextResponse.json(...)
    return ok({
      user: { userId: authed.userId, email: authed.email ?? null, role: authed.role },
      profile: profile ?? null,
      gates: {
        needs_onboarding: needsOnboarding,
        pending_approval: pendingApproval,
        access_active: accessActive,
        can_use_chat: canUseChat,
        reason,
        access_starts_at: profile?.access_starts_at ?? null,
        access_ends_at: profile?.access_ends_at ?? null,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido a correos autorizados."), {
        status: 403,
      });
    }

    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
