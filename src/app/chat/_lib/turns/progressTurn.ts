// src/app/chat/_lib/turns/progressTurn.ts
//
// Turno del asesor para Etapa 9 (Reporte de avances), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { looksLikeProgressClosureRequest } from "@/lib/plan/advisorClientIntent";
import { isProgressReadyForValidation, type ProgressState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps } from "./types";

export async function handleProgressTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; effectiveChatId: string; advisorChatId: string; progressState: ProgressState }
) {
  const { setProgressState } = deps.state;
  const { callProgressAssistant, saveProgressState, validateProgress } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, effectiveChatId, advisorChatId, progressState } = turn;

  const assistant = await callProgressAssistant({
    studentMessage: text,
    progressState,
    effectiveChatId,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    const backendMsg =
      typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
        ? `⚠️ ${assistant.payload.message}`
        : "⚠️ No pude procesar tu reporte. Cuéntame brevemente qué lograste implementar hasta hoy.";
    await appendAssistant(backendMsg);
    return;
  }

  const nextState = assistant.payload.updates.nextState as ProgressState;

  setProgressState(nextState);
  await saveProgressState(nextState, effectiveChatId);

  await appendAssistant(assistant.payload.assistantMessage, assistant.signedReply);

  const progressAction = assistant.payload?.updates?.action;

  if (nextState.step === "review" && isProgressReadyForValidation(nextState)) {
    const shouldValidateNow =
      progressAction === "ready_to_validate" ||
      looksLikeProgressClosureRequest(text);

    if (!shouldValidateNow) {
      return;
    }

    const v = await validateProgress(effectiveChatId);

    if (!v.ok) {
      await appendAssistant("⚠️ No se pudo cerrar el reporte de avances.");
      return;
    }

    if (v.payload?.valid) {
      const moved = await applyBackendAdvisorAdvance({
        fromStage: 9,
        payload: v.payload,
        effectiveChatId: advisorChatId,
      });

      if (!moved) {
        await appendAssistant(
          "✅ La Etapa 9 quedó validada, pero no pude preparar automáticamente la Etapa 10. Recarga el chat y retomamos."
        );
      }
      return;
    }

    await appendAssistant(
      `⚠️ ${v.payload?.message ?? "Todavía falta ajustar la Etapa 9 antes de cerrarla."}`
    );
  }

  return;
}
