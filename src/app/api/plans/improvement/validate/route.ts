// src/app/api/plans/improvement/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import {
  loadLatestStageStateByChat,
  loadLatestValidatedArtifact,
} from "@/lib/plan/stageValidation";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";



export const runtime = "nodejs";

const STAGE = 7;
const FinalType = "improvement_final";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function nonEmptyTrimmed(v: unknown): string {
  return String(v ?? "").trim();
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
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

type Initiative = {
  id?: string;
  title?: unknown;
  description?: unknown;
  linkedRoot?: unknown;
  linkedObjective?: unknown;
  measurement?: { indicator?: unknown; kpi?: unknown; target?: unknown };
  feasibility?: { estimatedWeeks?: unknown; notes?: unknown };
};

function parseWeeks(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n > 52) return null;
  return n;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId } = parsed.data;

    // 1) Leer Pareto final validado (Etapa 5) para causas críticas oficiales
    const paretoResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 5,
      artifactType: "pareto_final",
      periodKey: PERIOD_KEY,
    });

    if (!paretoResult.ok) {
      return fail(500, "DB_ERROR", "No se pudo leer Pareto final (Etapa 5).", paretoResult.error);
    }

    const paretoFinal = paretoResult.row;
    const criticalRootsOfficial = asStringArray(paretoFinal?.payload?.criticalRoots);

    if (criticalRootsOfficial.length === 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para validar Etapa 7 primero debes tener Pareto final validado con causas críticas (top 20%).",
      });
    }

    // 2) Leer Objectives final validado (Etapa 6)
    const objectivesResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 6,
      artifactType: "objectives_final",
      periodKey: PERIOD_KEY,
    });

    if (!objectivesResult.ok) {
      return fail(500, "DB_ERROR", "No se pudo leer Objectives final (Etapa 6).", objectivesResult.error);
    }

    const objectivesFinal = objectivesResult.row;
    const objectivesPayload = objectivesFinal?.payload as
      | { generalObjective?: unknown; specificObjectives?: unknown; linkedCriticalRoots?: unknown }
      | undefined;

    const generalObjective = nonEmptyTrimmed(objectivesPayload?.generalObjective);
    const specificObjectives = asStringArray(objectivesPayload?.specificObjectives);
    const linkedCriticalRoots = asStringArray(objectivesPayload?.linkedCriticalRoots);

    if (!generalObjective || specificObjectives.length < 1 || linkedCriticalRoots.length < 1) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para validar Etapa 7 necesitas Objetivos (Etapa 6) validados.",
      });
    }

    // 3) Leer estado actual de la Etapa 7 desde plan_stage_states
    const stResult = await loadLatestStageStateByChat({
      userId: user.userId,
      chatId,
      stage: STAGE,
    });

    if (!stResult.ok) {
      return fail(500, "DB_ERROR", "No se pudo leer el estado de la Etapa 7.", stResult.error);
    }

    if (!stResult.row?.state_json) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "No hay estado guardado de la Etapa 7 (Plan de Mejora).",
      });
    }

    const s = stResult.row.state_json as Record<string, unknown>;


    const initiativesRaw: Initiative[] = Array.isArray(s?.initiatives) ? s.initiatives : [];

    // 4) Gate mínimo (cierre coherente)
    if (initiativesRaw.length < 2) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Tu Plan de Mejora aún es muy corto. Define al menos 2 iniciativas/acciones concretas.",
      });
    }

    const initiatives = initiativesRaw.map((it, idx) => {
      const title = nonEmptyTrimmed(it?.title);
      const description = nonEmptyTrimmed(it?.description);
      const linkedRoot = nonEmptyTrimmed(it?.linkedRoot) || null;
      const linkedObjective = nonEmptyTrimmed(it?.linkedObjective) || null;

      const indicator = nonEmptyTrimmed(it?.measurement?.indicator) || null;
      const kpi = nonEmptyTrimmed(it?.measurement?.kpi) || null;
      const target = nonEmptyTrimmed(it?.measurement?.target) || null;

      const estimatedWeeks = parseWeeks(it?.feasibility?.estimatedWeeks);
      const feasibilityNotes = nonEmptyTrimmed(it?.feasibility?.notes) || null;

      return {
        index: idx,
        title,
        description,
        linkedRoot,
        linkedObjective,
        measurement: { indicator, kpi, target },
        feasibility: { estimatedWeeks, notes: feasibilityNotes },
      };
    });

    const missingTitles = initiatives.filter((x) => x.title.length < 6).map((x) => x.index + 1);
    if (missingTitles.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas iniciativas están muy incompletas. Pon un título claro (mínimo ~6 caracteres).",
        detail: { initiativesMissingTitle: missingTitles },
      });
    }

    const missingMeasurement = initiatives
      .filter((x) => !x.measurement.indicator && !x.measurement.kpi)
      .map((x) => x.index + 1);
    if (missingMeasurement.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "A tu plan le falta una forma simple de medir avance. Para cada iniciativa define al menos un indicador (puede ser cualitativo).",
        detail: { initiativesMissingMeasurement: missingMeasurement },
      });
    }

    const missingObjectiveLink = initiatives.filter((x) => !x.linkedObjective).map((x) => x.index + 1);
    if (missingObjectiveLink.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para cerrar Etapa 7, vincula cada iniciativa a un Objetivo Específico (Etapa 6).",
        detail: { initiativesMissingObjectiveLink: missingObjectiveLink },
      });
    }

    const specificSet = new Set(specificObjectives);
    const invalidObjectiveLinks = initiatives
      .filter((x) => x.linkedObjective && !specificSet.has(x.linkedObjective))
      .map((x) => ({ initiative: x.index + 1, linkedObjective: x.linkedObjective }));

    if (invalidObjectiveLinks.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "Algunas iniciativas están vinculadas a objetivos que no coinciden con tus Objetivos Específicos validados (Etapa 6).",
        detail: { invalidObjectiveLinks },
      });
    }

    const linkedSet = new Set(linkedCriticalRoots);
    const covered = new Set(
      initiatives.map((x) => x.linkedRoot).filter((r): r is string => !!r && linkedSet.has(r))
    );

    const missingCoverage = linkedCriticalRoots.filter((r) => !covered.has(r));
    if (missingCoverage.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "Tu plan aún no cubre todas las causas críticas vinculadas a tus objetivos. Agrega o ajusta iniciativas para cubrirlas.",
        detail: { missingCoverage },
      });
    }

    const weeks = initiatives
      .map((x) => x.feasibility.estimatedWeeks)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

    const totalWeeks = weeks.length > 0 ? weeks.reduce((a, b) => a + b, 0) : null;
    if (totalWeeks !== null && totalWeeks > 7) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "Por tiempo de práctica, tu plan parece demasiado largo. Ajusta el alcance para que sea viable en ~4 a 6 semanas.",
        detail: { totalWeeks },
      });
    }

    // 5) Payload final
    const finalPayload = {
      generalObjective,
      specificObjectives,
      linkedCriticalRoots,
      initiatives,
      coverage: {
        coveredRoots: Array.from(covered),
        missingRoots: [],
      },
      feasibility: {
        totalWeeks,
        note:
          totalWeeks === null
            ? "Sin estimación numérica; validado por coherencia."
            : "Validado por estimación de semanas.",
      },
      validatedAt: new Date().toISOString(),
      from: {
        paretoUpdatedAt: paretoFinal?.updated_at ?? null,
        objectivesUpdatedAt: objectivesFinal?.updated_at ?? null,
      },
    };

    // 6) Evaluación pedagógica (rúbrica con ponderaciones) - NO bloquea avance si falla
    const rubric = {
      coherencia_trazabilidad: 40,
      impacto_factibilidad: 30,
      medicion_control: 30,
    };

    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 7 (Plan de Mejora). Debes ser estricto: un plan vago, poco ejecutable o no trazable debe bajar la nota.

