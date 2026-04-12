// src/app/api/plans/objectives/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

import { loadLatestStageStateByChat, loadLatestValidatedArtifact} from "@/lib/plan/stageValidation";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";

export const runtime = "nodejs";

const STAGE = 6;
const FinalType = "objectives_final";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function nonEmptyTrimmed(s: unknown): string {
  return String(s ?? "").trim();
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}


function normalizeText(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const raw = String(value ?? "").trim();
    const key = normalizeText(raw);
    if (!raw || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  return out;
}

function looksTooGenericObjective(text: string): boolean {
  const t = normalizeText(text);

  const genericPatterns = [
    "mejorar la productividad",
    "optimizar el proceso",
    "mejorar el proceso",
    "aumentar la eficiencia",
    "mejorar la eficiencia",
    "reducir problemas",
    "mejorar el area",
  ];

  return genericPatterns.some((pattern) => t === pattern || t.startsWith(pattern));
}

function looksLikeOnlyActivity(text: string): boolean {
  const t = normalizeText(text);

  const activityStarters = [
    "capacitar",
    "realizar capacitacion",
    "hacer capacitacion",
    "implementar capacitacion",
    "elaborar",
    "hacer",
    "crear",
    "diseñar",
    "desarrollar",
  ];

  return activityStarters.some((pattern) => t.startsWith(pattern));
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
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId } = parsed.data;

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

    const criticalRootsOfficial = asStringArray((paretoFinal as any)?.payload?.criticalRoots);
    if (criticalRootsOfficial.length === 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message:
          "Para validar Objetivos (Etapa 6) primero debes tener Pareto final validado con causas críticas (top 20%).",
      });
    }

    // 2) Leer estado actual de la Etapa 6 desde plan_stage_states
    const stateResult = await loadLatestStageStateByChat({
      userId: user.userId,
      chatId,
      stage: STAGE,
    });

    if (!stateResult.ok) {
      return fail(500, "DB_ERROR", "No se pudo leer el estado de la Etapa 6.", stateResult.error);
    }

    const stRow = stateResult.row;

    if (!stRow?.state_json) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "No hay estado guardado de la Etapa 6 (Objetivos).",
      });
    }

    const s: any = stRow.state_json;

    // 3) Gate mínimo (habilita avance, independiente del score)
    const generalObjective = nonEmptyTrimmed(s?.generalObjective);
    if (generalObjective.length < 15) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "El Objetivo General es muy corto. Redáctalo con mayor claridad (mínimo ~15 caracteres).",
      });
    }

    const specificObjectives = uniqueStrings(asStringArray(s?.specificObjectives));

    if (specificObjectives.length < 3) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes formular al menos 3 Objetivos Específicos.",
      });
    }

    const tooShortSpecifics = specificObjectives.filter((item) => item.trim().length < 12);
    if (tooShortSpecifics.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Hay objetivos específicos demasiado cortos o incompletos. Redáctalos con más claridad.",
        detail: { tooShortSpecifics },
      });
    }

    const genericSpecifics = specificObjectives.filter((item) => looksTooGenericObjective(item));
    if (genericSpecifics.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunos objetivos específicos siguen siendo demasiado genéricos. Deben indicar con mayor precisión qué se va a mejorar.",
        detail: { genericSpecifics },
      });
    }

    const activitySpecifics = specificObjectives.filter((item) => looksLikeOnlyActivity(item));
    if (activitySpecifics.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunos objetivos específicos están redactados como actividades y no como resultados esperados.",
        detail: { activitySpecifics },
      });
    }

    const linkedCriticalRoots = uniqueStrings(asStringArray(s?.linkedCriticalRoots));

    if (linkedCriticalRoots.length < 1) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes vincular al menos 1 causa crítica (top 20%) del Pareto a tus objetivos.",
      });
    }

    const officialSet = new Set(criticalRootsOfficial.map((r) => normalizeText(r)));
    const invalidLinked = linkedCriticalRoots.filter((r) => !officialSet.has(normalizeText(r)));

    if (invalidLinked.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas vinculadas no coinciden con las causas críticas oficiales del Pareto (top 20%).",
        detail: { invalidLinked },
      });
    }

    // 4) Payload final (se guarda siempre que pase el mínimo)
    const finalPayload = {
      generalObjective,
      specificObjectives: uniqueStrings(specificObjectives),
      linkedCriticalRoots: uniqueStrings(linkedCriticalRoots),
      validatedAt: new Date().toISOString(),
      fromPareto: {
        criticalRootsCount: criticalRootsOfficial.length,
        paretoUpdatedAt: (paretoFinal as any)?.updated_at ?? null,
      },
    };

    // 5) Evaluación pedagógica (rúbrica con ponderaciones) - NO bloquea avance si falla
    const rubric = {
      coherencia_trazabilidad: 40,
      claridad_redaccion: 30,
      especificidad_medibilidad: 30,
    };

    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 6 (Objetivos). Debes ser estricto: si hay ambigüedad, poca precisión o falta de coherencia, baja la puntuación.

RÚBRICA (0-100):
1) Coherencia y trazabilidad con causas críticas (40%):
   - Los objetivos responden a causas críticas (Pareto top 20%) y no se contradicen.
   - La vinculación causa→objetivo es razonable y defendible.
2) Claridad y calidad de redacción (30%):
   - Objetivo general claro (qué se mejora, dónde y con qué intención).
   - Objetivos específicos entendibles, sin vaguedades (“mejorar mucho”, “optimizar”).
3) Especificidad/medibilidad (30%):
   - Los objetivos específicos se formulan de manera verificable (cuánto/qué evidencia), aunque no haya KPI numérico exacto.
   - Evita objetivos que sean actividades (“hacer capacitación”) en vez de resultados.

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "coherencia_trazabilidad": number,
    "claridad_redaccion": number,
    "especificidad_medibilidad": number
  },
  "feedback": "string",
  "mejoras": ["string", "string", "string"]
}

CAUSAS CRÍTICAS OFICIALES (Pareto top 20%):
${JSON.stringify(criticalRootsOfficial, null, 2)}

ENTREGA DEL ESTUDIANTE (Objetivos):
${JSON.stringify(
  {
    generalObjective,
    specificObjectives,
    linkedCriticalRoots,
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
        evalWarning = { warning: "Etapa 6 validada, pero la IA no devolvió un JSON válido.", raw: llmText };
        evaluation = null;
      }
    } catch {
      evalWarning = { warning: "Etapa 6 validada, pero falló la evaluación IA." };
      evaluation = null;
    }

    // Si no hay evaluación IA válida, mantenemos score neutral (no bloquea)
    const score = evaluation?.total_score ?? 80;

    // 6) Guardar objectives_final (Etapa 6) - upsert seguro
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

    if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo guardar Objectives final.", upErr);
    const finalArtifactId = finalRow.id as string;

    // 7) Guardar evaluación (plan_stage_evaluations) si la IA respondió
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
          specificObjectivesCount: specificObjectives.length,
          linkedCriticalRootsCount: linkedCriticalRoots.length,
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
          evalWarning = { warning: "Etapa 6 validada, pero no se pudo insertar la evaluación IA." };
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
        message: "Etapa 6 (Objetivos) finalizada. Puedes continuar con la Etapa 7 (Plan de Mejora).",
        final: finalPayload,
        score,
        evaluation: evaluation && typeof evaluation.total_score === "number" ? evaluation : null,
        ...(evalWarning ? { warning: evalWarning.warning, warningRaw: evalWarning.raw } : {}),
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
      return fail(403, "FORBIDDEN_DOMAIN", "Dominio no permitido.");
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
