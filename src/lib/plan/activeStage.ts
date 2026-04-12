// src/lib/plan/activeStage.ts
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";

type JsonMap = Record<string, unknown>;

export type ActivePlanStage =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10;

export type ResolvedActiveStage =
  | {
      found: true;
      stage: ActivePlanStage;
      source: "context_draft" | "context_confirmed" | "stage_state" | "artifact";
      sourceChatId: string | null;
      stateJson: JsonMap | null;
      meta?: JsonMap | null;
    }
  | {
      found: false;
      stage: 0;
      source: "none";
      sourceChatId: null;
      stateJson: null;
      meta?: JsonMap | null;
    };

type LatestStateRow = {
  chat_id: string | null;
  state_json: JsonMap | null;
  updated_at: string | null;
};

type LatestArtifactRow = {
  chat_id: string | null;
  payload: JsonMap | null;
  updated_at: string | null;
  status: string | null;
};

type FodaQuadrant = "F" | "D" | "O" | "A";

function parseIsoMillis(value: string | null | undefined) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function parseFodaCount(raw: unknown) {
  return Array.isArray(raw) ? raw.length : 0;
}

function getFodaStatePriority(stateJson: JsonMap | null) {
  if (!stateJson || typeof stateJson !== "object") return -1;

  const state = stateJson as Record<string, unknown>;
  const rawItems =
    state.items && typeof state.items === "object"
      ? (state.items as Record<string, unknown>)
      : null;

  if (!rawItems) return -1;

  const currentQuadrantRaw = state.currentQuadrant;
  const currentQuadrant: FodaQuadrant =
    currentQuadrantRaw === "F" ||
    currentQuadrantRaw === "D" ||
    currentQuadrantRaw === "O" ||
    currentQuadrantRaw === "A"
      ? currentQuadrantRaw
      : "F";

  const counts = {
    F: parseFodaCount(rawItems.F),
    D: parseFodaCount(rawItems.D),
    O: parseFodaCount(rawItems.O),
    A: parseFodaCount(rawItems.A),
  };

  const totalItems = counts.F + counts.D + counts.O + counts.A;
  const completedQuadrants = [counts.F, counts.D, counts.O, counts.A].filter(
    (count) => count >= 3
  ).length;
  const currentQuadrantCount = counts[currentQuadrant];

  return totalItems * 100 + completedQuadrants * 10 + currentQuadrantCount;
}

const RESUME_GATE_BY_STAGE: Partial<
  Record<ActivePlanStage, { requiredStage: number; artifactType: string }>
> = {
  2: { requiredStage: 1, artifactType: "productivity_report" },
  3: { requiredStage: 2, artifactType: "foda_analysis" },
  4: { requiredStage: 3, artifactType: "brainstorm_ideas" },
  5: { requiredStage: 4, artifactType: "ishikawa_final" },
  6: { requiredStage: 5, artifactType: "pareto_final" },
  7: { requiredStage: 6, artifactType: "objectives_final" },
  8: { requiredStage: 7, artifactType: "improvement_final" },
  9: { requiredStage: 8, artifactType: "planning_final" },
  10: { requiredStage: 9, artifactType: "progress_final" },
};

async function canResumeStage(args: {
  userId: string;
  targetStage: ActivePlanStage;
  sourceChatId: string | null;
  periodKey: string;
}): Promise<boolean> {
  const gate = RESUME_GATE_BY_STAGE[args.targetStage];

  if (!gate) return true;

  const result = await loadLatestValidatedArtifact({
    userId: args.userId,
    preferredChatId: args.sourceChatId,
    stage: gate.requiredStage,
    artifactType: gate.artifactType,
    periodKey: args.periodKey,
  });

  if (!result.ok) {
    throw result.error;
  }

  return !!result.row;
}

async function loadLatestStageState(
  userId: string,
  stage: number
): Promise<LatestStateRow | null> {
  if (stage === 2) {
    const { data, error } = await supabaseServer
      .from("plan_stage_states")
      .select("chat_id, state_json, updated_at")
      .eq("user_id", userId)
      .eq("stage", stage)
      .order("updated_at", { ascending: false })
      .limit(25);

    if (error) throw error;
    if (!data?.length) return null;

    const bestRow = [...data].sort((a, b) => {
      const priorityDiff =
        getFodaStatePriority((b.state_json as JsonMap | null) ?? null) -
        getFodaStatePriority((a.state_json as JsonMap | null) ?? null);

      if (priorityDiff !== 0) return priorityDiff;

      return parseIsoMillis(b.updated_at) - parseIsoMillis(a.updated_at);
    })[0];

    return bestRow ? (bestRow as LatestStateRow) : null;
  }

  const { data, error } = await supabaseServer
    .from("plan_stage_states")
    .select("chat_id, state_json, updated_at")
    .eq("user_id", userId)
    .eq("stage", stage)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? (data as LatestStateRow) : null;
}

