// src/app/chat/_lib/turns/ishikawaTurn.ts
//
// Turno del asesor para Etapa 4 (Ishikawa), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { normalizeText, wantsAdvanceStage, wantsKeepAdding } from "@/lib/plan/advisorClientIntent";
import type { IshikawaState } from "../advisorTransitions";
import type { AdvisorTurnDeps, LastProductivityReport, PlanContextStatus } from "./types";

export async function handleIshikawaTurn(
  deps: AdvisorTurnDeps,
  turn: { effectiveIshikawaState: IshikawaState; effectiveChatId: string; text: string; advisorChatId: string; ctx: PlanContextStatus; lastReport: LastProductivityReport }
) {
  const {
    brainstormState,
    chatIdRef,
    ishikawaClosePending,
    messagesRef,
    setIshikawaClosePending,
    setIshikawaState,
  } = deps.state;
  const { callIshikawaAssistant, getIshikawaState, saveIshikawaState, validateIshikawa } = deps.api;
  const { appendAssistant, buildRecentMessagesForIshikawa } = deps.chat;
  const {
    applyBackendAdvisorAdvance,
    isIshikawaReadyToClose,
    shouldOfferIshikawaStageClose,
  } = deps.flow;
  const { effectiveIshikawaState, effectiveChatId, text, advisorChatId, ctx, lastReport } = turn;

  const ishikawaState = effectiveIshikawaState;
  // 1) Si aún no hay problema, el primer mensaje del estudiante se toma como problema (1 línea)
  const problemText =
    typeof ishikawaState.problem === "string"
      ? ishikawaState.problem
      : (typeof ishikawaState.problem?.text === "string" ? ishikawaState.problem.text : "");

  if (!problemText.trim()) {
    const hasConversation = messagesRef.current.length > 0;

    // ✅ Si ya hay conversación, NO asumas que estamos empezando Ishikawa.
    // Probablemente llegó un ishikawaState desfasado/vacío (race).
    if (hasConversation) {
    const resIshFresh = await getIshikawaState({
      chatId: effectiveChatId ?? chatIdRef.current ?? null,
    });
    const freshState = resIshFresh.ok && resIshFresh.payload?.exists && resIshFresh.payload?.state
      ? (resIshFresh.payload.state as IshikawaState)
      : null;

      if (freshState) {
        setIshikawaState(freshState);
        await saveIshikawaState(freshState, effectiveChatId);

        // No agregamos ningún mensaje robótico.
        // Reintentamos el flujo normal (Gemini) con el state ya sincronizado.
        const ai = await callIshikawaAssistant({
          studentMessage: text,
          chatId: advisorChatId,
          ishikawaState: freshState,
          caseContext: ctx?.contextJson ?? null,
          stage1Summary: null,
          brainstormState: null,
          recentMessages: buildRecentMessagesForIshikawa(6),
        });

        if (ai.ok) {
          setIshikawaState(ai.nextState);
          await saveIshikawaState(ai.nextState, effectiveChatId);
          await appendAssistant(ai.assistantMessage, ai.signedReply);
        } else {
          await appendAssistant("⚠️ Estoy detectando que el Ishikawa no tiene el problema cargado. ¿Puedes volver a pegar el problema principal en 1 línea?");
        }

        return;
      }

      // Si no logramos refrescar el state, pedimos el problema sin reiniciar el chat.
      await appendAssistant("⚠️ Parece que no tengo el **problema principal** en el Ishikawa. Pégalo en **1 línea** y seguimos con la misma categoría.");
      return;
    }

    // ✅ Caso real de inicio (no hay conversación): aquí sí tomamos el primer mensaje como problema.
    const next: IshikawaState = {
      ...ishikawaState,
      problem: { text: text.trim().slice(0, 1200) },
    };
    setIshikawaState(next);
    await saveIshikawaState(next, effectiveChatId);

    // 🔁 En vez de un texto robótico fijo, pedimos 1ra causa de forma corta y natural:
    await appendAssistant(
      "Perfecto — ya registré el problema. 🙌\n\n" +
      "Ahora dime **una causa concreta** (qué pasa / dónde pasa) y la ubico en Hombre/Máquina/Método/etc., y empezamos con los **¿por qué?**."
    );
    return;
  }


  // ✅ Si el usuario solo confirma (OK/Sí) al iniciar Ishikawa, NO lo mandamos al assistant.
  // Esto evita el loop de “No pude ubicar tu respuesta”.
  const tConfirm = normalizeText(text).trim();

  // ✅ Acepta confirmaciones aunque tengan texto extra: "ok, está bien", "sí ok", "listo entonces"
  const isConfirmOnly = /^(ok|okey|okay|si|sí|listo|dale|vamos)\s*[!.?,]*\s*$/.test(tConfirm);

  const hasAnyCauses = (ishikawaState.categories ?? []).some((c) => {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    return mains.length > 0;
  });

  const tNorm = normalizeText(text);
  const isBareAdvance =
    isConfirmOnly || (wantsAdvanceStage(text) && tNorm.split(" ").length <= 4);

  if (isBareAdvance && !hasAnyCauses) {
    await appendAssistant(
      "✅ **Etapa 4 – Análisis de Causa Raíz (Ishikawa + 5 Porqués)**\n\n" +
      `🎯 **Problema principal:**\n${problemText}\n\n` +
      "Vamos a trabajar como en clase:\n" +
      "👉 **Primer paso:** responde a esta pregunta:\n\n" +
      `❓ **¿Por qué ocurre este problema?**\n\n` +
      "Escribe una causa que tú consideres importante. Puede venir de la lluvia de ideas que ya hicimos.\n\n" +
      "Yo me encargo de ubicarla en la categoría correcta (Hombre, Máquina, Método, etc.) y luego bajamos con más **porqués** hasta llegar a la causa raíz."
    );
    return;
  }

  // Si ya estábamos pidiendo confirmación para pasar a Pareto
  if (ishikawaClosePending && isIshikawaReadyToClose(ishikawaState)) {
    if (wantsAdvanceStage(text)) {
      const v = await validateIshikawa();
      if (!v.ok) {
        const msg = v.payload?.message ?? "No se pudo cerrar Etapa 4.";
        await appendAssistant(`⚠️ ${msg}`);
        return;
      }

      setIshikawaClosePending(false);

      const moved = await applyBackendAdvisorAdvance({
        fromStage: 4,
        payload: v.payload,
        effectiveChatId: advisorChatId,
      });

      if (!moved) {
        await appendAssistant(
          "✅ Ishikawa validado, pero no pude preparar automáticamente la Etapa 5. Recarga el chat para continuar desde Pareto."
        );
      }

      return;
    }

    if (wantsKeepAdding(text)) {
      setIshikawaClosePending(false);
      // seguimos normal para refinar
    } else {
      await appendAssistant(
        "Ya tenemos una base suficiente del Ishikawa.\n\n" +
          "Ahora tú decides cómo seguir:\n" +
          "• podemos revisar o ajustar alguna causa\n" +
          "• agregar otra subcausa o ir a otra categoría\n" +
          "• o pasar a Pareto (Etapa 5)\n\n" +
          "Dime qué prefieres."
      );
      return;
    }
  }

  // 2) Ya hay problema: delegamos al assistant para clasificar + guiar + 5 porqués
  const assistant = await callIshikawaAssistant({
    studentMessage: text,
    chatId: advisorChatId,
    ishikawaState,
    caseContext: ctx.contextJson ?? null,
    stage1Summary: lastReport.ok ? lastReport.payload ?? null : null,
    brainstormState: brainstormState ?? null,
    recentMessages: buildRecentMessagesForIshikawa(6),
  });

  const nextState = assistant.nextState ?? ishikawaState;
  setIshikawaState(nextState);
  await saveIshikawaState(nextState, effectiveChatId);

  await appendAssistant(assistant.assistantMessage, assistant.signedReply);

  // ✅ Solo ofrecemos pasar de etapa si el servidor lo admite en este turno (no justo tras cerrar una rama)
  if (shouldOfferIshikawaStageClose(nextState, assistant.ui)) {
    setIshikawaClosePending(true);
    await appendAssistant(
      "✅ Ya tenemos una base suficiente del Ishikawa. " +
        "Si quieres, podemos **seguir refinando**, **revisar otra causa o categoría**, o **pasar a la Etapa 5 (Pareto)**."
    );
  } else {
    setIshikawaClosePending(false);
  }
  return;
}
