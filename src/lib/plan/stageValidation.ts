// src/lib/plan/stageValidation.ts
import { supabaseServer } from "@/lib/supabaseServer";

type JsonMap = Record<string, unknown>;

export type ValidatedArtifactRow = {
  payload: JsonMap | null;
  chat_id: string | null;
  period_key: string | null;
  updated_at: string | null;
};

export type StageStateRow = {
  state_json: JsonMap | null;
  updated_at: string | null;
};

type LoadValidatedArtifactArgs = {
  userId: string;
  chatId: string;
  stage: number;
  artifactType: string;
  periodKey?: string;
};

type LoadValidatedArtifactResult =
  | { ok: true; row: ValidatedArtifactRow | null }
  | { ok: false; error: unknown };

export async function loadLatestValidatedArtifact(
  args: LoadValidatedArtifactArgs
): Promise<LoadValidatedArtifactResult> {
  const { userId, chatId, stage, artifactType, periodKey } = args;

  const baseSelect = "payload, chat_id, period_key, updated_at";

  const queries = periodKey
    ? [
        () =>
          supabaseServer
            .from("plan_stage_artifacts")
            .select(baseSelect)
            .eq("user_id", userId)
            .eq("chat_id", chatId)
            .eq("stage", stage)
            .eq("artifact_type", artifactType)
            .eq("period_key", periodKey)
            .eq("status", "validated")
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),

        () =>
          supabaseServer
            .from("plan_stage_artifacts")
            .select(baseSelect)
            .eq("user_id", userId)
            .eq("chat_id", chatId)
            .eq("stage", stage)
            .eq("artifact_type", artifactType)
            .eq("status", "validated")
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
      ]
    : [
        () =>
          supabaseServer
            .from("plan_stage_artifacts")
            .select(baseSelect)
            .eq("user_id", userId)
            .eq("chat_id", chatId)
            .eq("stage", stage)
            .eq("artifact_type", artifactType)
            .eq("status", "validated")
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
      ];

  for (const run of queries) {
    const result = await run();
    if (result.error) {
      return { ok: false, error: result.error };
    }
    if (result.data) {
      return {
        ok: true,
        row: result.data as ValidatedArtifactRow,
      };
    }
  }

  return { ok: true, row: null };
}





type LoadStageStateArgs = {
  userId: string;
  chatId: string;
  stage: number;
};

type LoadStageStateResult =
  | { ok: true; row: StageStateRow | null }
  | { ok: false; error: unknown };

export async function loadLatestStageStateByChat(
  args: LoadStageStateArgs
): Promise<LoadStageStateResult> {
  const { userId, chatId, stage } = args;

  const result = await supabaseServer
    .from("plan_stage_states")
    .select("state_json, updated_at")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", stage)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    row: result.data
      ? (result.data as StageStateRow)
      : null,
  };
}