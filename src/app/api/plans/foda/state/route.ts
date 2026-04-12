// src/app/api/plans/foda/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const STAGE = 2;
const LEGACY_ARTIFACT_TYPE = "foda_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

const FodaQuadrantSchema = z.enum(["F", "D", "O", "A"]);

const FodaItemSchema = z.object({
  text: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1200).optional(),
});

const FodaStateSchema = z.object({
  currentQuadrant: FodaQuadrantSchema,
  items: z.object({
    F: z.array(FodaItemSchema),
    D: z.array(FodaItemSchema),
    O: z.array(FodaItemSchema),
    A: z.array(FodaItemSchema),
  }),
  pendingEvidence: z
    .object({
      quadrant: FodaQuadrantSchema,
      index: z.number().int().min(0).max(20),
    })
    .nullable()
    .optional(),
});

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: FodaStateSchema,
});

const QuerySchema = z.object({
  chatId: z.string().uuid().optional(),
});

type FodaStateRow = {
  state_json: Record<string, unknown> | null;
  chat_id: string | null;
  updated_at: string | null;
};

function parseIsoMillis(value: string | null | undefined) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function getStatePriority(stateJson: Record<string, unknown> | null) {
  if (!stateJson || typeof stateJson !== "object") return -1;

  const rawItems =
    stateJson.items && typeof stateJson.items === "object"
      ? (stateJson.items as Record<string, unknown>)
      : null;

  if (!rawItems) return -1;

  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

  const counts = {
    F: count(rawItems.F),
    D: count(rawItems.D),
    O: count(rawItems.O),
    A: count(rawItems.A),
  };

  const totalItems = counts.F + counts.D + counts.O + counts.A;
  const completedQuadrants = [counts.F, counts.D, counts.O, counts.A].filter(
    (items) => items >= 3
  ).length;

  return totalItems * 100 + completedQuadrants * 10;
}

function pickBestRow(rows: FodaStateRow[]) {
  return [...rows].sort((a, b) => {
    const priorityDiff = getStatePriority(b.state_json) - getStatePriority(a.state_json);
    if (priorityDiff !== 0) return priorityDiff;

    return parseIsoMillis(b.updated_at) - parseIsoMillis(a.updated_at);
  })[0] ?? null;
}

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

    const gate = await assertChatAccess(req, user);
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
    let stateRow: FodaStateRow | null = null;

    if (requestedChatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA.", direct.error);
      }

      stateRow = direct.data ?? null;
    }

    // 2) Fallback al mejor state de la etapa (cualquier chat del usuario)
    if (!stateRow && !requestedChatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(25);

      if (latest.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA.", latest.error);
      }

      stateRow = latest.data?.length ? pickBestRow(latest.data as FodaStateRow[]) : null;
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

    // 3) Compatibilidad temporal: fallback legacy desde artifacts
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
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA legacy.", legacyDirect.error);
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
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA legacy.", legacyLatest.error);
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
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return fail(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
      );
    }

    if (err instanceof z.ZodError) {
      return fail(400, "BAD_REQUEST", err.issues[0]?.message ?? "Payload inválido.", err.flatten());
    }

    return fail(500, "INTERNAL", "Error interno.");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
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
          message: "FODA state skip: chatId aún no inicializado.",
        },
        { status: 200 }
      );
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return fail(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message);
    }

    const existing = await supabaseServer
      .from("plan_stage_states")
      .select("state_json")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (existing.error) {
      return fail(500, "DB_ERROR", "No se pudo leer el estado actual.", existing.error);
    }

    const mergedState = FodaStateSchema.parse(state);

    const { error } = await supabaseServer
      .from("plan_stage_states")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          state_json: mergedState,
        },
        { onConflict: "user_id,chat_id,stage" }
      );

    if (error) return fail(500, "DB_ERROR", "No se pudo guardar el estado FODA.", error);

    return NextResponse.json({ ok: true, saved: true }, { status: 200 });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return fail(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
      );
    }

    if (err instanceof z.ZodError) {
      return fail(400, "BAD_REQUEST", err.issues[0]?.message ?? "Payload inválido.", err.flatten());
    }

    return fail(500, "INTERNAL", "Error interno.");
  }
}