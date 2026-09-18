import assert from "node:assert/strict";

import {
  keepStoredWhysWithReport,
  prepareLlmTurnState,
  resolveFastPathWhyTurn,
  type BranchForJudge,
  type BranchJudge,
} from "./ishikawaBranchFlow";
import { cloneIshikawaState, type IshikawaState, type IshikawaSubCause } from "./ishikawaTree";
import { MAX_WHY_DEPTH, REJECTED_WHY_ATTEMPTS_LIMIT } from "./rootCauseLimits";
import type { LlmActionabilityVerdict } from "./whyQuality";

// Tanda 3, Fase 1: una respuesta del estudiante se acepta si es un intento de responder (sin
// exigir frase causal) y el rechazo lo da la calidad, con pista. El mismo criterio vale para
// los porqués que agrega el LLM en el camino general. Gemini simulado; datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";
const CAT_ID = "cat_metodo";
const MC_ID = "mc_despacho";
const SC_ID = "sc_demora";

const STORED = ["Los pedidos salen tarde del local", "El despacho espera a que se junten varios pedidos"];

const ACTIONABLE: LlmActionabilityVerdict = {
  actionable: true,
  reason: "La empresa puede definir ese estándar y controlarlo.",
};

const NOT_ACTIONABLE: LlmActionabilityVerdict = {
  actionable: false,
  reason: "Todavía describe un síntoma; di qué falla dentro de la empresa.",
};

