// src/app/chat/_lib/turns/objectivesTurn.ts
//
// Turno del asesor para Etapa 6 (Objetivos), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import {
  isShortAffirmativeReply,
  looksLikeObjectivesClosureRequest,
  looksLikeStage6NextStepQuestion,
} from "@/lib/plan/advisorClientIntent";
import { isObjectivesReadyForValidation, type ObjectivesState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handleObjectivesTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; effectiveChatId: string; advisorChatId: string; ctx: PlanContextStatus; objectivesState: ObjectivesState }
) {
  const { setObjectivesState } = deps.state;
  const {
    callObjectivesAssistant,
    clearStageState,
    saveObjectivesState,
    validateObjectives,
  } = deps.api;
  const { appendAssistant } = deps.chat;
  const {
    applyBackendAdvisorAdvance,
    handleStage6NextStepQuestion,
    restoreLatestAdvisorStageToNewChat,
  } = deps.flow;
  const { text, effectiveChatId, advisorChatId, ctx, objectivesState } = turn;

  if (looksLikeStage6NextStepQuestion(text)) {
    await handleStage6NextStepQuestion({
      text,
      objectivesState,
      effectiveChatId,
      advisorChatId,
    });
    return;
  }

  const assistant = await callObjectivesAssistant({
    studentMessage: text,
    objectivesState,
    caseContext: (ctx.contextJson ?? null) as any,
    effectiveChatId,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
  const backendCode = assistant.payload?.code ?? null;
  const backendMessage =
    assistant.payload?.message ??
    assistant.payload?.detail?.message ??
    null;

  if (backendCode === "BAD_REQUEST") {
    setObjectivesState(null);
    await clearStageState(6, effectiveChatId);

    const restored = await restoreLatestAdvisorStageToNewChat(effectiveChatId);
    if (restored) {
      return;
    }
  }

  await appendAssistant(
    backendMessage
      ? `⚠️ ${backendMessage}`
      : "⚠️ No pude procesar tus objetivos en este momento. Cuéntame brevemente qué quieres mejorar y te ayudo a redactar un objetivo general."
  );
  return;
  }

  const nextState = assistant.payload.updates.nextState as ObjectivesState;

  setObjectivesState(nextState);
  await saveObjectivesState(nextState, effectiveChatId);

  await appendAssistant(assistant.payload.assistantMessage, assistant.signedReply);

  // Validamos Etapa 6 cuando el estado ya está en review
  // y el estudiante confirma cierre con una frase natural o una respuesta corta.
  if (nextState.step === "review" && isObjectivesReadyForValidation(nextState)) {
    const wantsToCloseObjectives =
      looksLikeObjectivesClosureRequest(text) || isShortAffirmativeReply(text);

    if (!wantsToCloseObjectives) {
      return;
    }

    const v = await validateObjectives(effectiveChatId);

    if (!v.ok) {
      const msg = v.payload?.message ?? "No se pudo cerrar Etapa 6 (Objetivos).";
      await appendAssistant(`⚠️ ${msg}`);
      return;
    }

    if (!v.payload?.valid) {
      const msg =
        v.payload?.message ??
        "La Etapa 6 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 7.";

      await appendAssistant(
        "Aún no podemos cerrar la **Etapa 6 (Objetivos)**.\n\n" +
          `⚠️ ${msg}\n\n` +
          "Cuando quieras, te ayudo a corregir exactamente lo que falta."
      );
      return;
    }

    const moved = await applyBackendAdvisorAdvance({
      fromStage: 6,
      payload: v.payload,
      effectiveChatId: advisorChatId,
    });

    if (!moved) {
      await appendAssistant(
        "✅ La Etapa 6 quedó validada, pero no pude preparar automáticamente la Etapa 7. Recarga el chat y retomamos."
      );
    }
    return;
  }
  return;
}
