// src/app/api/plans/planning/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";

export const runtime = "nodejs";

const STAGE = 8;
const FinalType = "planning_final";
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

function isIsoDateLike(s: string) {
  // acepta YYYY-MM-DD o ISO completo; sin ser súper estricto
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

function safeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
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

    // 1) Requiere Etapa 7 validada (Plan de Mejora)
    const { data: improvementFinal, error: impErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", 7)
      .eq("artifact_type", "improvement_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (impErr) return fail(500, "DB_ERROR", "No se pudo leer Plan de Mejora final (Etapa 7).", impErr);
    if (!improvementFinal?.payload) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para validar Etapa 8 necesitas Etapa 7 (Plan de Mejora) validada.",
      });
    }

    const improvementPayload = improvementFinal.payload as any;
    const initiatives = Array.isArray(improvementPayload?.initiatives) ? improvementPayload.initiatives : [];
    if (initiatives.length < 1) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Etapa 7 no tiene iniciativas suficientes para planificar.",
      });
    }

    // 2) Leer estado Etapa 8 desde plan_stage_states
    const { data: stRow, error: stErr } = await supabaseServer
      .from("plan_stage_states")
      .select("state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (stErr) return fail(500, "DB_ERROR", "No se pudo leer el estado de la Etapa 8.", stErr);
    if (!stRow?.state_json) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "No hay estado guardado de la Etapa 8 (Planificación).",
      });
    }

    const s: any = stRow.state_json;

    // 3) Gate mínimo (habilita cierre sin nota mínima)
    const studentWeeks = safeNumber(s?.time?.studentWeeks);
    const courseCutoffDate = nonEmptyTrimmed(s?.time?.courseCutoffDate) || null;

    if (studentWeeks === null && !courseCutoffDate) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "Para cerrar Etapa 8, define cuántas semanas te quedan (o usa una fecha de corte del curso si no sabes).",
      });
    }

    if (courseCutoffDate && !isIsoDateLike(courseCutoffDate)) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "La fecha de corte no tiene formato válido. Usa formato YYYY-MM-DD.",
      });
    }

    const weekly = Array.isArray(s?.plan?.weekly) ? s.plan.weekly : [];
    const milestones = Array.isArray(s?.plan?.milestones) ? s.plan.milestones : [];

    if (weekly.length < 1) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Aún falta el cronograma por semanas. Define al menos una semana con actividades.",
      });
    }

    if (milestones.length < 2) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Define al menos 2 hitos para el cronograma (por ejemplo: piloto listo, primera medición, etc.).",
      });
    }

    // al menos 1 medición en algún week item
    const hasMeasurement = weekly.some((w: any) => {
      const m = nonEmptyTrimmed(w?.measurement);
      return Boolean(m);
    });
    if (!hasMeasurement) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Incluye al menos 1 punto de medición/seguimiento en el cronograma.",
      });
    }

    // 4) Payload final
    const finalPayload = {
      fromStage7: {
        initiativesCount: initiatives.length,
        improvementUpdatedAt: improvementFinal?.updated_at ?? null,
      },
      time: {
        studentWeeks,
        courseCutoffDate,
        effectiveWeeks: safeNumber(s?.time?.effectiveWeeks),
        notes: nonEmptyTrimmed(s?.time?.notes) || null,
      },
      plan: {
        weekly,
        milestones,
        risks: Array.isArray(s?.plan?.risks) ? s.plan.risks : [],
      },
      validatedAt: new Date().toISOString(),
    };

    // 5) Evaluación pedagógica (rúbrica con %). NO bloquea si falla.
    const rubric = {
      factibilidad_tiempo: 40,
      secuencia_dependencias: 30,
      seguimiento_evidencia: 30,
    };

    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 8 (Planificación). Debes ser estricto: si el plan no cabe en el tiempo real,
si no tiene lógica o no tiene seguimiento, baja la nota.

RÚBRICA (0-100):
1) Factibilidad temporal y ajuste al corte (40%):
   - El cronograma cabe en las semanas disponibles (o explica recorte si es corto).
   - Hitos realistas por semana.
2) Secuencia lógica y dependencias (30%):
   - Orden correcto (preparar -> piloto -> medir -> ajustar).
   - No “mide antes de implementar”.
3) Seguimiento, evidencia y control (30%):
   - Evidencias mínimas y al menos un punto de medición.
   - Responsables básicos o al menos claridad de quién ejecuta/valida.

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "factibilidad_tiempo": number,
    "secuencia_dependencias": number,
    "seguimiento_evidencia": number
  },
  "feedback": "string",
  "mejoras": ["string", "string", "string"]
}

ENTRADAS:
- Iniciativas del Plan de Mejora (Etapa 7): ${JSON.stringify(
      initiatives.map((i: any) => ({
        title: i?.title ?? null,
        linkedObjective: i?.linkedObjective ?? null,
        linkedRoot: i?.linkedRoot ?? null,
      })),
      null,
      2
    )}

- Cronograma propuesto (Etapa 8):
${JSON.stringify(finalPayload, null, 2)}
`;

    let evaluation: any = null;
    let evalWarning: { warning: string; raw?: string } | null = null;

    try {
      const llmRes = await model.generateContent(prompt);
      const llmText = llmRes.response.text();
      evaluation = extractJsonSafe(llmText);

      if (!evaluation || typeof evaluation.total_score !== "number") {
        evalWarning = { warning: "Etapa 8 validada, pero la IA no devolvió un JSON válido.", raw: llmText };
        evaluation = null;
      }
    } catch {
      evalWarning = { warning: "Etapa 8 validada, pero falló la evaluación IA." };
      evaluation = null;
    }

    const score = evaluation?.total_score ?? 80;

    // 6) Guardar planning_final
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

    if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo guardar Planificación final.", upErr);
    const finalArtifactId = finalRow.id as string;

    // 7) Guardar evaluación en plan_stage_evaluations (si IA respondió)
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
          weeksPlanned: weekly.length,
          milestonesCount: milestones.length,
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
          evalWarning = { warning: "Etapa 8 validada, pero no se pudo insertar la evaluación IA." };
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
        message:
          "Etapa 8 (Planificación) finalizada. Con esto se completa el Avance 2. Luego sigue el Avance 3 (Etapa 9: reporte/archivo).",
        final: finalPayload,
        score,
        evaluation: evaluation && typeof evaluation.total_score === "number" ? evaluation : null,
        ...(evalWarning ? { warning: evalWarning.warning, warningRaw: evalWarning.raw } : {}),
        next: {
          ...next,
          hint: "En Etapa 9 el estudiante reporta avance y opcionalmente sube un archivo.",
        },
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
