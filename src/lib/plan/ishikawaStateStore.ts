// src/lib/plan/ishikawaStateStore.ts

// Lectura y escritura del estado de Ishikawa (E4) en plan_stage_states. Solo servidor.
//
// Escritores de la fila (user_id, chat_id, stage = 4) en un turno normal:
// 1. ishikawa/assistant, ANTES de responder y solo si el turno cambió campos de autoridad del
//    servidor (closure, rejectedWhyAttempts, reformulateWhy, registro de raíces). Relee la
//    fila justo antes de escribir y fusiona su estado del turno encima (ganan sus campos).
// 2. ishikawa/state, DESPUÉS, cuando el cliente guarda lo que recibió. Fusiona el árbol del
//    cliente pero toma los campos del servidor de lo almacenado, así que nunca pisa lo que
//    escribió el asistente: para esos campos gana siempre el asistente.
// Sin bloqueo optimista: si dos turnos del asistente del mismo chat se cruzan (dos pestañas),
// gana el último en escribir. La tabla tiene updated_at con trigger BEFORE UPDATE, que
// permitiría un control optimista más adelante sin migración.

import { supabaseServer } from "@/lib/supabaseServer";

const STAGE = 4;

export type StoredIshikawaState = {
  // Fila de este chat (base de la fusión del árbol). null si todavía no existe.
  exact: unknown;
  // De dónde salen los campos del servidor: la fila de este chat o, si aún no existe, la
  // última fila de E4 del usuario (el mismo criterio con que se retoma la etapa en otro chat).
  serverSource: unknown;
};

type LoadResult = { ok: true; value: StoredIshikawaState } | { ok: false; error: unknown };
type WriteResult = { ok: true } | { ok: false; error: unknown };

export async function loadStoredIshikawaState(userId: string, chatId: string): Promise<LoadResult> {
  const exact = await supabaseServer
    .from("plan_stage_states")
    .select("state_json")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", STAGE)
    .maybeSingle();

  if (exact.error) return { ok: false, error: exact.error };

  const exactState: unknown = exact.data?.state_json ?? null;
  if (exactState) return { ok: true, value: { exact: exactState, serverSource: exactState } };

  const latest = await supabaseServer
    .from("plan_stage_states")
    .select("state_json")
    .eq("user_id", userId)
    .eq("stage", STAGE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest.error) return { ok: false, error: latest.error };

  const latestState: unknown = latest.data?.state_json ?? null;
  return { ok: true, value: { exact: null, serverSource: latestState } };
}

export async function writeIshikawaStateRow(
  userId: string,
  chatId: string,
  stateJson: unknown
): Promise<WriteResult> {
  const { error } = await supabaseServer.from("plan_stage_states").upsert(
    {
      user_id: userId,
      chat_id: chatId,
      stage: STAGE,
      state_json: stateJson,
    },
    { onConflict: "user_id,chat_id,stage" }
  );

  return error ? { ok: false, error } : { ok: true };
}
