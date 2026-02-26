// src/app/api/plans/progress/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const STAGE = 9;

const GetQuerySchema = z.object({
  chatId: z.string().uuid(),
});

const UpsertBodySchema = z.object({
  chatId: z.string().uuid(),
  stateJson: z.record(z.string(), z.unknown()),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const parsed = GetQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida.");
    }

    const { chatId } = parsed.data;

    const { data, error } = await supabaseServer
      .from("plan_stage_states")
      .select("id, user_id, chat_id, stage, state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Etapa 9.", error);

    return NextResponse.json({ ok: true, data: { exists: !!data, row: data ?? null } });
  } catch (e: unknown) {
    const msg = (e as any)?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = UpsertBodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Body inválido.");
    }

    const { chatId, stateJson } = parsed.data;

    const { data, error } = await supabaseServer
      .from("plan_stage_states")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          state_json: stateJson,
        },
        { onConflict: "user_id,chat_id,stage" }
      )
      .select("id, user_id, chat_id, stage, state_json, updated_at")
      .single();

    if (error || !data) return fail(500, "DB_ERROR", "No se pudo guardar estado de Etapa 9.", error);

    return NextResponse.json({ ok: true, data: { row: data } });
  } catch (e: unknown) {
    const msg = (e as any)?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
