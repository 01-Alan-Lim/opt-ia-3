// src/app/chat/_lib/turns/planningTurn.ts
//
// Turno del asesor para Etapa 8 (Planificación), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import type { PlanningState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handlePlanningTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; effectiveChatId: string; advisorChatId: string; planningState: PlanningState }
) {
  const { setPlanningState } = deps.state;
  const { callPlanningAssistant, savePlanningState, validatePlanning } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, ctx, effectiveChatId, advisorChatId, planningState } = turn;

  const assistant = await callPlanningAssistant({
    studentMessage: text,
    planningState,
    caseContext: (ctx.contextJson ?? null) as any,
    effectiveChatId,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    const backendMsg =
      typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
        ? `⚠️ ${assistant.payload.message}`
        : "⚠️ No pude procesar tu Planificación. Dime en 1 línea cuántas semanas te quedan o qué parte del cronograma quieres ajustar.";
    await appendAssistant(backendMsg);
    return;
  }

  const nextState = assistant.payload.updates.nextState as PlanningState;
  const shouldValidateNow = assistant.payload?.decision?.shouldValidateNow === true;

  setPlanningState(nextState);
  await savePlanningState(nextState, effectiveChatId);

  await appendAssistant(assistant.payload.assistantMessage);

  if (!shouldValidateNow) {
    return;
  }

  const v = await validatePlanning(effectiveChatId);

  if (!v.ok) {
    const msg = v.payload?.message ?? "No se pudo cerrar Etapa 8 (Planificación).";
    await appendAssistant(`⚠️ ${msg}`);
    return;
  }

  if (!v.payload?.valid) {
    const msg =
      v.payload?.message ??
      "La Etapa 8 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 9.";

    await appendAssistant(
      "Aún no podemos cerrar la **Etapa 8 (Planificación)**.\n\n" +
        `⚠️ ${msg}\n\n` +
        "Si quieres, te ayudo a completar exactamente lo que falta."
    );
    return;
  }

  const moved = await applyBackendAdvisorAdvance({
    fromStage: 8,
    payload: v.payload,
    effectiveChatId: advisorChatId,
  });

  if (!moved) {
    await appendAssistant(
      "✅ La Etapa 8 quedó validada, pero no pude preparar automáticamente la Etapa 9. Recarga el chat y retomamos."
    );
  }

  return;
}
