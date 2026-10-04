// src/lib/plan/finalDocStore.ts

// Campos de autoridad del servidor en la Etapa 10, leídos y escritos en la base por
// final_doc/assistant. Antes viajaban por el cliente (assistant -> navegador ->
// stage-state) y final_doc/validate cerraba el plan con lo que llegara en el cuerpo:
// un estudiante podía ponerse total_label "Bien" o mandar versionNumber 2, que cierra
// siempre. Ahora el guardado del cliente los descarta (stageAuthority) y validate lee lo
// que escribió el servidor.

import { supabaseServer } from "@/lib/supabaseServer";
import { normalizeStageState } from "@/lib/plan/stageState";

const STAGE = 10;

export type FinalDocVersionNumber = 1 | 2;

type JsonRecord = Record<string, unknown>;

export type FinalDocUpload = {
  fileName: string;
  storagePath: string;
  extractedText: string;
  uploadedAt: string;
};

export type SaveFinalDocServerFieldsArgs = {
  userId: string;
  chatId: string;
  periodKey: string;
  versionNumber: FinalDocVersionNumber;
  evaluation: JsonRecord | null;
  extractedSections: JsonRecord | null;
  upload: FinalDocUpload;
};

export type SaveFinalDocServerFieldsResult =
  | { ok: true; stateJson: JsonRecord }
  | { ok: false; error: unknown };

export type ResolveVersionResult =
  | { ok: true; versionNumber: FinalDocVersionNumber; alreadyClosed: boolean }
  | { ok: false; error: unknown };

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

// Qué versión corresponde a esta entrega, según lo que ya está guardado. NO se pregunta al
// cliente: mandar versionNumber 2 cerraba la etapa sin importar la nota
// (final_doc/validate: isV2 => shouldClose).
//   - ya hay final_doc_final  -> la etapa está cerrada (alreadyClosed)
//   - ya hay final_doc_v1     -> esta entrega es la v2
//   - si no                   -> es la v1
export async function resolveFinalDocVersionNumber(args: {
  userId: string;
  periodKey: string;
}): Promise<ResolveVersionResult> {
  const { userId, periodKey } = args;

  const { data, error } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("artifact_type, status")
    .eq("user_id", userId)
    .eq("stage", STAGE)
    .eq("period_key", periodKey)
    .in("artifact_type", ["final_doc_v1", "final_doc_final"]);

  if (error) return { ok: false, error };

  const rows = Array.isArray(data) ? data : [];

  const alreadyClosed = rows.some(
    (row) => row.artifact_type === "final_doc_final" && row.status === "validated"
  );
  const hasV1 = rows.some((row) => row.artifact_type === "final_doc_v1");

  return {
    ok: true,
    versionNumber: hasV1 ? 2 : 1,
    alreadyClosed,
  };
}

// Escribe en plan_stage_states lo que decidió el servidor en este turno, conservando el
// resto del estado guardado (step, lastFeedback…). Se llama ANTES de responderle al
// cliente, igual que ishikawa/assistant con sus campos.
export async function saveFinalDocServerFields(
  args: SaveFinalDocServerFieldsArgs
): Promise<SaveFinalDocServerFieldsResult> {
  const { userId, chatId, versionNumber, evaluation, extractedSections, upload } = args;

  const existing = await supabaseServer
    .from("plan_stage_states")
    .select("state_json")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", STAGE)
    .maybeSingle();

  if (existing.error) return { ok: false, error: existing.error };

  const stored = asRecord(existing.data?.state_json) ?? {};

  const nextState = normalizeStageState(STAGE, {
    ...stored,
    step: "review",
    versionNumber,
    upload,
    extractedSections,
    evaluation,
  });

  const saved = await supabaseServer
    .from("plan_stage_states")
    .upsert(
      {
        user_id: userId,
        chat_id: chatId,
        stage: STAGE,
        state_json: nextState,
      },
      { onConflict: "user_id,chat_id,stage" }
    )
    .select("state_json")
    .single();

  if (saved.error) return { ok: false, error: saved.error };

  return { ok: true, stateJson: nextState };
}
