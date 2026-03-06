// src/app/api/plans/brainstorm/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const STAGE = 3;
const LEGACY_ARTIFACT_TYPE = "brainstorm_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: z.record(z.string(), z.any()),
});

const QuerySchema = z.object({
  chatId: z.string().uuid().optional(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

async function assertChatOwner(userId: string, chatId: string) {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (chatErr || !chatRow) {
    return { ok: false as const, status: 404, message: "Chat no encontrado." };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false as const, status: 403, message: "No tienes acceso a este chat." };
  }

  return { ok: true as const };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const parsed = QuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams)
    );
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida.");
    }

    const requestedChatId = parsed.data.chatId ?? null;

    if (requestedChatId) {
      const access = await assertChatOwner(user.userId, requestedChatId);
      if (!access.ok) {
        return fail(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message);
      }
    }

    // 1) Fuente principal: plan_stage_states
    let stateRow: { state_json: Record<string, unknown> | null; chat_id: string | null; updated_at: string | null } | null = null;

    if (requestedChatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado de Etapa 3.", direct.error);
      }

      stateRow = direct.data ?? null;
    }

    if (!stateRow && !requestedChatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado de Etapa 3.", latest.error);
      }

      stateRow = latest.data ?? null;
    }

    if (stateRow?.state_json) {
      return NextResponse.json(
        {
          ok: true,
          exists: true,
          chatId: stateRow.chat_id ?? null,
          state: stateRow.state_json,
          updatedAt: stateRow.updated_at ?? null,
          source: "stage_state",
        },
        { status: 200 }
      );
    }

    // 2) Compatibilidad temporal: fallback legacy desde artifacts
    let legacyRow: { payload: Record<string, unknown> | null; chat_id: string | null; updated_at: string | null } | null = null;

    if (requestedChatId) {
      const legacyDirect = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .eq("artifact_type", LEGACY_ARTIFACT_TYPE)
        .eq("period_key", PERIOD_KEY)
        .maybeSingle();

      if (legacyDirect.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Etapa 3.", legacyDirect.error);
      }

      legacyRow = legacyDirect.data ?? null;
    }

    if (!legacyRow && !requestedChatId) {
      const legacyLatest = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", LEGACY_ARTIFACT_TYPE)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (legacyLatest.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Etapa 3.", legacyLatest.error);
      }

      legacyRow = legacyLatest.data ?? null;
    }

    if (!legacyRow?.payload) {
      return NextResponse.json({ ok: true, exists: false }, { status: 200 });
    }

    return NextResponse.json(
      {
        ok: true,
        exists: true,
        chatId: legacyRow.chat_id ?? null,
        state: legacyRow.payload,
        updatedAt: legacyRow.updated_at ?? null,
        source: "legacy_artifact",
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

    if (!chatId) {
      return NextResponse.json(
        {
          ok: true,
          saved: false,
          skipped: true,
          message: "Brainstorm state skip: chatId aún no inicializado.",
        },
        { status: 200 }
      );
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return fail(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message);
    }

    const { error } = await supabaseServer
      .from("plan_stage_states")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          state_json: state,
        },
        { onConflict: "user_id,chat_id,stage" }
      );

    if (error) return fail(500, "DB_ERROR", "No se pudo guardar el estado de Etapa 3.", error);

    return NextResponse.json({ ok: true, saved: true }, { status: 200 });
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}