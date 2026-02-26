// src/app/api/integrations/google-calendar/store/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

const BodySchema = z.object({
  refresh_token: z.string().min(10),
  scope: z.string().optional(),
  calendar_id: z.string().min(1).optional(), // default "primary"
});

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const { refresh_token, scope, calendar_id } = parsed.data;

    // Guardar/actualizar token (NO confiar en userId del cliente)
    const { error } = await supabaseServer
      .from("user_google_calendar_tokens")
      .upsert(
        {
          user_id: authed.userId,
          email: authed.email ?? null,
          calendar_id: calendar_id ?? "primary",
          provider: "google",
          scope: scope ?? null,
          refresh_token,
        },
        { onConflict: "user_id" }
      );

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar token de calendario.", error), {
        status: 500,
      });
    }

    return ok({ connected: true });
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
