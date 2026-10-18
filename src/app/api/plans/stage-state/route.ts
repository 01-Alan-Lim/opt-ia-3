// src/app/api/plans/stage-state/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";
import { assertJsonSizeOrFail } from "@/lib/api/payloadLimit";
import { mergeStageState, normalizeStageState } from "@/lib/plan/stageState";
import {
  canDeleteStageStateGenerically,
  canWriteStageStateGenerically,
  describeGenericWriteRejection,
} from "@/lib/plan/stageAuthority";

export const runtime = "nodejs";

const GetQuerySchema = z.object({
  chatId: z.string().uuid().optional(),
  stage: z.coerce.number().int().min(0),
  latest: z.coerce.boolean().optional().default(false),
});

const UpsertBodySchema = z.object({
  chatId: z.string().uuid(),
  stage: z.number().int().min(0),
  stateJson: z.record(z.string(), z.unknown()),
});

const DeleteBodySchema = z.object({
  chatId: z.string().uuid(),
  stage: z.number().int().min(0),
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

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const parsed = GetQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        "Query inválida.",
        400
      );
    }

    const { chatId, stage, latest } = parsed.data;

    let data:
      | {
          id: string;
          user_id: string;
          chat_id: string;
          stage: number;
          state_json: Record<string, unknown> | null;
          updated_at: string | null;
        }
      | null = null;
    let error: unknown = null;

    if (chatId) {
      const access = await assertChatOwner(user.userId, chatId);
      if (!access.ok) {
        return failResponse(
          access.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
          access.message,
          access.status
        );
      }

      const result = await supabaseServer
        .from("plan_stage_states")
        .select("id, user_id, chat_id, stage, state_json, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", chatId)
        .eq("stage", stage)
        .maybeSingle();

      data = result.data ?? null;
      error = result.error ?? null;
    } else if (latest) {
      const result = await supabaseServer
        .from("plan_stage_states")
        .select("id, user_id, chat_id, stage, state_json, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", stage)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      data = result.data ?? null;
      error = result.error ?? null;
    } else {
      return failResponse("BAD_REQUEST", "Debes enviar chatId o latest=true.", 400);
    }

    if (error) {
      return failResponse("INTERNAL", "No se pudo leer el estado de la etapa.", 500);
    }

    if (!data) {
      return ok({ exists: false, row: null });
    }

    const normalizedRow = {
      ...data,
      state_json: data.state_json ? normalizeStageState(stage, data.state_json) : null,
    };

    return ok({ exists: true, row: normalizedRow });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    if (err instanceof z.ZodError) {
      console.error("[plans] stage-state: estado guardado zod inválido", err.flatten());
      return failResponse(
        "BAD_REQUEST",
        "El estado guardado de la etapa tiene una estructura inválida.",
        400
      );
    }

    return failResponse("INTERNAL", "Error interno", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const raw = await req.json().catch(() => null);
    const parsed = UpsertBodySchema.safeParse(raw);

    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        "Body inválido.",
        400
      );
    }

    const { chatId, stage, stateJson } = parsed.data;

    // Esta ruta corre con service role: ninguna policy de RLS la detiene. Solo acepta las
    // etapas que el cliente guarda por aquí (6 a 10). Las etapas 0 a 5 tienen ruta propia,
    // y esa ruta es la que descarta sus campos de autoridad del servidor (E4: closure,
    // rootCauses, pendingRootMatch…). Sin este filtro, escribir aquí con stage: 4 saltaba
    // esa protección entera.
    if (!canWriteStageStateGenerically(stage)) {
      return failResponse("STAGE_NOT_ALLOWED", describeGenericWriteRejection(stage), 400);
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return failResponse(
        access.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
        access.message,
        access.status
      );
    }

    const existing = await supabaseServer
      .from("plan_stage_states")
      .select("state_json")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", stage)
      .maybeSingle();

    if (existing.error) {
      return failResponse("INTERNAL", "No se pudo leer el estado actual de la etapa.", 500);
    }

    const mergedState = mergeStageState(stage, existing.data?.state_json ?? null, stateJson);

    const tooLarge = assertJsonSizeOrFail({
      value: mergedState,
      maxBytes: 180_000,
      message:
        "Tu avance en esta etapa creció demasiado para guardarse de una sola vez. " +
        "Te pediremos abrir un nuevo chat, pero mantendremos tu progreso.",
    });
    if (tooLarge) return tooLarge;

    const { data, error } = await supabaseServer
      .from("plan_stage_states")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage,
          state_json: mergedState,
        },
        { onConflict: "user_id,chat_id,stage" }
      )
      .select("id, user_id, chat_id, stage, state_json, updated_at")
      .single();

    if (error || !data) {
      return failResponse("INTERNAL", "No se pudo guardar el estado de la etapa.", 500);
    }

    return ok({
      row: {
        ...data,
        state_json: data.state_json ? normalizeStageState(stage, data.state_json) : null,
      },
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    if (err instanceof z.ZodError) {
      console.error("[plans] stage-state: estado recibido zod inválido", err.flatten());
      return failResponse(
        "BAD_REQUEST",
        "El estado recibido para la etapa tiene una estructura inválida.",
        400
      );
    }

    return failResponse("INTERNAL", "Error interno", 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const raw = await req.json().catch(() => null);
    const parsed = DeleteBodySchema.safeParse(raw);

    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        "Body inválido.",
        400
      );
    }

    const { chatId, stage } = parsed.data;

    // Solo el estado de trabajo de las etapas que el cliente limpia al avanzar (2 a 9).
    // E0 y E1 no guardan estado de trabajo aquí. E10 queda fuera a propósito: guarda la
    // evaluación que escribe el servidor, y borrarla permitiría volver a entregar la
    // versión 1 hasta sacar una nota que cierre el plan.
    // No se borra el artefacto validado junto con el estado: ver la nota de abajo.
    if (!canDeleteStageStateGenerically(stage)) {
      return failResponse(
        "STAGE_NOT_ALLOWED",
        `Esta ruta no borra el estado de la Etapa ${stage}.`,
        400
      );
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return failResponse(
        access.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
        access.message,
        access.status
      );
    }

    // Por qué NO se borra también el artefacto validado de la etapa: el borrado del estado
    // es el paso normal al avanzar (chat/page.tsx: clearStageState(N) después de validar
    // la etapa N), cuando el artefacto es justamente lo que hay que conservar. El artefacto
    // es la fuente de verdad de las etapas siguientes (pareto/validate lee ishikawa_final,
    // objectives/validate lee pareto_final…) y el upsert no guarda historial, así que
    // borrarlo destruiría trabajo validado sin vuelta atrás.
    const { error, count } = await supabaseServer
      .from("plan_stage_states")
      .delete({ count: "exact" })
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", stage);

    if (error) {
      return failResponse("INTERNAL", "No se pudo limpiar el estado de la etapa.", 500);
    }

    return ok({ deleted: true, count: count ?? 0 });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    return failResponse("INTERNAL", "Error interno", 500);
  }
}