RÚBRICA (0-100):
1) Coherencia y trazabilidad (40%):
   - Las iniciativas responden a las causas críticas vinculadas y a los objetivos específicos.
   - Evita acciones que no atacan una causa o que no aportan al objetivo.
2) Impacto y factibilidad (30%):
   - La propuesta no es trivial (no solo checklist).
   - Es viable en ~4 a 6 semanas considerando el contexto de práctica.
   - Hay lógica de implementación (paquetes de acción: estándar + control + piloto/capacitación, etc.).
3) Medición y control (30%):
   - Hay al menos un indicador o KPI (puede ser cualitativo) por iniciativa.
   - La medición propuesta permite verificar avance.

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "coherencia_trazabilidad": number,
    "impacto_factibilidad": number,
    "medicion_control": number
  },
  "feedback": "string",
  "mejoras": ["string", "string", "string"]
}

CAUSAS CRÍTICAS VINCULADAS (Etapa 6):
${JSON.stringify(linkedCriticalRoots, null, 2)}

OBJETIVOS (Etapa 6):
${JSON.stringify({ generalObjective, specificObjectives }, null, 2)}

PLAN DE MEJORA (Etapa 7):
${JSON.stringify(
  { initiatives, feasibility: { totalWeeks } },
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
        evalWarning = { warning: "Etapa 7 validada, pero la IA no devolvió un JSON válido.", raw: llmText };
        evaluation = null;
      }
    } catch {
      evalWarning = { warning: "Etapa 7 validada, pero falló la evaluación IA." };
      evaluation = null;
    }

    const score = evaluation?.total_score ?? 80;

    // 7) Guardar final (con score real si existe)
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

    if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo guardar Plan de Mejora final.", upErr);
    const finalArtifactId = finalRow.id as string;

    // 8) Guardar evaluación (plan_stage_evaluations) si la IA respondió
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
        const payloadEval = {
          status: "validated",
          initiativesCount: initiatives.length,
          totalWeeks,
          coveredRoots: Array.from(covered),
        };

        const { error: evalInsErr } = await supabaseServer.from("plan_stage_evaluations").insert({
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: FinalType,
          artifact_id: finalArtifactId,
          period_key: PERIOD_KEY,

          status: "validated",
          payload_json: payloadEval,

          rubric_json: rubric,
          result_json: evaluation,
          total_score: evaluation.total_score,
          total_label: evaluation.total_label,
        });

        if (evalInsErr) {
          evalWarning = { warning: "Etapa 7 validada, pero no se pudo insertar la evaluación IA." };
        }
      }
    }

    const next = await advancePlanStage({
      userId: user.userId,
      chatId: chatId,
      fromStage: STAGE,
    });

    return NextResponse.json(
      {
        ok: true,
        valid: true,
        message: "Etapa 7 (Plan de Mejora) finalizada. Puedes continuar con la Etapa 8 (Planificación).",
        final: finalPayload,
        score,
        evaluation: evaluation && typeof evaluation.total_score === "number" ? evaluation : null,
        ...(evalWarning ? { warning: evalWarning.warning, warningRaw: evalWarning.raw } : {}),
        next,
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const err = e as { message?: string };
    const msg = err?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    if (msg === "FORBIDDEN_DOMAIN") return fail(403, "FORBIDDEN_DOMAIN", "Dominio no permitido.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
