// src/app/chat/_lib/turns/productivityTurn.ts
//
// Turno del asesor para Etapa 1 (Productividad), movido tal cual desde handleSend (page.tsx).
// handleSend sigue decidiendo cuándo entra cada rama (misma condición, mismo orden) y retorna
// después; aquí queda la conversación, el guardado, la validación y la transición de la etapa.

import { isProdQuestion, isReadyIntent } from "@/lib/plan/advisorClientIntent";
import { promptProd } from "@/lib/plan/advisorMessages";
import {
  applyAssistantPatchToDraft,
  mergeCosts,
  type FodaState,
  type ProdStep,
  type ProductivityDraft,
} from "@/lib/plan/advisorStates";
import type { AdvisorTurnDeps, PlanContextStatus } from "./types";

export async function handleProductivityStartTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus }
) {
  const { clientId, prodDraft, setActiveAdvisorStage, setProdDraft, setProdStep } = deps.state;
  const { appendAssistant } = deps.chat;
  const { setAwaitingStage1Start } = deps.flow;
  const { text, ctx } = turn;

  // si el usuario pregunta (no robótico), respondemos y re-preguntamos el paso actual
  if (isProdQuestion(text) && !isReadyIntent(text)) {
    await appendAssistant(
      "Claro 🙂 En esta etapa trabajaremos una **medición básica de productividad mensual**.\n\n" +
        "Necesito una línea, producto o servicio concreto, junto con **ingresos del mes** y **costos del mes**.\n\n" +
        "No te preocupes: iremos paso a paso."
    );

    setActiveAdvisorStage(1);
    setProdStep(1);

    await appendAssistant(promptProd(1, ctx.contextJson, prodDraft));
    return;
  }

  // Si escribe "productividad", iniciar Etapa 1
  if (text.toLowerCase().includes("productividad")) {
    setAwaitingStage1Start(clientId, false);

    const products = Array.isArray(ctx.contextJson?.products)
      ? ctx.contextJson.products.filter(Boolean)
      : [];
    const autoLine = products.length === 1 ? String(products[0]) : undefined;

    setActiveAdvisorStage(1);
    setProdDraft({ line: autoLine, required_costs: 3 });
    setProdStep(1);

    await appendAssistant(
      "Perfecto. Empecemos con la **Etapa 1: Productividad mensual**."
    );
    await appendAssistant(promptProd(1, ctx.contextJson, { line: autoLine }));
    return;
  }

  if (isReadyIntent(text)) {
    setAwaitingStage1Start(clientId, false);

    const products = Array.isArray(ctx.contextJson?.products)
      ? ctx.contextJson.products.filter(Boolean)
      : [];
    const autoLine = products.length === 1 ? String(products[0]) : undefined;

    setActiveAdvisorStage(1);
    setProdDraft({ line: autoLine, required_costs: 3 });
    setProdStep(1);

    await appendAssistant(
      "Excelente. Continuemos con la **Etapa 1: Productividad mensual**."
    );
    await appendAssistant(promptProd(1, ctx.contextJson, { line: autoLine }));
    return;
  }

  // si no confirmó, pedimos confirmación para iniciar productividad
  await appendAssistant(
    "Antes de avanzar necesito tu confirmación para iniciar la **Etapa 1: Productividad mensual**.\n\n" +
      "Cuando quieras, responde **ok**, **listo** o **vamos**."
  );
  return;
}

export async function handleProductivityWizardTurn(
  deps: AdvisorTurnDeps,
  turn: { text: string; ctx: PlanContextStatus; effectiveChatId: string }
) {
  const {
    chatIdRef,
    prodDraft,
    prodStep,
    setActiveAdvisorStage,
    setFodaState,
    setProdDraft,
    setProdStep,
  } = deps.state;
  const {
    callProductivityAssistant,
    clearProductivityState,
    saveFodaState,
    saveProductivity,
    validateProductivity,
  } = deps.api;
  const { appendAssistant } = deps.chat;
  const { text, ctx, effectiveChatId } = turn;

  // 1) Llamar al orquestador fluido
  const requiredCosts = prodDraft.required_costs === 3 ? 3 : 4;

  const assistant = await callProductivityAssistant({
    studentMessage: text,
    prodStep,
    prodDraft: {
      ...prodDraft,
      required_costs: requiredCosts,
    },
    caseContext: ctx.contextJson,
  });

  if (!assistant.ok || !assistant.payload?.assistantMessage) {
    await appendAssistant("⚠️ No pude interpretar bien tu respuesta. ¿Puedes decirlo en una frase corta (con números si aplica)?");
    return;
  }

  const a = assistant.payload;

  // 2) Mostrar mensaje “humano”
  await appendAssistant(a.assistantMessage);

  // 3) Aplicar patch + acumular costos
  const patched = applyAssistantPatchToDraft(prodDraft, a.updates?.patch ?? {});
  const mergedCosts = mergeCosts(patched.costs, a.updates?.addCosts ?? [], requiredCosts);

  const nextDraft: ProductivityDraft = {
    ...patched,
    required_costs: requiredCosts,
    costs: mergedCosts.length ? mergedCosts : patched.costs,
  };

  const nextStepRaw = typeof a.updates?.step === "number" ? a.updates.step : prodStep;
  const nextStep = Math.max(1, Math.min(5, Math.trunc(nextStepRaw))) as ProdStep;

  setProdDraft(nextDraft);
  setProdStep(nextStep);

  // 4) Si el modelo dice “doneWithStage=true”, guardamos y validamos
  if (a.control?.doneWithStage) {
    // Construir payload en el formato que tu /api/plans/productivity espera
    const payload = {
      type: nextDraft.type ?? "monetaria",
      period_key: nextDraft.period_key!,
      line: nextDraft.line,
      income_bs: nextDraft.income_bs,
      costs: nextDraft.costs,
      notes: nextDraft.notes,
    };

    const saved = await saveProductivity(payload, chatIdRef.current);
    if (!saved.ok) {
      await appendAssistant(saved?.data?.message || "⚠️ No pude guardar el reporte.");
      return;
    }



    const validated = await validateProductivity(payload.period_key);
      if (!validated.ok) {
        const issues = validated?.details?.issues;
        const score = validated?.details?.score;

        await appendAssistant(
          "⚠️ Aún no está listo para validar.\n" +
            (Array.isArray(issues) ? `\nProblemas:\n- ${issues.join("\n- ")}` : "") +
            (score
              ? `\n\nRúbrica:\n- coherencia: ${score.coherence}\n- tipo: ${score.type_choice}\n- claridad: ${score.clarity}\n- total: ${score.total}`
              : "") +
            "\n\nCorrige eso y me lo envías de nuevo 🙂"
        );
        return;
      }

      const initial: FodaState = {
        currentQuadrant: "F",
        items: {
          F: [],
          D: [],
          O: [],
          A: [],
        },
      };

      await clearProductivityState();

      setProdStep(0);
      setProdDraft({});
      setActiveAdvisorStage(2);

      setFodaState(initial);
      await saveFodaState(initial, effectiveChatId);

      await appendAssistant(
        "✅ **Etapa 1 (Productividad) validada**.\n\n" +
          "Ahora pasamos a la **Etapa 2: Análisis FODA**.\n\n" +
          "Empezamos con **Fortalezas (internas)**.\n\n" +
          "Dime una fortaleza real del proceso o área que analizas."
      );

      return;

  }

  return; // importante: ya atendimos el mensaje
}
