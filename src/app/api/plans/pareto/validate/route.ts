// src/app/api/plans/pareto/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { advancePlanStage } from "@/lib/plan/stageOrchestrator";

export const runtime = "nodejs";

const STAGE = 5;
const DraftType = "pareto_wizard_state";
const FinalType = "pareto_final";
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function ceil20Percent(n: number) {
  return Math.max(1, Math.ceil(n * 0.2));
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

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId } = parsed.data;



    let stateRow: { state_json: Record<string, unknown> | null; chat_id: string | null } | null = null;

    const direct = await supabaseServer
      .from("plan_stage_states")
      .select("state_json, chat_id")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (direct.error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto.", direct.error);
    stateRow = direct.data ?? null;

    if (!stateRow && !chatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto.", latest.error);
      stateRow = latest.data ?? null;
    }

    let legacyRow: { payload: Record<string, unknown> | null; chat_id: string | null } | null = null;

    if (!stateRow?.state_json) {
      const legacyDirect = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id")
        .eq("user_id", user.userId)
        .eq("chat_id", chatId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .maybeSingle();

      if (legacyDirect.error) return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Pareto.", legacyDirect.error);
      legacyRow = legacyDirect.data ?? null;

      if (!legacyRow && !chatId) {
        const legacyLatest = await supabaseServer
          .from("plan_stage_artifacts")
          .select("payload, chat_id")
          .eq("user_id", user.userId)
          .eq("stage", STAGE)
          .eq("artifact_type", DraftType)
          .eq("period_key", PERIOD_KEY)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (legacyLatest.error) return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Pareto.", legacyLatest.error);
        legacyRow = legacyLatest.data ?? null;
      }
    }

    const s: any = stateRow?.state_json ?? legacyRow?.payload ?? null;
    const stateChatId = stateRow?.chat_id ?? legacyRow?.chat_id ?? null;

    if (!s) {
      return fail(
        400,
        "BAD_REQUEST",
        "No hay estado guardado de la Etapa 5 (Pareto)."
      );
    }


    // 2) Resolver raíces oficiales para Pareto
    // Primero usamos las raíces congeladas dentro del propio estado de Pareto.
    // Solo si no existen, hacemos fallback a Ishikawa final validado.
    const rootsFromState: string[] = Array.isArray(s?.roots)
      ? s.roots.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [];

    let rootsOfficial: string[] = rootsFromState;
    let ishikawaUpdatedAt: string | null = null;

    if (rootsOfficial.length === 0) {
      const ishResult = await loadLatestValidatedArtifact({
        userId: user.userId,
        preferredChatId: chatId,
        stage: 4,
        artifactType: "ishikawa_final",
        periodKey: PERIOD_KEY,
      });

      if (!ishResult.ok) {
        return fail(500, "DB_ERROR", "No se pudo leer Ishikawa final (Etapa 4).", ishResult.error);
      }

      const ishFinal = ishResult.row;
      ishikawaUpdatedAt = ishFinal?.updated_at ?? null;

      rootsOfficial = Array.isArray(ishFinal?.payload?.roots)
        ? ishFinal.payload.roots.map((x: unknown) => String(x).trim()).filter(Boolean)
        : [];
    }

    if (rootsOfficial.length === 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "No pude resolver la lista base de causas raíz para validar Pareto.",
      });
    }

    

    // 3) Validaciones Pareto (MVP)
    const selectedRoots: string[] = Array.isArray(s?.selectedRoots) ? s.selectedRoots.map((x: any) => String(x).trim()).filter(Boolean) : [];
    const minSelected = typeof s?.minSelected === "number" ? s.minSelected : 10;
    const maxSelected = typeof s?.maxSelected === "number" ? s.maxSelected : 15;

    if (selectedRoots.length < minSelected || selectedRoots.length > maxSelected) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: `Selecciona entre ${minSelected} y ${maxSelected} causas raíz para el Pareto. Actualmente: ${selectedRoots.length}.`,
      });
    }

    // asegurar que selectedRoots exista dentro de rootsOfficial
    const rootsSet = new Set(rootsOfficial);
    const invalidSelected = selectedRoots.filter((r) => !rootsSet.has(r));
    if (invalidSelected.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas seleccionadas no coinciden con las raíces oficiales del Ishikawa. Revisa la lista.",
        detail: { invalidSelected },
      });
    }

    // criterios (3) con peso 1-10
    const criteria = Array.isArray(s?.criteria) ? s.criteria : [];
    if (criteria.length !== 3) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes definir exactamente 3 criterios para el Pareto (con peso 1 a 10).",
      });
    }

    for (const c of criteria) {
      const name = String(c?.name ?? "").trim();
      const w = Number(c?.weight);
      if (!name) {
        return NextResponse.json({ ok: true, valid: false, message: "Hay un criterio sin nombre. Corrígelo." });
      }
      if (!Number.isFinite(w) || w < 1 || w > 10) {
        return NextResponse.json({
          ok: true,
          valid: false,
          message: `El peso del criterio "${name}" debe estar entre 1 y 10.`,
        });
      }
    }

    // criticalRoots (top 20% devuelto por el estudiante tras Excel)
    const criticalRoots: string[] = Array.isArray(s?.criticalRoots)
      ? s.criticalRoots.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    const minCritical = ceil20Percent(selectedRoots.length);
    if (criticalRoots.length < minCritical) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: `Aún falta la lista final de causas críticas (top 20%). Para ${selectedRoots.length} causas, envía al menos ${minCritical} causas críticas (según tu Excel).`,
      });
    }

    const selectedSet = new Set(selectedRoots);
    const invalidCritical = criticalRoots.filter((r) => !selectedSet.has(r));
    if (invalidCritical.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas críticas no están dentro de tu lista seleccionada de causas raíz.",
        detail: { invalidCritical },
      });
    }

    // 4) Guardar final artifact (Etapa 5)
    const finalPayload = {
      selectedRoots,
      criteria: criteria.map((c: any) => ({
        id: String(c?.id ?? "").trim() || crypto.randomUUID(),
        name: String(c?.name ?? "").trim(),
        weight: Number(c?.weight),
      })),
      criticalRoots,
      note: "El cálculo 80/20 se realizó en Excel (herramienta de la materia).",
      validatedAt: new Date().toISOString(),
      fromStage4: { rootsCount: rootsOfficial.length, ishikawaUpdatedAt },
    };

    // 5) Evaluación pedagógica IA (rúbrica con ponderaciones) - NO bloquea avance si falla
    const rubric = {
      criterios_ponderaciones: 40,
      priorizacion_final: 60,
    };

    const model = getGeminiModel();
    // reutilizamos minCritical ya calculado arriba en las validaciones

    const prompt = `
    Evalúa académicamente la Etapa 5 (Pareto). Debes ser estricto: si los criterios son vagos,
    los pesos no tienen sentido o la priorización no parece defendible, baja la nota.

    RÚBRICA (0-100):
    1) Criterios y ponderaciones (40%):
      - Define exactamente 3 criterios con nombres claros y válidos (no genéricos).
      - Pesos 1-10 razonables (no todos iguales sin necesidad).
      - Los criterios ayudan a priorizar causas raíz en este contexto.
    2) Priorización final (60%):
      - Las causas críticas (top 20%) son coherentes con la lista seleccionada y no parecen arbitrarias.
      - Evita causas críticas vagas/duplicadas.
      - Debe sentirse defendible que esas son “las más importantes”.

    Escala fija: Deficiente / Regular / Adecuado / Bien

    Devuelve SOLO JSON:
    {
      "total_score": number (0-100),
      "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
      "detail": {
        "criterios_ponderaciones": number,
        "priorizacion_final": number
      },
      "feedback": "string",
      "mejoras": ["string", "string", "string"]
    }

    RAÍCES OFICIALES (Ishikawa validado):
    ${JSON.stringify(rootsOfficial, null, 2)}

    ENTREGA DEL ESTUDIANTE (Pareto):
    ${JSON.stringify(
      {
        selectedRoots,
        criteria,
        criticalRoots,
        minCritical,
        note: "El cálculo 80/20 se realizó en Excel (herramienta de la materia).",
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
        evalWarning = { warning: "Etapa 5 validada, pero la IA no devolvió un JSON válido.", raw: llmText };
        evaluation = null;
      }
    } catch {
      evalWarning = { warning: "Etapa 5 validada, pero falló la evaluación IA." };
      evaluation = null;
    }

    // Si no hay evaluación IA válida, mantenemos score neutral (no bloquea)
    const score = evaluation?.total_score ?? 80;


    // 4) Guardar final artifact (Etapa 5) - upsert seguro (no depende de chat_id)
    const { data: finalRow, error: upErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId ?? stateChatId ?? null,
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

    if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo guardar Pareto final.", upErr);

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

      if (existingEvalErr) {
        evalWarning = { warning: "Etapa 5 validada, pero no se pudo verificar evaluación existente." };
      } else if (!existingEval) {
        const payloadEval = {
          status: "validated",
          selectedRootsCount: selectedRoots.length,
          criticalRootsCount: criticalRoots.length,
          minCritical,
        };

        const { error: evalInsErr } = await supabaseServer.from("plan_stage_evaluations").insert({
          user_id: user.userId,
          chat_id: chatId ?? stateChatId ?? null,
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
          evalWarning = { warning: "Etapa 5 validada, pero no se pudo insertar la evaluación IA." };
        }
      }
    }

    const next = await advancePlanStage({
      userId: user.userId,
      chatId: chatId ?? stateChatId ?? null,
      fromStage: STAGE,
    });


    return NextResponse.json(
      {
        ok: true,
        valid: true,
        message: "Etapa 5 (Pareto) finalizada. Ya puedes continuar al Avance 2.",
        final: finalPayload,
        score,
        evaluation: evaluation && typeof evaluation.total_score === "number" ? evaluation : null,
        ...(evalWarning ? { warning: evalWarning.warning, warningRaw: evalWarning.raw } : {}),
        next,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
