import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

const QuerySchema = z.object({
  cohortId: z.string().uuid().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  q: z.string().min(1).max(80).optional(), // ru o nombre
});

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes."), { status: 403 });
    }

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      cohortId: url.searchParams.get("cohortId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Parámetros inválidos.", parsed.error.flatten()), {
        status: 400,
      });
    }

    const { cohortId, status, q } = parsed.data;

    let query = supabaseServer
      .from("profiles")
      .select("user_id,email,role,ru,first_name,last_name,semester,company_name,registration_status,cohort_id,created_at,updated_at")
      .eq("role", "student")
      .order("created_at", { ascending: false })
      .limit(200);

    if (cohortId) query = query.eq("cohort_id", cohortId);
    if (status) query = query.eq("registration_status", status);

    // búsqueda simple (MVP) por RU o nombres
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      query = query.or(
        `ru.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`
      );
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo cargar estudiantes.", error), {
        status: 500,
      });
    }

    return ok({ students: data ?? [] });
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
