import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const { data: profile, error } = await supabaseServer
      .from("profiles")
      .select(
        "user_id,email,role,ru,first_name,last_name,semester,company_name,registration_status,access_starts_at,access_ends_at,cohort_id"
      )
      .eq("user_id", authed.userId)
      .single();

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo cargar el perfil.", error), { status: 500 });
    }

    // Campos mínimos que exigimos para “registro completo”
    const onboardingComplete =
      isNonEmpty(profile.ru) &&
      isNonEmpty(profile.first_name) &&
      isNonEmpty(profile.last_name) &&
      isNonEmpty(profile.semester) &&
      isNonEmpty(profile.cohort_id);

    // Estado de aprobación
    const registrationStatus = (profile.registration_status ?? "pending") as
      | "pending"
      | "approved"
      | "rejected";

    // Ventana de acceso
    const now = Date.now();
    const startsAt = profile.access_starts_at ? new Date(profile.access_starts_at).getTime() : null;
    const endsAt = profile.access_ends_at ? new Date(profile.access_ends_at).getTime() : null;

    const accessNotStarted = startsAt !== null ? now < startsAt : false;
    const accessExpired = endsAt !== null ? now > endsAt : false;

    return ok({
      role: profile.role ?? authed.role,
      onboardingComplete,
      registrationStatus,
      access: {
        starts_at: profile.access_starts_at ?? null,
        ends_at: profile.access_ends_at ?? null,
        not_started: accessNotStarted,
        expired: accessExpired,
      },
      profile: {
        ru: profile.ru ?? null,
        first_name: profile.first_name ?? null,
        last_name: profile.last_name ?? null,
        semester: profile.semester ?? null,
        company_name: profile.company_name ?? null,
        cohort_id: profile.cohort_id ?? null,
      },
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