function buildState(
  options: { whys?: string[]; reformulateWhy?: boolean; rejectedWhyAttempts?: number } = {}
): IshikawaState {
  const active: IshikawaSubCause = {
    id: SC_ID,
    name: "Entregas fuera de hora",
    whys: options.whys ?? [],
  };
  if (options.reformulateWhy) active.reformulateWhy = true;
  if (options.rejectedWhyAttempts !== undefined) active.rejectedWhyAttempts = options.rejectedWhyAttempts;

  return {
    problem: { text: "Demoras en la entrega de pedidos" },
    categories: [
      {
        id: CAT_ID,
        name: "Método",
        mainCauses: [{ id: MC_ID, name: "Despacho sin horario", subCauses: [active] }],
      },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: { categoryId: CAT_ID, mainCauseId: MC_ID, subCauseId: SC_ID },
  };
}

function subCause(state: IshikawaState): IshikawaSubCause {
  const found = state.categories
    .flatMap((cat) => cat.mainCauses)
    .flatMap((mc) => mc.subCauses)
    .find((sc) => sc.id === SC_ID);

  if (!found) throw new Error("falta la subcausa");
  return found;
}

function mockJudge(verdict: LlmActionabilityVerdict | null) {
  const calls: BranchForJudge[] = [];
  const judge: BranchJudge = async (branch) => {
    calls.push(branch);
    return verdict;
  };
  return { judge, calls };
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
  assert.equal(value.kind, kind);
  return value as Extract<T, { kind: K }>;
}

function turn(state: IshikawaState, studentMessage: string, judge: BranchJudge) {
  return resolveFastPathWhyTurn({ state, studentMessage, contextualIntent: null, now: NOW }, judge);
}

async function main() {
  // (1) "El operario no conoce el procedimiento": se guarda y pasa por el gate.
  {
    const answer = "El operario no conoce el procedimiento";

    // Es el tercer porqué: el gate consulta la calidad y, si es accionable, cierra la rama.
    const { judge, calls } = mockJudge(ACTIONABLE);
    const closed = expectKind(await turn(buildState({ whys: STORED }), answer, judge), "closed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].whys, [...STORED, answer]);
    assert.equal(closed.rootCause, answer);
    assert.equal(subCause(closed.nextState).closure?.reviewed, true);

    // Si la calidad dice que todavía no es accionable, se guarda igual y se pide otro porqué.
    const notYet = expectKind(await turn(buildState({ whys: STORED }), answer, mockJudge(NOT_ACTIONABLE).judge), "ask_next");
    assert.deepEqual(notYet.whys, [...STORED, answer]);
    assert.equal(notYet.hint, NOT_ACTIONABLE.reason);
    assert.equal(subCause(notYet.nextState).closure, undefined);
  }

  // (2) y (3) Otras respuestas sin frase causal: se guardan.
  for (const answer of ["El encargado desconoce la configuración del sistema de caja", "La gerencia no asignó un responsable"]) {
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(await turn(buildState({ whys: STORED.slice(0, 1) }), answer, judge), "ask_next");
    assert.equal(calls.length, 0, answer); // profundidad 2: antes del mínimo no se consulta
    assert.deepEqual(outcome.whys, [STORED[0], answer], answer);
  }

  // (4) Pedidos de ayuda: no se guardan ni se consulta la calidad.
  for (const message of ["ayuda", "no entiendo"]) {
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(await turn(buildState({ whys: STORED }), message, judge), "guided_help");
    assert.deepEqual(outcome.whys, STORED, message);
    assert.equal(calls.length, 0, message);
  }

  // (5) "pasemos a Pareto": cambio de contexto, no se guarda.
  {
    const outcome = await turn(buildState({ whys: STORED }), "pasemos a Pareto", mockJudge(ACTIONABLE).judge);
    assert.equal(outcome.kind, "switch_category");
  }

  // (6) Respuesta pobre: la rechaza la CALIDAD, con pista; no se guarda ni sube la profundidad.
  {
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(await turn(buildState({ whys: STORED }), "mala gestión", judge), "blocked");
    assert.equal(outcome.reason, "too_generic");
    assert.match(outcome.hint, /muy general/);
    assert.deepEqual(subCause(outcome.nextState).whys, STORED);
    assert.equal(subCause(outcome.nextState).rejectedWhyAttempts, 1);
    assert.equal(calls.length, 0);
  }

  // (7) Reformulación en el tope sin causa accionable: tras REJECTED_WHY_ATTEMPTS_LIMIT intentos
  //     se escala a formulaciones concretas, en vez de pedir "reformula" para siempre.
  {
    const whys = [
      ...STORED,
      "Nadie arma los pedidos con anticipación",
      "El local no tiene un horario de despacho",
      "Los repartidores salen cuando pueden",
    ];
    assert.equal(whys.length, MAX_WHY_DEPTH);
    const answer = "Los pedidos se juntan al final de la tarde";

    const first = expectKind(
      await turn(buildState({ whys, reformulateWhy: true }), answer, mockJudge(NOT_ACTIONABLE).judge),
      "reformulate"
    );
    assert.equal(subCause(first.nextState).rejectedWhyAttempts, 1);
    assert.equal(subCause(first.nextState).whys?.length, MAX_WHY_DEPTH); // reemplaza, no agrega

    const escalated = expectKind(
      await turn(
        buildState({ whys, reformulateWhy: true, rejectedWhyAttempts: REJECTED_WHY_ATTEMPTS_LIMIT - 1 }),
        answer,
        mockJudge(NOT_ACTIONABLE).judge
      ),
      "escalate"
    );
    assert.equal(escalated.reason, "not_actionable");
    const sc = subCause(escalated.nextState);
    assert.equal(sc.rejectedWhyAttempts, 0);
    assert.equal(sc.reformulateWhy, true);
    assert.equal(sc.whys?.length, MAX_WHY_DEPTH);
  }

  // (8) Camino general: el mismo criterio para los porqués que agrega el LLM. Una respuesta sin
  //     frase causal se conserva; una pregunta del propio LLM se descarta sin aviso; una
  //     respuesta pobre se descarta con la pista para el estudiante.
  {
    const prev = buildState({ whys: STORED.slice(0, 1) });
    const next = cloneIshikawaState(prev);
    subCause(next).whys = [
      STORED[0],
      "El operario no conoce el procedimiento",
      "¿Por qué no hay un horario de despacho?",
      "mala gestión",
    ];

    const { state, dropped } = keepStoredWhysWithReport(prev, next);
    assert.deepEqual(subCause(state).whys, [STORED[0], "El operario no conoce el procedimiento"]);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].text, "Mala gestión");
    assert.equal(dropped[0].existingBranch, true);
    assert.match(dropped[0].hint, /muy general/);
  }

  // (9) prepareLlmTurnState: fusión con lo del LLM, porqués guardados restituidos y campos del
  //     servidor protegidos (el LLM no puede cerrar la rama escribiendo closure).
  {
    const prev = buildState({ whys: STORED });
    const llm = cloneIshikawaState(prev);
    const sc = subCause(llm);
    sc.whys = [STORED[0]]; // lista recortada
    sc.closure = { reviewed: true, at: NOW, verdict: "actionable", origin: "system", rootId: null };

    const prepared = prepareLlmTurnState(prev, llm, NOW);
    assert.deepEqual(subCause(prepared.state).whys, STORED);
    assert.equal(subCause(prepared.state).closure, undefined);
    assert.deepEqual(prepared.dropped, []);
  }
}

main()
  .then(() => console.log("ishikawaWhyIntake tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
