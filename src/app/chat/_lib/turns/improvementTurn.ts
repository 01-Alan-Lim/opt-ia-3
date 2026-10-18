// src/app/chat/_lib/turns/improvementTurn.ts
//
// Turno del asesor para Etapa 7 (Plan de Mejora), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import type { ImprovementState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handleImprovementTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; effectiveChatId: string; advisorChatId: string; improvementState: ImprovementState }
) {
  const { setImprovementState } = deps.state;
  const { callImprovementAssistant, saveImprovementState, validateImprovement } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, ctx, effectiveChatId, advisorChatId, improvementState } = turn;

  const assistant = await callImprovementAssistant({
    studentMessage: text,
    improvementState,
    caseContext: (ctx.contextJson ?? null) as any,
    effectiveChatId,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    const backendMsg =
      typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
        ? `⚠️ ${assistant.payload.message}`
        : "⚠️ No pude procesar tu Plan de Mejora. Dime en 1 o 2 líneas qué parte quieres ajustar o si quieres que revise si ya está listo.";
    await appendAssistant(backendMsg);
    return;
  }

  const nextState = assistant.payload.updates.nextState as ImprovementState;
  const shouldValidateNow = assistant.payload?.decision?.shouldValidateNow === true;

  setImprovementState(nextState);
  await saveImprovementState(nextState, effectiveChatId);

  await appendAssistant(assistant.payload.assistantMessage, assistant.signedReply);

  if (!shouldValidateNow) {
    return;
  }

  const v = await validateImprovement(effectiveChatId);

  if (!v.ok) {
    const msg = v.payload?.message ?? "No se pudo cerrar Etapa 7 (Plan de Mejora).";
    await appendAssistant(`⚠️ ${msg}`);
    return;
  }

  if (!v.payload?.valid) {
    const msg =
      v.payload?.message ??
      "La Etapa 7 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 8.";

    await appendAssistant(
      "Aún no podemos cerrar la **Etapa 7 (Plan de Mejora)**.\n\n" +
        `⚠️ ${msg}\n\n` +
        "Si quieres, te ayudo a corregir exactamente lo que falta."
    );
    return;
  }

  const moved = await applyBackendAdvisorAdvance({
    fromStage: 7,
    payload: v.payload,
    effectiveChatId: advisorChatId,
  });

  if (!moved) {
    await appendAssistant(
      "✅ La Etapa 7 quedó validada, pero no pude preparar automáticamente la Etapa 8. Recarga el chat y retomamos."
    );
  }

  return;
}