async function loadLatestArtifact(args: {
  userId: string;
  stage: number;
  artifactType: string;
  periodKey?: string;
  status?: string;
}): Promise<LatestArtifactRow | null> {
  const { userId, stage, artifactType, periodKey, status } = args;

  let query = supabaseServer
    .from("plan_stage_artifacts")
    .select("chat_id, payload, updated_at, status")
    .eq("user_id", userId)
    .eq("stage", stage)
    .eq("artifact_type", artifactType);

  if (periodKey) query = query.eq("period_key", periodKey);
  if (status) query = query.eq("status", status);

  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? (data as LatestArtifactRow) : null;
}

export async function resolveActivePlanStage(
  userId: string
): Promise<ResolvedActiveStage> {
  const periodKey = getPeriodKeyLaPaz();

  const { data: contextRow, error: contextError } = await supabaseServer
    .from("plan_case_contexts")
    .select("chat_id, status, context_json, context_text, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (contextError) throw contextError;

  // Etapas avanzadas: 10 -> 6
  for (const stage of [10, 9, 8, 7, 6] as const) {
    const row = await loadLatestStageState(userId, stage);

    if (!row?.state_json) continue;

    const allowed = await canResumeStage({
      userId,
      targetStage: stage,
      sourceChatId: row.chat_id ?? null,
      periodKey,
    });

    if (!allowed) continue;

    return {
      found: true,
      stage,
      source: "stage_state",
      sourceChatId: row.chat_id ?? null,
      stateJson: row.state_json,
      meta: null,
    };
  }

  // Etapa 5: Pareto (state primero, artifact legacy después)
  {
    const stateRow = await loadLatestStageState(userId, 5);

    if (stateRow?.state_json) {
      const allowed = await canResumeStage({
        userId,
        targetStage: 5,
        sourceChatId: stateRow.chat_id ?? null,
        periodKey,
      });

      if (allowed) {
        return {
          found: true,
          stage: 5,
          source: "stage_state",
          sourceChatId: stateRow.chat_id ?? null,
          stateJson: stateRow.state_json,
          meta: null,
        };
      }
    }

    const legacyPareto = await loadLatestArtifact({
      userId,
      stage: 5,
      artifactType: "pareto_wizard_state",
      periodKey,
    });

    if (legacyPareto?.payload) {
      const allowed = await canResumeStage({
        userId,
        targetStage: 5,
        sourceChatId: legacyPareto.chat_id ?? null,
        periodKey,
      });

      if (allowed) {
        return {
          found: true,
          stage: 5,
          source: "artifact",
          sourceChatId: legacyPareto.chat_id ?? null,
          stateJson: legacyPareto.payload,
          meta: {
            artifactType: "pareto_wizard_state",
          },
        };
      }
    }
  }

  // Etapas intermedias: 4 -> 2
  for (const stage of [4, 3, 2] as const) {
    const row = await loadLatestStageState(userId, stage);

    if (!row?.state_json) continue;

    const allowed = await canResumeStage({
      userId,
      targetStage: stage,
      sourceChatId: row.chat_id ?? null,
      periodKey,
    });

    if (!allowed) continue;

    return {
      found: true,
      stage,
      source: "stage_state",
      sourceChatId: row.chat_id ?? null,
      stateJson: row.state_json,
      meta: null,
    };
  }

  // Etapa 1: productividad por artifact legacy
  {
    const productivityWizard = await loadLatestArtifact({
      userId,
      stage: 1,
      artifactType: "productivity_wizard_state",
      periodKey,
    });

    if (productivityWizard?.payload) {
      return {
        found: true,
        stage: 1,
        source: "artifact",
        sourceChatId: productivityWizard.chat_id ?? null,
        stateJson: productivityWizard.payload,
        meta: {
          artifactType: "productivity_wizard_state",
        },
      };
    }
  }

  // Etapa 0 draft
  if (contextRow?.status === "draft") {
    return {
      found: true,
      stage: 0,
      source: "context_draft",
      sourceChatId: contextRow.chat_id ?? null,
      stateJson:
        contextRow.context_json && typeof contextRow.context_json === "object"
          ? (contextRow.context_json as JsonMap)
          : {},
      meta: {
        status: "draft",
        contextText:
          typeof contextRow.context_text === "string"
            ? contextRow.context_text
            : null,
      },
    };
  }

  // Contexto confirmado sin etapas posteriores
  if (contextRow?.status === "confirmed") {
    return {
      found: true,
      stage: 1,
      source: "context_confirmed",
      sourceChatId: contextRow.chat_id ?? null,
      stateJson:
        contextRow.context_json && typeof contextRow.context_json === "object"
          ? (contextRow.context_json as JsonMap)
          : {},
      meta: {
        status: "confirmed",
        contextText:
          typeof contextRow.context_text === "string"
            ? contextRow.context_text
            : null,
      },
    };
  }

  return {
    found: false,
    stage: 0,
    source: "none",
    sourceChatId: null,
    stateJson: null,
    meta: null,
  };
}