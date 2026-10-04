// src/lib/plan/advisorMessages.ts
//
// Textos fijos del asesor que el chat arma sin estado: preguntas de la Etapa 1, nombres de
// etapa y el aviso de avance real en la Etapa 6. Se movieron tal cual desde page.tsx.

import {
  type AdvisorRuntimeStage,
  type ObjectivesState,
  type ProdStep,
  type ProductivityDraft,
  getObjectivesMissingItems,
} from "./advisorStates";

export function promptProd(step: ProdStep, ctxJson: any, draft: ProductivityDraft) {
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
  const line = draft.line || (products.length === 1 ? String(products[0]) : "");

  if (step === 1) {
    return (
      "Perfecto 👍 Iniciamos **Etapa 1: Reporte de Productividad mensual**.\n\n" +
      "🧩 **Paso 1/4 — Tipo de productividad**\n" +
      "Puedes elegir:\n" +
      "• **Monetaria** (Ingresos Bs / Costos Bs)\n" +
      "• **Física** (ej: litros / horas, kg / Bs insumos)\n\n" +
      "Dime cuál usarás y **por qué**.\n" +
      "Ejemplo: *“Trabajaré con monetaria porque tengo ingresos y costos mensuales.”*"
    );
  }

  if (step === 2) {
    return (
      "🧩 **Paso 2/4 — Periodo mensual**\n" +
      "Dime el mes en formato **YYYY-MM**.\n" +
      "Ejemplo: **2026-02**"
    );
  }

  if (step === 3) {
    const lineHint =
      products.length > 1
        ? `\n\n📌 Importante: dime solo de cuál línea es (ej: Yogurt o Refresco).`
        : line
        ? `\n\n📌 Solo de la línea: **${line}**`
        : "";

    return (
      "🧩 **Paso 3/4 — Ingresos del mes (Bs)**\n" +
      "👉 Solo del producto/línea\n" +
      "👉 del mes completo\n\n" +
      "Ejemplo: **Ingresos: 8500 Bs**" +
      lineHint
    );
  }

  if (step === 4) {
    return (
      "🧩 **Paso 4/4 — Costos principales del mes (2 a 4)**\n" +
      "Escríbelos con monto aproximado en Bs.\n\n" +
      "Ejemplo:\n" +
      "- Mano de obra: 2800\n" +
      "- Materia prima: 3200\n" +
      "- Energía: 400"
    );
  }

  // step === 5 (confirmación)
  const income = typeof draft.income_bs === "number" ? draft.income_bs : null;
  const costs = Array.isArray(draft.costs) ? draft.costs : [];
  const costTotal = costs.reduce((a, c) => a + (c.amount_bs || 0), 0);

  const prodByCost =
    income !== null && costTotal > 0 ? (income / costTotal).toFixed(3) : null;

  return (
    "✅ **Resumen del Reporte de Productividad (borrador)**\n\n" +
    `- Periodo: **${draft.period_key ?? "(pendiente)"}**\n` +
    `- Tipo: **${draft.type ?? "(pendiente)"}**\n` +
    `- Línea: **${draft.line ?? "(pendiente)"}**\n` +
    `- Ingresos (Bs): **${income ?? "(pendiente)"}**\n` +
    `- Costos: **${costs.length ? costs.map((c) => `${c.name}: ${c.amount_bs}`).join(", ") : "(pendiente)"}**\n` +
    `- Total costos (Bs): **${costs.length ? costTotal : "(pendiente)"}**\n` +
    (prodByCost ? `- Productividad global aprox: **${prodByCost}** (Ingresos/Costos)\n` : "") +
    "\n¿Confirmas que **ingresos y costos** corresponden SOLO a esa línea y al MISMO mes?\n" +
    "Responde: **sí** / **confirmo** / **ok**"
  );
}

export function getAdvisorStageLabel(stage: Exclude<AdvisorRuntimeStage, null>) {
  switch (stage) {
    case 0:
      return "Etapa 0: Contexto del caso";
    case 1:
      return "Etapa 1: Productividad";
    case 2:
      return "Etapa 2: FODA";
    case 3:
      return "Etapa 3: Lluvia de ideas";
    case 4:
      return "Etapa 4: Ishikawa";
    case 5:
      return "Etapa 5: Pareto";
    case 6:
      return "Etapa 6: Objetivos";
    case 7:
      return "Etapa 7: Plan de Mejora";
    case 8:
      return "Etapa 8: Planificacion";
    case 9:
      return "Etapa 9: Reporte de avances";
    case 10:
      return "Etapa 10: Documento final";
  }

  return `Etapa ${stage}`;
}

export function buildStage6ProgressTruthMessage(st: ObjectivesState | null) {
  const missing = getObjectivesMissingItems(st);

  if (missing.length === 0) {
    return (
      "Actualmente el sistema todavia registra tu avance en **Etapa 6: Objetivos**. " +
      "Tus objetivos ya se ven listos para validarse; solo despues de que esa validacion se complete correctamente " +
      "el progreso debe pasar a **Etapa 7: Plan de Mejora**."
    );
  }

  return (
    "Actualmente el sistema todavia registra tu avance en **Etapa 6: Objetivos**. " +
    "Para pasar a **Etapa 7** falta completar: " +
    missing.join(", ") +
    "."
  );
}
