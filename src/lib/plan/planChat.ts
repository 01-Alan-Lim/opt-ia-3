// src/lib/plan/planChat.ts
//
// Chat principal del Plan de Mejora. El estudiante tiene un solo plan (plan_case_contexts, una fila
// por user_id) y lo trabaja en un solo chat del asesor. Las etapas E1-E10 guardan su estado por
// chat (plan_stage_states es única por user_id + chat_id + stage), así que abrir otro chat del
// asesor fragmentaba el plan: estados copiados en cada chat y una apertura de E0 en cada uno.
//
// Cuál es el chat del plan (resolvePlanChatId). Siempre un chat del estudiante de la sesión y en
// modo plan_mejora; el userId lo pone el servidor (requireUser), nunca el cliente:
//   1. el chat del estado de etapa más reciente, porque ahí está el avance real. Cubre a quienes
//      trabajaron en varios chats antes de esta regla sin copiar, mover ni reasignar sus estados;
//   2. si no, plan_case_contexts.chat_id;
//   3. si no hay ninguno, el plan todavía no tiene chat y claimPlanChat le asigna el primero: el
//      chat del asesor desde el que llega la petición si es del estudiante, o uno nuevo.
// Resolver no escribe nada. No decide la etapa: eso lo sigue haciendo activeStage.ts con sus puertas.
//
// claimPlanChat asigna el chat al plan con una escritura condicional (solo si
// plan_case_contexts.chat_id sigue como se leyó, o si la fila no existe todavía). Si dos peticiones
// compiten (dos pestañas en el primer acceso), gana una: la otra devuelve el chat del plan y, si
// había creado uno, lo oculta (hidden, como "Eliminar" de la barra lateral; no se borra).

import { supabaseServer } from "@/lib/supabaseServer";

export const PLAN_CHAT_TITLE = "Asesor - Contexto del Caso";

async function isUsablePlanChat(userId: string, chatId: string | null | undefined): Promise<boolean> {
  if (!chatId) return false;
  const { data, error } = await supabaseServer
    .from("chats")
    .select("id, client_id, mode")
    .eq("id", chatId)
    .maybeSingle();
  if (error || !data) return false;
  return data.client_id === userId && data.mode === "plan_mejora";
}

export async function resolvePlanChatId(userId: string, contextChatId: string | null): Promise<string | null> {
  const { data: latest, error } = await supabaseServer
    .from("plan_stage_states")
    .select("chat_id")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) console.warn("[plans] planChat: lectura del último estado", error.code);

  const progressChatId = typeof latest?.chat_id === "string" ? latest.chat_id : null;
  if (progressChatId && progressChatId !== contextChatId && (await isUsablePlanChat(userId, progressChatId))) {
    return progressChatId;
  }
  return (await isUsablePlanChat(userId, contextChatId)) ? contextChatId : null;
}

export type PlanChatClaim = { ok: true; chatId: string; created: boolean } | { ok: false; message: string };

// seenChatId: plan_case_contexts.chat_id tal como se leyó (null si no había fila o chat).
// candidateChatId: un chat del asesor del estudiante desde el que llega la petición; si es válido,
// pasa a ser el del plan en lugar de crear otro. Si pierde la carrera no se oculta: no lo creó esta
// petición.
export async function claimPlanChat(
  userId: string,
  seenChatId: string | null,
  candidateChatId: string | null = null
): Promise<PlanChatClaim> {
  let chatId: string;
  let created = false;
  if (candidateChatId && (await isUsablePlanChat(userId, candidateChatId))) {
    chatId = candidateChatId;
  } else {
    const { data: newChat, error: createError } = await supabaseServer
      .from("chats")
      .insert({ client_id: userId, title: PLAN_CHAT_TITLE, mode: "plan_mejora" })
      .select("id")
      .single();
    if (createError || !newChat?.id) {
      console.error("[plans] planChat: creación de chat", createError?.code);
      return { ok: false, message: "No se pudo crear el chat para el asesor." };
    }
    chatId = newChat.id as string;
    created = true;
  }

  // Se asigna al plan solo si nadie lo cambió desde que se leyó.
  const assign = supabaseServer.from("plan_case_contexts").update({ chat_id: chatId }).eq("user_id", userId);
  const { data: assigned, error: assignError } = await (seenChatId
    ? assign.eq("chat_id", seenChatId)
    : assign.is("chat_id", null)
  ).select("chat_id");
  if (!assignError && Array.isArray(assigned) && assigned.length > 0) return { ok: true, chatId, created };

  // Sin fila del plan: se crea con este chat. Si otra petición la creó a la vez, falla por el
  // índice único de user_id y gana la suya.
  if (!assignError) {
    const { error: insertError } = await supabaseServer.from("plan_case_contexts").insert({
      user_id: userId,
      chat_id: chatId,
      status: "draft",
      version: 1,
      context_json: {},
      context_text: null,
    });
    if (!insertError) return { ok: true, chatId, created };
    if (insertError.code !== "23505") console.error("[plans] planChat: alta del plan", insertError.code);
  }

  const { data: row } = await supabaseServer
    .from("plan_case_contexts")
    .select("chat_id")
    .eq("user_id", userId)
    .maybeSingle();
  const winner = typeof row?.chat_id === "string" ? row.chat_id : null;
  if (winner === chatId) return { ok: true, chatId, created };
  if (winner && (await isUsablePlanChat(userId, winner))) {
    if (created) {
      await supabaseServer.from("chats").update({ hidden: true }).eq("id", chatId).eq("client_id", userId);
    }
    return { ok: true, chatId: winner, created: false };
  }

  console.error("[plans] planChat: no se pudo asignar el chat al plan");
  return { ok: false, message: "No se pudo preparar el chat del Plan de Mejora. Intenta nuevamente." };
}

// El chat del plan, o el primero si todavía no hay: lo usan /api/plans/context y /api/plans/review.
// candidateChatId: el chat del asesor desde el que llega la petición (ver claimPlanChat).
export async function ensurePlanChat(
  userId: string,
  contextChatId: string | null,
  candidateChatId: string | null = null
): Promise<PlanChatClaim> {
  const existing = await resolvePlanChatId(userId, contextChatId);
  if (existing) return { ok: true, chatId: existing, created: false };
  return claimPlanChat(userId, contextChatId, candidateChatId);
}
