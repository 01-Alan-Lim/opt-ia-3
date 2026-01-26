// src/app/api/teacher/cohorts/list/route.ts
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

/**
 * GET /api/teacher/cohorts/list
 * Lista cohortes (solo docente).
 */
export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes pueden ver cohortes."), { status: 403 });
    }

    const { data, error } = await supabaseServer
      .from("cohorts")
      .select("id, name, is_active, registration_opens_at, access_starts_at, access_ends_at, hours_start_at, form_initial_url, form_monthly_url, form_final_url, reminder_hour, reminder_minute, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo listar cohortes.", error), { status: 500 });
    }

    return ok({ cohorts: data ?? [] });
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
