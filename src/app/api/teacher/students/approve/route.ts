import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

const BodySchema = z.object({
  user_id: z.string().min(3).max(200), // soporta uuid y también ids legacy tipo did:privy...
  status: z.enum(["approved", "rejected"]).default("approved"),
});

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes."), { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Payload inválido.", parsed.error.flatten()), {
        status: 400,
      });
    }

    const { user_id, status } = parsed.data;

    const { data, error } = await supabaseServer
      .from("profiles")
      .update({
        registration_status: status,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user_id)
      .select("user_id,email,ru,first_name,last_name,semester,registration_status,cohort_id")
      .single();

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo actualizar el estado.", error), {
        status: 500,
      });
    }

    if (!data) {
      return NextResponse.json(fail("NOT_FOUND", "Estudiante no encontrado."), { status: 404 });
    }

    return ok({ student: data });
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
