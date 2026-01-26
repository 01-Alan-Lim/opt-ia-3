import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

type Role = "student" | "teacher";

export async function POST(req: Request) {
  try {
    // ✅ Autoridad única para rol/dominio/test allowlist
    const authed = await requireUser(req);
    const email = authed.email?.toLowerCase() ?? null;
    const role: Role = authed.role;

    // ✅ Guardar perfil (o actualizar) con el rol final
    const { data, error } = await supabaseServer
      .from("profiles")
      .upsert({ user_id: authed.userId, email, role }, { onConflict: "user_id" })
      .select("role")
      .single();

    if (error) {
      return NextResponse.json(
        fail("PROFILE_UPSERT_FAILED", "No se pudo guardar perfil.", error),
        { status: 500 }
      );
    }

    const finalRole = (data?.role as Role | null) ?? role;
    return ok({ role: finalRole });

  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        fail("FORBIDDEN", "Acceso restringido a correos autorizados."),
        { status: 403 }
      );
    }

    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
