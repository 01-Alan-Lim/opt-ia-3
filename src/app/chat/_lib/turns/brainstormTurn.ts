// src/app/chat/_lib/turns/brainstormTurn.ts
//
// Turno del asesor para Etapa 3 (Lluvia de ideas), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { wantsAdvanceStage, wantsKeepAdding } from "@/lib/plan/advisorClientIntent";
import {
  type BrainstormState,
  isBrainstormReadyToClose,
  resolveBrainstormStep,
  sanitizeBrainstormState,
} from "@/lib/plan/brainstormFlow";
import type { AdvisorTurnDeps, LastProductivityReport, PlanContextStatus } from "./types";

export async function handleBrainstormTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; advisorChatId: string; lastReport: LastProductivityReport; effectiveChatId: string; brainstormState: BrainstormState }
) {
  const {
    brainstormClosePending,
    fodaState,
    setBrainstormClosePending,
    setBrainstormState,
  } = deps.state;
  const { callBrainstormAssistant, saveBrainstormState, validateBrainstorm } = deps.api;
  const { appendAssistant } = deps.chat;
  const { applyBackendAdvisorAdvance } = deps.flow;
  const { text, ctx, advisorChatId, lastReport, effectiveChatId, brainstormState } = turn;

  const readyToClose = isBrainstormReadyToClose(brainstormState);

  // Si ya completó el mínimo y estamos esperando confirmación del estudiante:
  if (brainstormClosePending && readyToClose) {
    if (wantsAdvanceStage(text)) {
      const v = await validateBrainstorm();
      if (!v.ok) {
        const msg = v.payload?.message ?? "No se pudo cerrar Etapa 3.";
        await appendAssistant(`⚠️ ${msg}`);
        return;
      }



      const problemFromBrainstorm = (brainstormState?.problem?.text ?? "").trim();
      const problemFromFoda = (typeof (fodaState as any)?.problem === "string"
        ? ((fodaState as any).problem as string)
        : ((fodaState as any)?.problem?.text ?? "")
      ).trim();

      const problemFromContext = (
        ctx?.contextJson?.problem?.text ??
        ctx?.contextJson?.problem ??
        ""
      ).toString().trim();

      const finalProblem = (problemFromBrainstorm || problemFromFoda || problemFromContext).trim();

      setBrainstormClosePending(false);

      const moved = await applyBackendAdvisorAdvance({
        fromStage: 3,
        payload: v.payload,
        effectiveChatId: advisorChatId,
        initialProblemText: finalProblem || null,
      });

      if (!moved) {
        await appendAssistant(
          "✅ Etapa 3 validada, pero no pude preparar automáticamente Ishikawa. Recarga el chat para continuar."
        );
      }

      return;
    }

    if (wantsKeepAdding(text)) {
      // El estudiante quiere seguir: quitamos el “pendiente” y dejamos que el flujo normal procese la idea
      setBrainstormClosePending(false);
      // OJO: no hacemos return, para que el código continúe y procese la causa con el assistant
    } else {
      // Si responde algo ambiguo, pedimos confirmación clara
      await appendAssistant("¿Quieres **seguir agregando** causas o **pasamos a Ishikawa (Etapa 4)**?");
      return;
    }
  }

  const assistant = await callBrainstormAssistant({
    studentMessage: text,
    brainstormState,
    caseContext: ctx.contextJson,
    stage1Summary: lastReport.ok ? lastReport.payload : null,
    // Para no inventar otro endpoint, usamos el propio estado FODA si existe (si está validado, igual sirve como resumen)
    fodaSummary: fodaState ?? null,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
    const backendMessage =
      typeof assistant.payload?.message === "string" && assistant.payload.message.trim().length > 0
        ? assistant.payload.message.trim()
        : null;

    await appendAssistant(
      backendMessage ??
        "⚠️ Tuve un problema momentáneo para interpretar este turno de la Etapa 3. Vuelve a enviarlo y continuamos desde aquí."
    );
    return;
  }

  const nextState = sanitizeBrainstormState(assistant.payload.updates.nextState);

  await appendAssistant(assistant.payload.assistantMessage);

  setBrainstormState(nextState);
  await saveBrainstormState(nextState, effectiveChatId);

  // ✅ Si ya se completó el mínimo, NO cerramos automático: pedimos confirmación natural
  if (isBrainstormReadyToClose(nextState)) {
    setBrainstormClosePending(true);
    await appendAssistant(
      "✅ Ya tenemos suficientes causas.\n\n" +
      "¿Quieres **seguir agregando** más causas o **pasamos a la Etapa 4 (Ishikawa)**?"
    );
    return;
  }
  return;
}

export async function handleBrainstormStartTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; effectiveChatId: string }
): Promise<boolean> {
  const { setBrainstormState } = deps.state;
  const { getBrainstormState, saveBrainstormState } = deps.api;
  const { appendAssistant } = deps.chat;
  const { text, effectiveChatId } = turn;

  // Si el usuario escribe "etapa 3" o "lluvia" o "ideas", iniciamos.
  const t = text.toLowerCase();
  const wantsE3 = t.includes("etapa 3") || t.includes("lluvia") || t.includes("ideas") || t.includes("brainstorm");

  if (wantsE3) {
    const resBS = await getBrainstormState();
    const exists = resBS.ok && resBS.payload?.exists;

    if (!exists) {
      const initial: BrainstormState = {
        step: "choose_strategy",
        strategy: null,
        problem: null,
        ideas: [],
        minIdeas: 10,
      };

      setBrainstormState(initial);
      await saveBrainstormState(initial, effectiveChatId);

      await appendAssistant(
        "Perfecto 👍 Iniciamos la **Etapa 3: Lluvia de ideas (causas)**.\n\n" +
        "✅ Primero debes elegir tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
        "👉 Escríbeme: por ejemplo **FO** y dime el motivo en 1–2 líneas.\n\n" +
        "Luego definiremos la **problemática principal** y recién empezaremos con las causas."
      );
      return true;
    }

    const existingRaw = resBS.payload?.state ?? null;
    const existing = existingRaw ? sanitizeBrainstormState(existingRaw) : null;

    if (existing) {
      setBrainstormState(existing);

      const n = Array.isArray(existing.ideas) ? existing.ideas.length : 0;
      const step = resolveBrainstormStep(existing);

      if (step === "choose_strategy") {
        await appendAssistant(
          "📌 Retomemos tu **Etapa 3: Lluvia de ideas**.\n\n" +
            "Primero debemos elegir la **estrategia obligatoria**: **FO / DO / FA / DA**.\n\n" +
            "Si quieres, puedo ayudarte a escoger la más conveniente según tu FODA."
        );
        return true;
      }

      if (step === "define_problem") {
        await appendAssistant(
          `📌 Retomemos tu **Etapa 3**.\n\n` +
            `Estrategia elegida: **${existing.strategy?.type ?? "-"}**.\n\n` +
            "Ahora falta aterrizar la **problemática principal** que vas a trabajar.\n\n" +
            "Puedes escribirme tu propuesta y yo te ayudo a formularla mejor."
        );
        return true;
      }

      if (step === "review") {
        await appendAssistant(
          `📌 Retomemos tu **Etapa 3**.\n\n` +
            `Estrategia: **${existing.strategy?.type ?? "-"}**\n` +
            `Problema: **${existing.problem?.text ?? "(pendiente)"}**\n` +
            `Causas registradas: **${n}**.\n\n` +
            "✅ Ya cumples el mínimo. Puedes agregar más causas o decirme que pasemos a Ishikawa."
        );
        return true;
      }

      await appendAssistant(
        `📌 Retomemos tu **Etapa 3**.\n\n` +
          `Estrategia: **${existing.strategy?.type ?? "-"}**\n` +
          `Problema: **${existing.problem?.text ?? "(pendiente)"}**\n` +
          `Causas registradas: **${n}**.\n\n` +
          "👉 Continúa con otra causa y yo te ayudo a pulirla si hace falta."
      );
      return true;
    }
  }

  return false;
}
