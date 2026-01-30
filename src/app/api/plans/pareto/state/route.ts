// src/app/api/plans/pareto/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const STAGE = 5;
const ARTIFACT_TYPE = "pareto_wizard_state";
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // "YYYY-MM"

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: z.record(z.string(), z.any()),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const { data, error } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, chat_id, updated_at")
      .eq("user_id", user.userId)
      .eq("stage", STAGE)
      .eq("artifact_type", ARTIFACT_TYPE)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto (Etapa 5).", error);
    if (!data) return NextResponse.json({ ok: true, exists: false }, { status: 200 });

    return NextResponse.json(
      {
        ok: true,
        exists: true,
        chatId: data.chat_id ?? null,
        state: data.payload ?? null,
        updatedAt: data.updated_at ?? null,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId, state } = parsed.data;

    const { error } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId ?? null,
          stage: STAGE,
          artifact_type: ARTIFACT_TYPE,
          period_key: PERIOD_KEY,
          status: "draft",
          payload: state,
        },
        { onConflict: "user_id,stage,artifact_type,period_key" }
      );

    if (error) return fail(500, "DB_ERROR", "No se pudo guardar el estado de Pareto (Etapa 5).", error);

    return NextResponse.json({ ok: true, saved: true }, { status: 200 });
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
