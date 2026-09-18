import assert from "node:assert/strict";

import {
  buildIshikawaPromptContext,
  EMPTY_PROMPT_CONTEXT,
  formatCaseContextBlock,
  joinReadable,
  readCaseFacts,
  summarizeBrainstorm,
  summarizeFoda,
} from "./ishikawaPromptContext";

// Tanda 3, Fase 2: contexto real del caso para los prompts de E4, con las claves y formas que
// hay en la base (products y process_focus son listas). Datos ficticios.

// Claves reales de plan_case_contexts.context_json.
assert.deepEqual(
  readCaseFacts({ sector: "Panadería", products: ["pan", "tortas"], process_focus: ["producción", "despacho"], stage: "e0" }),
  { sector: "Panadería", products: ["pan", "tortas"], areas: ["producción", "despacho"] }
);

// Variantes antiguas (texto en lugar de lista).
assert.deepEqual(readCaseFacts({ rubro: "Textil", product: "poleras", areas: "confección" }), {
  sector: "Textil",
  products: ["poleras"],
  areas: ["confección"],
});
assert.deepEqual(readCaseFacts(null), { sector: null, products: [], areas: [] });

// FODA: debilidades y amenazas (textos u objetos { text | item }); nunca la evidencia.
const foda = summarizeFoda({
  counts: { F: 1, O: 1, D: 2, A: 1 },
  items: {
    F: ["Buena ubicación"],
    O: ["Demanda creciente"],
    D: [{ text: "No hay control de mermas", evidence: "planilla del mes pasado" }, "Personal sin capacitación"],
    A: [{ item: "Suba de precios de insumos" }],
  },
});
assert.deepEqual(foda, {
  weaknesses: ["No hay control de mermas", "Personal sin capacitación"],
  threats: ["Suba de precios de insumos"],
});
assert.deepEqual(summarizeFoda({ items: "roto" }), { weaknesses: [], threats: [] });

// Lluvia de ideas: pocas ideas y cortas.
const ideas = Array.from({ length: 20 }, (_, index) => ({ text: `Idea ${index + 1}` }));
assert.equal(summarizeBrainstorm({ ideas }).length, 8);
assert.equal(summarizeBrainstorm({ ideas: [{ text: "x".repeat(400) }] })[0].length, 140);

assert.equal(joinReadable(["a"]), "a");
assert.equal(joinReadable(["a", "b", "c"]), "a, b y c");

const context = buildIshikawaPromptContext({
  problem: "Demoras en la entrega de pedidos",
  caseContext: { sector: "Panadería", products: ["pan"], process_focus: ["despacho"] },
  foda: { items: { D: ["No hay control de mermas"], A: [] } },
  brainstorm: { ideas: [{ text: "Los repartidores no tienen rutas fijas" }] },
});

// Sin opciones: solo problema y datos del caso (el mensaje guiado).
const basic = formatCaseContextBlock(context);
assert.ok(basic.includes("Problema (cabeza del Ishikawa): Demoras en la entrega de pedidos"));
assert.ok(basic.includes("Rubro: Panadería"));
assert.ok(basic.includes("Productos o servicios: pan"));
assert.ok(basic.includes("Áreas o procesos en foco: despacho"));
assert.ok(!basic.includes("FODA"));
assert.ok(!basic.includes("lluvia de ideas"));

// Con FODA y lluvia de ideas (hipótesis y camino general).
const full = formatCaseContextBlock(context, { foda: true, brainstorm: true });
assert.ok(full.includes("Debilidades del FODA"));
assert.ok(full.includes("No hay control de mermas"));
assert.ok(full.includes("Los repartidores no tienen rutas fijas"));
assert.ok(!full.includes("Amenazas del FODA")); // sin amenazas, no aparece la línea

// Sin datos: el bloque lo dice (el prompt no debe pedir coherencia con algo que no recibe).
assert.equal(formatCaseContextBlock(EMPTY_PROMPT_CONTEXT, { foda: true, brainstorm: true }), "- (sin datos del caso disponibles)");

console.log("ishikawaPromptContext tests passed");
