// src/app/api/plans/foda/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";

export const runtime = "nodejs";

const STAGE = 2;
const STATE_ARTIFACT = "foda_wizard_state";
const FINAL_ARTIFACT = "foda_analysis";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function extractJsonSafe(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

        const userId = authed.userId;

    const raw = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Body inválido.");
    }

    const requestedChatId = parsed.data.chatId ?? null;


    // 1) Leer estado vivo desde plan_stage_states
    let stateRow: { state_json: Record<string, unknown> | null; chat_id: string | null } | null = null;

    if (requestedChatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id")
        .eq("user_id", userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA.", direct.error);
      }

      stateRow = direct.data ?? null;
    }

    if (!stateRow && !requestedChatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id")
        .eq("user_id", userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) {
        return fail(500, "DB_ERROR", "No se pudo leer el estado FODA.", latest.error);
      }

      stateRow = latest.data ?? null;
    }

    // Compatibilidad temporal: fallback al wizard_state legacy
    let legacyRow: { payload: Record<string, unknown> | null; chat_id: string | null } | null = null;

    if (!stateRow?.state_json) {
      if (requestedChatId) {
        const legacyDirect = await supabaseServer
          .from("plan_stage_artifacts")
          .select("payload, chat_id")
          .eq("user_id", userId)
          .eq("chat_id", requestedChatId)
          .eq("stage", STAGE)
          .eq("artifact_type", STATE_ARTIFACT)
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
          .select("payload, chat_id")
          .eq("user_id", userId)
          .eq("stage", STAGE)
          .eq("artifact_type", STATE_ARTIFACT)
          .eq("period_key", PERIOD_KEY)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (legacyLatest.error) {
          return fail(500, "DB_ERROR", "No se pudo leer el estado FODA legacy.", legacyLatest.error);
        }

        legacyRow = legacyLatest.data ?? null;
      }
    }

    const st = (stateRow?.state_json ?? legacyRow?.payload ?? null) as any;
    const stateChatId = stateRow?.chat_id ?? legacyRow?.chat_id ?? null;

    if (!st) return fail(400, "BAD_REQUEST", "FODA no iniciado.");
    


    const items = st?.items ?? null;

    const count = (q: "F" | "D" | "O" | "A") => (Array.isArray(items?.[q]) ? items[q].length : 0);

    // 2) Validación mínima: 3 por cuadrante + sin evidencia pendiente
    if (st?.pendingEvidence) {
      return fail(400, "BAD_REQUEST", "Falta completar evidencia pendiente antes de validar.", st.pendingEvidence);
    }
    const cF = count("F");
    const cD = count("D");
    const cO = count("O");
    const cA = count("A");

    if (cF < 3 || cD < 3 || cO < 3 || cA < 3) {
      return fail(400, "BAD_REQUEST", "Faltan ítems para completar el FODA (mínimo 3 por cuadrante).", {
        F: cF,
        D: cD,
        O: cO,
        A: cA,
      });
    }

    // 3) Guardar artefacto final validated
    const finalPayload = {
      items: items,
      counts: { F: cF, D: cD, O: cO, A: cA },
    };

    const effectiveChatId = requestedChatId ?? stateChatId ?? null;

    const { data: finalRow, error: finalErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: userId,
          chat_id: effectiveChatId,
          stage: STAGE,
          artifact_type: FINAL_ARTIFACT,
          period_key: PERIOD_KEY,
          status: "validated",
          payload: finalPayload,
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      )
      .select("id")
      .single();

    if (finalErr || !finalRow?.id) {
      return fail(500, "DB_ERROR", "No se pudo guardar el análisis FODA.", finalErr);
    }

    const next = await advancePlanStage({
      userId,
      chatId: effectiveChatId,
      fromStage: STAGE,
    });


    // 4) Evaluación IA (rúbrica estándar que definiste)
    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 2 (Análisis FODA) con la siguiente rúbrica:

- Completitud (30%): mínimo 3 ítems por cuadrante
- Pertinencia al contexto (40%): relacionado con sector/producto/área
- Calidad (30%): clasificación correcta + profundidad + sustento (especialmente O/A)

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "completitud": number,
    "pertinencia": number,
    "calidad": number
  },
  "feedback": "string"
}

ANÁLISIS:
${JSON.stringify(finalPayload, null, 2)}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const evaluation = extractJsonSafe(text);

    if (!evaluation || typeof evaluation.total_score !== "number") {
      return fail(500, "LLM_ERROR", "La IA no devolvió un JSON válido para la evaluación FODA.", { raw: text });
    }

    const insertEval = await supabaseServer.from("plan_stage_evaluations").insert({
      user_id: userId,
      chat_id: effectiveChatId,
      stage: STAGE,
      artifact_type: FINAL_ARTIFACT,
      artifact_id: finalRow.id,
      period_key: PERIOD_KEY,
      rubric_json: {
        completitud: 30,
        pertinencia: 40,
        calidad: 30,
      },
      result_json: evaluation,
      total_score: evaluation.total_score,
      total_label: evaluation.total_label,
    });

    if (insertEval.error) {
      // No bloqueamos el flujo: el FODA ya está validado.
      // Pero devolvemos warning.
      return NextResponse.json(
        {
          ok: true,
          valid: true,
          validated: true,
          score: evaluation.total_score,
          label: evaluation.total_label,
          feedback: evaluation.feedback,
          warning: "FODA validado, pero no se pudo insertar la evaluación.",
          warningDetail: insertEval.error,
          next,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        valid: true,
        validated: true,
        score: evaluation.total_score,
        label: evaluation.total_label,
        feedback: evaluation.feedback,
        next,
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

    const msg = err instanceof Error ? err.message : "INTERNAL";
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
