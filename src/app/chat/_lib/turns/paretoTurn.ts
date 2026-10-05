// src/app/chat/_lib/turns/paretoTurn.ts
//
// Turno del asesor para Etapa 5 (Pareto), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { normalizeParetoStateClient, type ParetoState } from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handleParetoTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; effectiveChatId: string; advisorChatId: string; paretoState: ParetoState }
) {
  const { setParetoState } = deps.state;
  const { callParetoAssistant, saveParetoState, validatePareto } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, ctx, effectiveChatId, advisorChatId, paretoState } = turn;

  const assistant = await callParetoAssistant({
    studentMessage: text,
    paretoState,
    caseContext: (ctx.contextJson ?? null) as any,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    await appendAssistant("⚠️ No pude procesar tu avance en Pareto. ¿Puedes reformular en 1–2 líneas lo que hiciste?");
    return;
  }

  const nextState = normalizeParetoStateClient(assistant.payload.updates.nextState);

  if (!nextState) {
    await appendAssistant("⚠️ El estado de Pareto llegó incompleto. Vuelve a enviar tu último avance para continuar.");
    return;
  }

  setParetoState(nextState);
  await saveParetoState(nextState, effectiveChatId);

  // Si aún no está cerrado, mostramos guía normal
  if (nextState.step !== "done") {
    await appendAssistant(assistant.payload.assistantMessage);
    return;
  }

  // Si llegó a done, primero validamos y recién luego cerramos de verdad
  const v = await validatePareto(effectiveChatId);

  if (!v.ok) {
    const rollbackState: ParetoState = {
      ...nextState,
      step: "collect_critical",
    };

    setParetoState(rollbackState);
    await saveParetoState(rollbackState, effectiveChatId);

    const msg =
      v.payload?.message ??
      "No se pudo cerrar Etapa 5 (Pareto). Revisa que hayas enviado tu grupo crítico y el porcentaje del problema que concentra.";
    await appendAssistant(`⚠️ ${msg}`);
    return;
  }

  if (!v.payload?.valid) {
    const rollbackState: ParetoState = {
      ...nextState,
      step: "collect_critical",
    };

    setParetoState(rollbackState);
    await saveParetoState(rollbackState, effectiveChatId);

    const msg =
      v.payload?.message ??
      "Pareto aún no quedó validado. Revisa tu grupo crítico antes de pasar a Objetivos.";
    await appendAssistant(`⚠️ ${msg}`);
    return;
  }

  await appendAssistant(assistant.payload.assistantMessage);

  const moved = await applyBackendAdvisorAdvance({
    fromStage: 5,
    payload: v.payload,
    effectiveChatId: advisorChatId,
  });

  if (!moved) {
    await appendAssistant(
      "✅ La Etapa 5 quedó validada, pero no pude preparar automáticamente la Etapa 6. Recarga el chat y retomamos."
    );
  }

  return;
}
