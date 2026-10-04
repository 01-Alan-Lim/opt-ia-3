import assert from "node:assert/strict";

import { buildStage6ProgressTruthMessage, getAdvisorStageLabel, promptProd } from "./advisorMessages";

// Literales críticos de los textos del asesor movidos desde page.tsx: si cambian, que sea a propósito.

{
  // Nombres de etapa (barra de progreso y avisos).
  assert.equal(getAdvisorStageLabel(0), "Etapa 0: Contexto del caso");
  assert.equal(getAdvisorStageLabel(5), "Etapa 5: Pareto");
  assert.equal(getAdvisorStageLabel(8), "Etapa 8: Planificacion");
  assert.equal(getAdvisorStageLabel(10), "Etapa 10: Documento final");
}

{
  // Aviso de avance real en E6.
  assert.equal(
    buildStage6ProgressTruthMessage(null),
    "Actualmente el sistema todavia registra tu avance en **Etapa 6: Objetivos**. " +
      "Para pasar a **Etapa 7** falta completar: estado guardado de Objetivos."
  );
  const ready = buildStage6ProgressTruthMessage({
    generalObjective: "Reducir mermas del 8% al 4%",
    specificObjectives: ["a", "b", "c"],
    linkedCriticalRoots: ["r1"],
    step: "review",
  });
  assert.equal(ready.includes("Tus objetivos ya se ven listos para validarse"), true);
  assert.equal(ready.includes("falta completar"), false);
}

{
  // Preguntas de E1.
  assert.equal(promptProd(1, {}, {}).startsWith("Perfecto 👍 Iniciamos **Etapa 1: Reporte de Productividad mensual**."), true);
  assert.equal(
    promptProd(2, {}, {}),
    "🧩 **Paso 2/4 — Periodo mensual**\nDime el mes en formato **YYYY-MM**.\nEjemplo: **2026-02**"
  );
  assert.equal(promptProd(3, { products: ["Yogurt", "Refresco"] }, {}).includes("📌 Importante: dime solo de cuál línea es"), true);
  assert.equal(promptProd(3, { products: ["Yogurt"] }, {}).endsWith("📌 Solo de la línea: **Yogurt**"), true);
  assert.equal(promptProd(3, {}, {}).endsWith("Ejemplo: **Ingresos: 8500 Bs**"), true);
  assert.equal(promptProd(4, {}, {}).startsWith("🧩 **Paso 4/4 — Costos principales del mes (2 a 4)**"), true);

  const summary = promptProd(5, {}, {
    period_key: "2026-02",
    type: "monetaria",
    line: "Yogurt",
    income_bs: 1000,
    costs: [
      { name: "MO", amount_bs: 400 },
      { name: "MP", amount_bs: 100 },
    ],
  });
  assert.equal(summary.includes("- Total costos (Bs): **500**"), true);
  assert.equal(summary.includes("- Productividad global aprox: **2.000** (Ingresos/Costos)"), true);

  const empty = promptProd(5, {}, {});
  assert.equal(empty.includes("- Ingresos (Bs): **(pendiente)**"), true);
  assert.equal(empty.includes("Productividad global"), false);
}

console.log("advisorMessages tests passed");
