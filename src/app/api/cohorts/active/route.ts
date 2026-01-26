import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    await requireUser(req); // solo verificar que está autenticado

    const now = new Date().toISOString();

    const { data, error } = await supabaseServer
      .from("cohorts")
      .select("id,name,is_active,registration_opens_at,access_starts_at,access_ends_at,created_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo cargar cohortes.", error), { status: 500 });
    }

    const cohorts =
      (data ?? []).map((c) => {
        const opensAt = c.registration_opens_at ? new Date(c.registration_opens_at).toISOString() : null;
        const isRegistrationOpen = !opensAt || opensAt <= now;

        return {
          ...c,
          registration_open: isRegistrationOpen,
        };
      }) ?? [];

    return ok({ cohorts });
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
