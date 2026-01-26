// src/app/api/plans/productivity/validate/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type ApiErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "DB_ERROR"
  | "NOT_READY";

function err(status: number, code: ApiErrorCode, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

function ok<T>(data: T) {
  return NextResponse.json({ ok: true, data }, { status: 200 });
}

const PeriodKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "period debe tener formato YYYY-MM");

const BodySchema = z.object({
  period: PeriodKeySchema,
});

const TABLE = "plan_stage_artifacts";
const ARTIFACT_TYPE = "productivity_report";
const EVAL_TABLE = "plan_stage_evaluations";
const STAGE = 1;

// Config base (MVP): Etapa 1 vale 20 pts
const STAGE_POINTS = 20;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function labelFromPct(pct0to100: number) {
  const p = clamp(pct0to100, 0, 100);
  if (p < 50) return "Deficiente";
  if (p < 70) return "Regular";
  if (p < 85) return "Adecuado";
  return "Bien";
}

function pctFromWeighted(scorePart: number, maxPart: number) {
  if (!maxPart) return 0;
  return (scorePart / maxPart) * 100;
}


function scoreProductivity(payload: any) {
  // Reglas simples (MVP), alineadas a tu rúbrica.
  // Coherencia lógica (40): presencia de periodo, tipo, y que no mezcle incoherencias básicas.
  // Tipo productividad (30): existe type y tiene datos mínimos acordes.
  // Claridad (30): tiene números no negativos, costos con nombres, etc.
  const issues: string[] = [];

  const type = payload?.type;
  const period_key = payload?.period_key;
  if (!period_key) issues.push("Falta periodo (YYYY-MM).");

  if (type !== "monetaria" && type !== "fisica") issues.push("Tipo de productividad inválido.");

  let coherence = 0;
  let typeChoice = 0;
  let clarity = 0;

  // Coherencia
  if (period_key) coherence += 15;
  if (type) coherence += 15;
  if (payload?.line && typeof payload.line === "string") coherence += 10;

  // Tipo de productividad
  if (type === "monetaria") {
    const income = payload?.income_bs;
    const costs = payload?.costs;
    const costTotal = payload?.cost_total_bs;

    const hasIncome = typeof income === "number" && income >= 0;
    const hasCostsList = Array.isArray(costs) && costs.length > 0;
    const hasCostTotal = typeof costTotal === "number" && costTotal >= 0;

    if (!hasIncome) issues.push("Falta income_bs (ingresos en Bs) para productividad monetaria.");
    if (!hasCostsList) issues.push("Falta lista de costos (costs[]) para productividad monetaria.");
    if (!hasCostTotal) issues.push("Falta cost_total_bs (o no se pudo calcular).");

    typeChoice += hasIncome ? 15 : 0;
    typeChoice += hasCostsList ? 10 : 0;
    typeChoice += hasCostTotal ? 5 : 0;
  }

  if (type === "fisica") {
    // MVP: exigimos al menos 'notes' o 'line' como descripción y algún costo/insumo
    const hasDesc = typeof payload?.notes === "string" || typeof payload?.line === "string";
    if (!hasDesc) issues.push("Para productividad física, describe el resultado/unidad (notes o line).");
    typeChoice += hasDesc ? 30 : 0;
  }

  // Claridad
  const numericOk =
    (payload?.income_bs === undefined || (typeof payload.income_bs === "number" && payload.income_bs >= 0)) &&
    (payload?.cost_total_bs === undefined || (typeof payload.cost_total_bs === "number" && payload.cost_total_bs >= 0));

  if (!numericOk) issues.push("Hay montos inválidos (negativos o no numéricos).");
  clarity += numericOk ? 15 : 0;

  const costs = payload?.costs;
  if (Array.isArray(costs)) {
    const allValid = costs.every(
      (c: any) => typeof c?.name === "string" && c.name.trim().length > 0 && typeof c?.amount_bs === "number" && c.amount_bs >= 0
    );
    if (!allValid) issues.push("En costs[] hay ítems sin nombre o con monto inválido.");
    clarity += allValid ? 15 : 0;
  } else {
    // si no hay costs, no suma claridad aquí
  }

  coherence = clamp(coherence, 0, 40);
  typeChoice = clamp(typeChoice, 0, 30);
  clarity = clamp(clarity, 0, 30);

  const total = coherence + typeChoice + clarity;

  const ready = issues.length === 0 && total >= 70; // umbral MVP (ajustable)
  return { ready, issues, score: { coherence, type_choice: typeChoice, clarity, total } };
}

