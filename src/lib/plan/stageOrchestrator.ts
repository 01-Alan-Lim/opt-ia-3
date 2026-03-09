// src/lib/plan/stageOrchestrator.ts
import { supabaseServer } from "@/lib/supabaseServer";

type JsonMap = Record<string, unknown>;

export type PlanStage =
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

export type AdvancePlanStageResult = {
  advanced: boolean;
  fromStage: PlanStage;
  toStage: PlanStage | null;
  persisted: boolean;
  reason: "OK" | "FINAL_STAGE" | "MISSING_CHAT_ID";
};

const STAGE_FLOW: readonly PlanStage[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function getNextPlanStage(stage: PlanStage): PlanStage | null {
  const index = STAGE_FLOW.indexOf(stage);
  if (index === -1) return null;
  if (index >= STAGE_FLOW.length - 1) return null;
  return STAGE_FLOW[index + 1];
}

export async function advancePlanStage(args: {
  userId: string;
  chatId: string | null;
  fromStage: PlanStage;
  initialState?: JsonMap;
}): Promise<AdvancePlanStageResult> {
  const { userId, chatId, fromStage, initialState } = args;

  const toStage = getNextPlanStage(fromStage);

  if (toStage === null) {
    return {
      advanced: false,
      fromStage,
      toStage: null,
      persisted: false,
      reason: "FINAL_STAGE",
    };
  }

  if (!chatId) {
    return {
      advanced: true,
      fromStage,
      toStage,
      persisted: false,
      reason: "MISSING_CHAT_ID",
    };
  }

  const existing = await supabaseServer
    .from("plan_stage_states")
    .select("id")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", toStage)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }

  if (existing.data?.id) {
    return {
      advanced: true,
      fromStage,
      toStage,
      persisted: false,
      reason: "OK",
    };
  }

  const seedState = initialState ?? {};

  const inserted = await supabaseServer
    .from("plan_stage_states")
    .upsert(
      {
        user_id: userId,
        chat_id: chatId,
        stage: toStage,
        state_json: seedState,
      },
      { onConflict: "user_id,chat_id,stage" }
    )
    .select("id")
    .single();

  if (inserted.error || !inserted.data?.id) {
    throw inserted.error ?? new Error("No se pudo persistir la siguiente etapa.");
  }

  return {
    advanced: true,
    fromStage,
    toStage,
    persisted: true,
    reason: "OK",
  };
}