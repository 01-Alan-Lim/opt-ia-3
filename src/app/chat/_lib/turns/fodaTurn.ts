// src/app/chat/_lib/turns/fodaTurn.ts
//
// Turno del asesor para Etapa 2 (FODA), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { isReadyIntent, normalizeText } from "@/lib/plan/advisorClientIntent";
import { isFodaComplete, type FodaState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handleFodaCloseTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; advisorChatId: string }
): Promise<boolean> {
  const { validateFoda } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, advisorChatId } = turn;

  const t = normalizeText(text);
  const wantsNext =
    isReadyIntent(text) ||
    t.includes("que sigue") ||
    t.includes("siguiente") ||
    t.includes("pasamos") ||
    t.includes("continuar");

  if (wantsNext) {
    const v = await validateFoda();
    if (!v?.ok) {
      await appendAssistant(
        v?.payload?.message ??
          "⚠️ Aún no puedo validar el FODA. Revisa que haya 3 puntos en cada cuadrante y sustento en O/A."
      );
      return true;
    }

    const moved = await applyBackendAdvisorAdvance({
      fromStage: 2,
      payload: v.payload,
      effectiveChatId: advisorChatId,
    });

    if (!moved) {
      await appendAssistant(
        "✅ FODA validado, pero no pude preparar automáticamente la Etapa 3. Recarga el chat para continuar."
      );
    }

    return true;

  }

  return false;
}

export async function handleFodaTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; advisorChatId: string; fodaState: FodaState }
) {
  const { setFodaState } = deps.state;
  const { callFodaAssistant, getFodaSaveErrorMessage, saveFodaState, validateFoda } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, ctx, advisorChatId, fodaState } = turn;

  const assistant = await callFodaAssistant({
    studentMessage: text,
    fodaState,
    caseContext: ctx.contextJson,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    const backendMessage =
      typeof assistant.payload?.message === "string" && assistant.payload.message.trim().length > 0
        ? assistant.payload.message.trim()
        : null;

    await appendAssistant(
      backendMessage ??
        "⚠️ Seguimos en esta parte del FODA, pero tuve un problema momentáneo para procesar tu mensaje. Vuelve a enviarlo y continuamos desde aquí."
    );
    return;
  }

  const nextState = assistant.payload.updates.nextState as FodaState;
  const action = assistant.payload.updates?.action as string | undefined;

  // 1) mostrar respuesta “docente”
  await appendAssistant(assistant.payload.assistantMessage);

  // 2) aplicar estado y guardar
  setFodaState(nextState);

  const saveResult = await saveFodaState(nextState, advisorChatId);
  if (!saveResult.ok) {
    await appendAssistant(getFodaSaveErrorMessage(saveResult));
    return;
  }

  // 3) ✅ Si ya está completo (o el LLM lo marca como complete) → VALIDAR y saltar a Etapa 3
  const completed = action === "complete" || isFodaComplete(nextState);

  if (completed) {
    const v = await validateFoda();

  if (!v?.ok) {
    const msg =
      v?.payload?.message ??
      "⚠️ Aún no puedo validar el FODA. Revisa que haya 3 puntos en cada cuadrante y sustento en O/A.";
    await appendAssistant(msg);
    return;
  }

  const moved = await applyBackendAdvisorAdvance({
    fromStage: 2,
    payload: v.payload,
    effectiveChatId: advisorChatId,
  });

  if (!moved) {
    await appendAssistant(
      "✅ FODA validado, pero no pude preparar automáticamente la Etapa 3. Recarga el chat para continuar."
    );
  }

  return;
  }

  return; // importante: ya atendimos FODA
}
