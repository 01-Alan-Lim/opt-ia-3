// src/app/api/plans/objectives/state/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

const STAGE = 6;

const GetQuerySchema = z.object({
  chatId: z.string().uuid(),
});

const UpsertBodySchema = z.object({
  chatId: z.string().uuid(),
  stateJson: z.record(z.string(), z.any()),
});

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

    const parsed = GetQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams)
    );
    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Query inválida.",
        400
      );
    }

    const { chatId } = parsed.data;

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return failResponse(access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message, access.status);
    }

    const { data, error } = await supabaseServer
      .from("plan_stage_states")
      .select("id, user_id, chat_id, stage, state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (error) {
      return failResponse("INTERNAL", "No se pudo leer el estado de la Etapa 6.", 500);
    }

    return ok({ exists: !!data, row: data ?? null });
  } catch (err: any) {
    if (err?.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }
    return failResponse("INTERNAL", "Error interno", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const raw = await req.json().catch(() => null);
    const parsed = UpsertBodySchema.safeParse(raw);
    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Body inválido.",
        400
      );
    }

    const { chatId, stateJson } = parsed.data;

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return failResponse(access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message, access.status);
    }

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

    if (error || !data) {
      return failResponse("INTERNAL", "No se pudo guardar el estado de la Etapa 6.", 500);
    }

    return ok({ row: data });
  } catch (err: any) {
    if (err?.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }
    return failResponse("INTERNAL", "Error interno", 500);
  }
}