export async function POST(req: Request) {
  const authed = await requireUser(req).catch(() => null);
  if (!authed) return err(401, "UNAUTHORIZED", "No autenticado.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "BAD_REQUEST", "Body inválido (JSON).");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return err(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Body inválido.");
  }

  const { period } = parsed.data;

  const { data: row, error: getErr } = await supabaseServer
    .from(TABLE)
    .select("id,status,payload,period_key,chat_id")
    .eq("user_id", authed.userId)
    .eq("stage", STAGE)
    .eq("artifact_type", ARTIFACT_TYPE)
    .eq("period_key", period)
    .maybeSingle();

  if (getErr) return err(500, "DB_ERROR", `DB error: ${getErr.message}`);
  if (!row) return err(404, "NOT_FOUND", "No existe draft para validar en ese periodo.");

  const { ready, issues, score } = scoreProductivity(row.payload);

  if (!ready) {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_READY",
        message: "Aún falta información o hay incoherencias.",
        details: { issues, score },
      },
      { status: 422 }
    );
  }

  const { data: updated, error: updErr } = await supabaseServer
    .from(TABLE)
    .update({ status: "validated", score })
    .eq("id", row.id)
    .select("id,status,score,period_key,payload,updated_at")
    .single();

  if (updErr) return err(500, "DB_ERROR", `DB error: ${updErr.message}`);

    // -----------------------------
    // Guardar evaluación IA (rúbrica) para dashboard docente
    // -----------------------------
    // versionado: last(version)+1 para user+stage+artifact+period
    const { data: lastEval, error: lastEvalErr } = await supabaseServer
      .from(EVAL_TABLE)
      .select("version")
      .eq("user_id", authed.userId)
      .eq("stage", STAGE)
      .eq("artifact_type", ARTIFACT_TYPE)
      .eq("period_key", period)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastEvalErr) {
      return err(500, "DB_ERROR", `DB error (eval last version): ${lastEvalErr.message}`);
    }

    const nextVersion = (lastEval?.version ?? 0) + 1;

    // Tu score ya está ponderado a 100 (40/30/30) => total 0-100
    const coherenceWeighted = score.coherence;     // 0..40
    const typeWeighted = score.type_choice;        // 0..30
    const clarityWeighted = score.clarity;         // 0..30
    const totalWeighted = score.total;             // 0..100

    // Labels por criterio usando % interno del criterio
    const coherenceLabel = labelFromPct(pctFromWeighted(coherenceWeighted, 40));
    const typeLabel = labelFromPct(pctFromWeighted(typeWeighted, 30));
    const clarityLabel = labelFromPct(pctFromWeighted(clarityWeighted, 30));
    const totalLabel = labelFromPct(totalWeighted);

    const rubric_json = {
      stage: STAGE,
      artifact_type: ARTIFACT_TYPE,
      scale: ["Deficiente", "Regular", "Adecuado", "Bien"],
      weights: {
        coherencia_logica: 40,
        seleccion_tipo: 30,
        claridad_orden: 30,
      },
      note: "Evaluación automática IA (MVP).",
    };

    const result_json = {
      criteria: {
        coherencia_logica: {
          weight: 40,
          score_weighted: coherenceWeighted, // puntos ya ponderados
          label: coherenceLabel,
        },
        seleccion_tipo: {
          weight: 30,
          score_weighted: typeWeighted,
          label: typeLabel,
        },
        claridad_orden: {
          weight: 30,
          score_weighted: clarityWeighted,
          label: clarityLabel,
        },
      },
      issues: issues ?? [],
    };

    const { error: insEvalErr } = await supabaseServer.from(EVAL_TABLE).insert({
      user_id: authed.userId,
      chat_id: (row as any)?.chat_id ?? null,
      stage: STAGE,
      artifact_type: ARTIFACT_TYPE,
      artifact_id: updated.id, // referencia al artefacto validado
      period_key: period,
      version: nextVersion,
      rubric_json,
      result_json,
      total_score: totalWeighted, // 0-100
      total_label: totalLabel,
    });

    if (insEvalErr) {
      return err(500, "DB_ERROR", `DB error (insert evaluation): ${insEvalErr.message}`);
    }

  return ok(updated);
}
