// src/app/api/plans/progress/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const STAGE = 9;
const FinalType = "progress_final";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid(),
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

function safeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

function clampPercent(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");

    const { chatId } = parsed.data;

    // 1) Requiere Etapa 8 validada (planning_final)
    const { data: planningFinal, error: planErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", 8)
      .eq("artifact_type", "planning_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (planErr) return fail(500, "DB_ERROR", "No se pudo leer Planificación final (Etapa 8).", planErr);
    if (!planningFinal?.payload) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para validar Etapa 9 necesitas Etapa 8 (Planificación) validada.",
      });
    }

    // 2) Leer estado Etapa 9
    const { data: stRow, error: stErr } = await supabaseServer
      .from("plan_stage_states")
      .select("state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (stErr) return fail(500, "DB_ERROR", "No se pudo leer el estado de Etapa 9.", stErr);
    if (!stRow?.state_json) {
      return NextResponse.json({ ok: true, valid: false, message: "No hay estado guardado de Etapa 9." });
    }

    const s: any = stRow.state_json;

    // 3) Gate mínimo: reporte + porcentaje
    const reportText = String(s?.reportText ?? "").trim();
    const progressPercentRaw = safeNumber(s?.progressPercent);
    const progressPercent = progressPercentRaw === null ? null : clampPercent(progressPercentRaw);

    if (!reportText || reportText.length < 20) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Tu reporte está muy corto. Describe en 5–8 líneas qué lograste implementar hasta hoy.",
      });
    }

    if (progressPercent === null) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Falta estimar el porcentaje de avance (0–100) para cerrar Etapa 9.",
      });
    }

    const measurementNote = String(s?.measurementNote ?? "").trim() || null;
    const summary = String(s?.summary ?? "").trim() || null;

    // 4) Evaluación pedagógica (70/30) - sin pedir evidencia
    const rubric = {
      coherencia_avance: 70,
      medicion_verificacion: 30,
    };

    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 9 (Reporte de avances). Debes ser estricto con coherencia y realismo del porcentaje.

RÚBRICA (0-100):
1) Coherencia y avance respecto al plan (70%):
   - El reporte se relaciona con lo planificado (Etapa 8) y se entiende qué se hizo y qué falta.
   - El porcentaje es razonable respecto a lo descrito (evitar 90-100 sin sustento).
2) Medición / verificación (30%):
   - Menciona cómo verificó o verificará el avance (texto simple).
   - Si aún no midió, lo reconoce y propone verificación mínima.

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "coherencia_avance": number,
    "medicion_verificacion": number
  },
  "feedback": "string",
  "mejoras": ["string", "string", "string"]
}

PLAN (Etapa 8):
${JSON.stringify(planningFinal.payload, null, 2)}

REPORTE (Etapa 9):
${JSON.stringify(
  {
    reportText,
    progressPercent,
    measurementNote,
    summary,
  },
  null,
  2
)}
`;

    let evaluation: any = null;
    let evalWarning: { warning: string; raw?: string } | null = null;

    try {
      const llmRes = await model.generateContent(prompt);
      const llmText = llmRes.response.text();
      evaluation = extractJsonSafe(llmText);

      if (!evaluation || typeof evaluation.total_score !== "number") {
        evalWarning = { warning: "Etapa 9 validada, pero la IA no devolvió un JSON válido.", raw: llmText };
        evaluation = null;
      }
    } catch {
      evalWarning = { warning: "Etapa 9 validada, pero falló la evaluación IA." };
      evaluation = null;
    }

    const score = evaluation?.total_score ?? 80;

    // 5) Guardar artifact final Etapa 9
    const finalPayload = {
      fromStage8: {
        planningUpdatedAt: planningFinal?.updated_at ?? null,
      },
      report: {
        text: reportText,
        progressPercent,
        measurementNote,
        summary,
      },
      validatedAt: new Date().toISOString(),
    };

    const { data: finalRow, error: upErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: FinalType,
          period_key: PERIOD_KEY,
          status: "validated",
          payload: finalPayload,
          score,
          updated_at: new Date().toISOString(),
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      )
      .select("id")
      .single();

    if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo guardar reporte final de Etapa 9.", upErr);
    const finalArtifactId = finalRow.id as string;

    // 6) Insertar evaluación solo si no existe
    if (evaluation && typeof evaluation.total_score === "number") {
      const { data: existingEval, error: existingEvalErr } = await supabaseServer
        .from("plan_stage_evaluations")
        .select("id")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", FinalType)
        .eq("period_key", PERIOD_KEY)
        .eq("artifact_id", finalArtifactId)
        .maybeSingle();

      if (!existingEvalErr && !existingEval) {
        const { error: evalInsErr } = await supabaseServer.from("plan_stage_evaluations").insert({
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: FinalType,
          artifact_id: finalArtifactId,
          period_key: PERIOD_KEY,
          rubric_json: rubric,
          result_json: evaluation,
          total_score: evaluation.total_score,
          total_label: evaluation.total_label,
        });

        if (evalInsErr) {
          evalWarning = { warning: "Etapa 9 validada, pero no se pudo insertar la evaluación IA." };
        }
      }
    }

    return NextResponse.json({
      ok: true,
      valid: true,
      message: "Etapa 9 (Reporte de avances) finalizada. ✅",
      final: finalPayload,
      score,
      progressPercent,
      evaluation: evaluation && typeof evaluation.total_score === "number" ? evaluation : null,
      ...(evalWarning ? { warning: evalWarning.warning, warningRaw: evalWarning.raw } : {}),
      next: { stage: 10 },
    });
  } catch (e: unknown) {
    const msg = (e as any)?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    if (msg === "FORBIDDEN_DOMAIN") return fail(403, "FORBIDDEN_DOMAIN", "Dominio no permitido.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
