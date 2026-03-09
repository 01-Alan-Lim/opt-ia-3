// src/app/api/plans/brainstorm/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";

export const runtime = "nodejs";

const STAGE = 3;
const STATE_ARTIFACT = "brainstorm_wizard_state";
const FINAL_ARTIFACT = "brainstorm_ideas";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z
  .object({
    chatId: z.string().uuid().optional(),
  })
  .optional();

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

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN", message: gate.message },
        { status: 403 }
      );
    }

    const userId = authed.userId;

    const bodyRaw = await req.json().catch(() => ({}));
    const body = BodySchema.parse(bodyRaw);
    const chatId = body?.chatId ?? null;


   
        // 1) Leer estado vivo desde plan_stage_states
    let stateRow: { state_json: Record<string, unknown> | null; chat_id: string | null } | null = null;

    if (chatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id")
        .eq("user_id", userId)
        .eq("chat_id", chatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) {
        return NextResponse.json(
          { ok: false, message: "No se pudo leer el estado de Etapa 3", detail: direct.error.message },
          { status: 500 }
        );
      }

      stateRow = direct.data ?? null;
    }

    if (!stateRow && !chatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id")
        .eq("user_id", userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) {
        return NextResponse.json(
          { ok: false, message: "No se pudo leer el estado de Etapa 3", detail: latest.error.message },
          { status: 500 }
        );
      }

      stateRow = latest.data ?? null;
    }

    // Compatibilidad temporal: fallback al wizard_state legacy
    let legacyRow: { payload: Record<string, unknown> | null; chat_id: string | null } | null = null;

    if (!stateRow?.state_json) {
      if (chatId) {
        const legacyDirect = await supabaseServer
          .from("plan_stage_artifacts")
          .select("payload, chat_id")
          .eq("user_id", userId)
          .eq("chat_id", chatId)
          .eq("stage", STAGE)
          .eq("artifact_type", STATE_ARTIFACT)
          .eq("period_key", PERIOD_KEY)
          .maybeSingle();

        if (legacyDirect.error) {
          return NextResponse.json(
            { ok: false, message: "No se pudo leer el estado legacy de Etapa 3", detail: legacyDirect.error.message },
            { status: 500 }
          );
        }

        legacyRow = legacyDirect.data ?? null;
      }

      if (!legacyRow && !chatId) {
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
          return NextResponse.json(
            { ok: false, message: "No se pudo leer el estado legacy de Etapa 3", detail: legacyLatest.error.message },
            { status: 500 }
          );
        }

        legacyRow = legacyLatest.data ?? null;
      }
    }

    const st = (stateRow?.state_json ?? legacyRow?.payload ?? null) as any;
    const stateChatId = stateRow?.chat_id ?? legacyRow?.chat_id ?? null;


    if (!st) {
      return NextResponse.json({ ok: false, message: "Etapa 3 no iniciada" }, { status: 400 });
    }

    const problemText = String(st?.problem?.text ?? "").trim();
    const ideas = Array.isArray(st?.ideas) ? st.ideas : [];
    const minIdeas = Number(st?.minIdeas ?? 10);

    if (!problemText) {
      return NextResponse.json({ ok: false, message: "Falta definir la problemática principal." }, { status: 400 });
    }
    if (ideas.length < minIdeas) {
      return NextResponse.json(
        { ok: false, message: `Faltan ideas: tienes ${ideas.length} y el mínimo es ${minIdeas}.` },
        { status: 400 }
      );
    }

    // 2) Guardar artefacto final (validated)
    const finalPayload = { problem: { text: problemText }, ideas };

    const effectiveChatId = chatId ?? stateChatId ?? null;

    const { data: finalArtifact, error: finalErr } = await supabaseServer
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
          updated_at: new Date().toISOString(),
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      )
      .select("id")
      .single();

    const finalArtifactId = finalArtifact?.id;

    if (finalErr || !finalArtifactId) {
      return NextResponse.json(
        { ok: false, message: "No se pudo guardar el artefacto final de Etapa 3", detail: finalErr?.message },
        { status: 500 }
      );
    }

    // 3) Evaluación IA (rúbrica mínima E3)
    const model = getGeminiModel();

    const prompt = `
Evalúa académicamente la Etapa 3 (Lluvia de ideas de causas).

CRITERIOS (mínimos):
1) Alineación con la problemática (40%)
2) Claridad / no ambigüedad (30%)
3) Variedad y profundidad (30%)

Escala:
- Deficiente
- Regular
- Adecuado
- Bien

Devuelve JSON:
{
  total_score: number (0-100),
  total_label: string,
  detail: {
    alineacion: number,
    claridad: number,
    profundidad: number
  },
  feedback: string
}

ENTREGA DEL ESTUDIANTE:
${JSON.stringify(finalPayload, null, 2)}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const evaluation = extractJsonSafe(text);

    if (!evaluation || typeof evaluation.total_score !== "number") {
      return NextResponse.json(
        { ok: false, message: "La IA no devolvió un JSON válido para la evaluación de Etapa 3", raw: text },
        { status: 500 }
      );
    }

    // ✅ Insertar evaluación solo si no existe (NO duplicar)
    const { data: existingEval, error: existingEvalErr } = await supabaseServer
      .from("plan_stage_evaluations")
      .select("id")
      .eq("user_id", userId)
      .eq("stage", STAGE)
      .eq("artifact_type", FINAL_ARTIFACT)
      .eq("period_key", PERIOD_KEY)
      .eq("artifact_id", finalArtifactId)
      .maybeSingle();

    if (existingEvalErr) {
      return NextResponse.json(
        { ok: false, message: "No se pudo verificar evaluación existente", detail: existingEvalErr.message },
        { status: 500 }
      );
    }

    if (!existingEval) {
      const { error: evalInsErr } = await supabaseServer.from("plan_stage_evaluations").insert({
        user_id: userId,
        chat_id: effectiveChatId,
        stage: STAGE,
        artifact_type: FINAL_ARTIFACT,
        artifact_id: finalArtifactId,
        period_key: PERIOD_KEY,
        rubric_json: {
          alineacion: 40,
          claridad: 30,
          profundidad: 30,
        },
        result_json: evaluation,
        total_score: evaluation.total_score,
        total_label: evaluation.total_label,
      });

      if (evalInsErr) {
        return NextResponse.json(
          { ok: false, message: "No se pudo insertar evaluación de Etapa 3", detail: evalInsErr.message },
          { status: 500 }
        );
      }
    }

    const next = await advancePlanStage({
      userId,
      chatId: effectiveChatId,
      fromStage: STAGE,
    });



    return NextResponse.json({
      ok: true,
      valid: true,
      artifactId: finalArtifactId,
      score: evaluation.total_score,
      label: evaluation.total_label,
      feedback: evaluation.feedback,
      next,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e.message || "Error validando Etapa 3" }, { status: 500 });
  }
}
