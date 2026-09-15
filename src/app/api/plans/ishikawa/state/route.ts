// src/app/api/plans/ishikawa/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { assertChatOwner } from "@/lib/auth/chatOwner";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { IshikawaStateInputSchema } from "@/lib/plan/ishikawaTree";
import { compactIshikawaState, mergeClientIshikawaState } from "@/lib/plan/ishikawaStateMerge";
import { loadStoredIshikawaState, writeIshikawaStateRow } from "@/lib/plan/ishikawaStateStore";

const STAGE = 4;
const DraftType = "ishikawa_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

// Reglas globales de E4, fusión y compactación del estado: src/lib/plan/ishikawaStateMerge.ts

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: IshikawaStateInputSchema,
});

const QuerySchema = z.object({
  // chatId es opcional: si no coincide (por ejemplo, nuevo chat), retomamos el último estado del periodo.
  chatId: z.string().uuid().optional(),
});





export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", message: gate.message }, { status: 403 });
    }

    const parsed = QuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    const requestedChatId = parsed.chatId ?? null;

    if (requestedChatId) {
      const access = await assertChatOwner(user.userId, requestedChatId);
      if (!access.ok) {
        return NextResponse.json(
          { ok: false, code: access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: access.message },
          { status: access.status }
        );
      }
    }

    // 1) Fuente principal: plan_stage_states
    let stateRow: {
      state_json: Record<string, unknown> | null;
      chat_id: string | null;
      updated_at: string | null;
    } | null = null;

    if (requestedChatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) {
        console.error("[plans] ishikawa/state: lectura de estado", direct.error);
        return NextResponse.json(fail("BAD_REQUEST", "No se pudo leer el estado de Ishikawa."), { status: 400 });
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
        console.error("[plans] ishikawa/state: lectura de estado", latest.error);
        return NextResponse.json(fail("BAD_REQUEST", "No se pudo leer el estado de Ishikawa."), { status: 400 });
      }

      stateRow = latest.data ?? null;
    }

    if (stateRow?.state_json) {
      const compacted = compactIshikawaState(stateRow.state_json);
      return ok({
        exists: true,
        state: compacted,
        updatedAt: stateRow.updated_at,
        chatId: stateRow.chat_id ?? null,
        source: "stage_state",
      });
    }

    // 2) Compatibilidad temporal: fallback legacy
    let legacyRow: {
      payload: Record<string, unknown> | null;
      chat_id: string | null;
      updated_at: string | null;
      status?: string | null;
    } | null = null;

    if (requestedChatId) {
      const legacyDirect = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at, status")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .maybeSingle();

      if (legacyDirect.error) {
        console.error("[plans] ishikawa/state: lectura legacy", legacyDirect.error);
        return NextResponse.json(fail("BAD_REQUEST", "No se pudo leer el estado de Ishikawa."), { status: 400 });
      }

      legacyRow = legacyDirect.data ?? null;
    }

    if (!legacyRow && !requestedChatId) {
      const legacyLatest = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at, status")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (legacyLatest.error) {
        console.error("[plans] ishikawa/state: lectura legacy", legacyLatest.error);
        return NextResponse.json(fail("BAD_REQUEST", "No se pudo leer el estado de Ishikawa."), { status: 400 });
      }

      legacyRow = legacyLatest.data ?? null;
    }

    if (!legacyRow?.payload) return ok({ exists: false });

    const compacted = compactIshikawaState(legacyRow.payload);

    return ok({
      exists: true,
      state: compacted,
      updatedAt: legacyRow.updated_at,
      chatId: legacyRow.chat_id ?? null,
      status: legacyRow.status ?? null,
      source: "legacy_artifact",
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN_DOMAIN", "Correo no permitido."), { status: 403 });
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return NextResponse.json(
        fail(
          "AUTH_UPSTREAM_TIMEOUT",
          "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
        ),
        { status: 503 }
      );
    }

    if (err instanceof z.ZodError) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Payload inválido."),
        { status: 400 }
      );
    }

    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}




export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", message: gate.message }, { status: 403 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Payload inválido"), { status: 400 });
    }

    const { chatId, state } = parsed.data;

    if (!chatId) {
      return NextResponse.json(
        {
          ok: true,
          saved: false,
          skipped: true,
          message: "Ishikawa state skip: chatId aún no inicializado.",
        },
        { status: 200 }
      );
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return NextResponse.json(
        { ok: false, code: access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: access.message },
        { status: access.status }
      );
    }

    const stored = await loadStoredIshikawaState(user.userId, chatId);

    if (!stored.ok) {
      console.error("[plans] ishikawa/state: lectura previa", stored.error);
      return NextResponse.json(fail("BAD_REQUEST", "No se pudo leer el estado de Ishikawa."), { status: 400 });
    }

    // closure, rejectedWhyAttempts, reformulateWhy y el registro de raíces son de autoridad
    // del servidor (los escribe ishikawa/assistant): los del cliente se descartan y se
    // conservan los almacenados, de la fila de este chat o, si todavía no existe, de la
    // última fila de E4 del usuario.
    const mergedState = compactIshikawaState(
      mergeClientIshikawaState(stored.value.exact, state, stored.value.serverSource)
    );

    const saved = await writeIshikawaStateRow(user.userId, chatId, mergedState);

    if (!saved.ok) {
      console.error("[plans] ishikawa/state: guardado de estado", saved.error);
      return NextResponse.json(fail("BAD_REQUEST", "No se pudo guardar el estado de Ishikawa."), { status: 400 });
    }

    return ok({ saved: true });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN_DOMAIN", "Correo no permitido."), { status: 403 });
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return NextResponse.json(
        fail(
          "AUTH_UPSTREAM_TIMEOUT",
          "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
        ),
        { status: 503 }
      );
    }

    if (err instanceof z.ZodError) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Payload inválido."),
        { status: 400 }
      );
    }

    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}