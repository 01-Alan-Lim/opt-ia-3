import assert from "node:assert/strict";

import type { IshikawaState } from "./ishikawaTree";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import { routeIshikawaTurn } from "./ishikawaTurnRouter";

// Decisiones deterministas del comienzo de un turno de E4 (Tanda 3, fases 1, 3 y 4). Sin IA.
// Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";

function buildState(options: { activeSubCause: boolean; pendingQuestion: boolean }): IshikawaState {
  const closure = { reviewed: true, at: NOW, verdict: "actionable" as const, origin: "system" as const };

  return {
    problem: { text: "Demoras en la entrega de pedidos" },
    categories: [
      {
        id: "cat_metodo",
        name: "Método",
        mainCauses: [
          {
            id: "mc_turnos",
            name: "Turnos mal distribuidos",
            subCauses: [
              {
                id: "sc_madrugada",
                name: "Faltan ayudantes en la madrugada",
                whys: ["Los turnos se arman sin mirar la demanda", "Nadie cruza la demanda con los turnos", "No existe un procedimiento para planificar turnos"],
                closure: { ...closure, rootId: "root_a" },
              },
              {
                id: "sc_cambios",
                name: "Cambios de turno de último momento",
                whys: ["Los ayudantes piden cambios", "El encargado acepta todos", "Falta un procedimiento para planificar los turnos"],
                closure: { ...closure, rootId: "root_b" },
              },
              { id: "sc_abierta", name: "Ayudantes sin tareas claras", whys: ["Nadie asigna las tareas del día"] },
            ],
          },
        ],
      },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: options.activeSubCause
      ? { categoryId: "cat_metodo", mainCauseId: "mc_turnos", subCauseId: "sc_abierta" }
      : { categoryId: "cat_metodo", mainCauseId: "mc_turnos" },
    rootCauses: [
      {
        id: "root_a",
        canonicalText: "No existe un procedimiento para planificar turnos",
        normalizedText: "no existe un procedimiento para planificar turnos",
        occurrences: [{ categoryId: "cat_metodo", mainCauseId: "mc_turnos", subCauseId: "sc_madrugada", text: "No existe un procedimiento para planificar turnos" }],
        distinctFrom: [],
      },
      {
        id: "root_b",
        canonicalText: "Falta un procedimiento para planificar los turnos",
        normalizedText: "falta un procedimiento para planificar los turnos",
        occurrences: [{ categoryId: "cat_metodo", mainCauseId: "mc_turnos", subCauseId: "sc_cambios", text: "Falta un procedimiento para planificar los turnos" }],
        distinctFrom: [],
      },
    ],
    pendingRootMatch: options.pendingQuestion
      ? {
          categoryId: "cat_metodo",
          mainCauseId: "mc_turnos",
          subCauseId: "sc_cambios",
          rootId: "root_b",
          candidateId: "root_a",
          reason: "Describen la misma falla.",
          askedAt: NOW,
        }
      : null,
  };
}

function expectRoute(state: IshikawaState, message: string, kind: string) {
  assert.equal(routeIshikawaTurn({ state, message }).kind, kind, message);
}

// Con una subcausa abierta y sin pregunta pendiente.
{
  const state = buildState({ activeSubCause: true, pendingQuestion: false });
  expectRoute(state, "El operario no conoce el procedimiento", "capture"); // sin frase causal
  expectRoute(state, "mala gestión", "capture"); // la calidad la rechazará, no el router
  expectRoute(state, "ok", "reprompt");
  expectRoute(state, "muéstrame el avance", "progress");
  expectRoute(state, "¿qué me falta?", "progress");
  expectRoute(state, "pasemos a Pareto", "stage_advance");
  expectRoute(state, "cerremos", "close_branch");
  expectRoute(state, "retomar 1", "resume");
  expectRoute(state, "ayuda", "continue"); // la ayuda sigue por la ruta rápida
  expectRoute(state, "cambiemos de rama", "continue");
  expectRoute(state, "1", "capture"); // con subcausa abierta, un número suelto no retoma
}

// Sin subcausa abierta: un número suelto sí retoma; una causa nueva va al camino general.
{
  const state = buildState({ activeSubCause: false, pendingQuestion: false });
  expectRoute(state, "1", "resume");
  expectRoute(state, "El horno no se calibra", "continue");
  expectRoute(state, "ok", "continue");
}

// Con una pregunta pendiente de causa raíz repetida: se responde en cualquier momento y no
// traba el resto de la conversación.
{
  const state = buildState({ activeSubCause: true, pendingQuestion: true });
  const answer = (message: string) => {
    const route = routeIshikawaTurn({ state, message });
    return route.kind === "root_answer" ? route.answer : route.kind;
  };

  assert.equal(answer("sí"), "yes");
  assert.equal(answer("Sí, es la misma"), "yes");
  assert.equal(answer("no"), "no");
  assert.equal(answer("No, son distintas"), "no");
  assert.equal(answer("ok"), "root_reminder"); // un "ok" no aprueba una fusión
  assert.equal(answer("dale"), "root_reminder");
  assert.equal(answer("¿son la misma causa?"), "root_reminder");
  // Una respuesta al porqué que empieza con "no" no es un "no" a la pregunta.
  assert.equal(answer("No hay registro de las tareas asignadas"), "capture");
  assert.equal(answer("muéstrame el avance"), "progress");
  assert.equal(answer("retomar 1"), "resume");
}

console.log("ishikawaTurnRouter tests passed");
