import assert from "node:assert/strict";

import {
  classifyLlmCursorChange,
  isCloseBranchConfirm,
  keepStoredWhys,
  protectServerFields,
  resolveCloseConfirmation,
  resolveFastPathWhyTurn,
  resolveLlmCursorRelease,
  type BranchForJudge,
  type BranchJudge,
} from "./ishikawaBranchFlow";
import { deriveRootCauses } from "./ishikawaRoots";
import { normalizeRootText, resolveBranchRoot } from "./ishikawaRootRegistry";
import { compactIshikawaState, mergeIshikawaStateForSave } from "./ishikawaStateMerge";
import {
  buildIshikawaTurnUi,
  cloneIshikawaState,
  type IshikawaState,
  type IshikawaSubCause,
} from "./ishikawaTree";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import { HINT_REFORMULATE, type LlmActionabilityVerdict } from "./whyQuality";

// Arnés de simulación de Ishikawa E4 con Gemini simulado: el juicio de accionabilidad es
// un doble que registra cada consulta y devuelve un veredicto fijo. Se ejecutan las mismas
// funciones puras que usa ishikawa/assistant (ruta rápida, confirmación de cierre y cursor
// del LLM) y la fusión de ishikawa/state (guardar y recargar). Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";
const EARLIER = "2026-02-01T00:00:00.000Z";
const CAT_ID = "cat_metodo";
const MC_ID = "mc_caja";
const SC_ID = "sc_cobro";

// Cadena guardada SIN frase causal ("falta", "no hay", "no existe", "nadie", "porque"…), como
// la dejan el estudiante o el camino general. La profundidad y el cierre se deciden sobre la
// lista guardada tal cual; solo las respuestas NUEVAS necesitan una causa reconocible para
// entrar por la ruta rápida. Todos pasan el filtro determinista.
const WHYS = [
  "Los cajeros tardan en registrar cada venta",
  "El sistema de caja pide datos innecesarios",
  "El encargado desconoce la configuración del sistema de caja",
  "La gerencia no asignó un responsable del sistema de caja",
  "La empresa no prioriza las compras de equipos para caja",
];

// Respuestas nuevas del estudiante (traen una causa reconocible).
const ANSWER_THIRD = "Nadie configuró el sistema de caja";
const ANSWER_FOURTH = "Nadie definió el responsable del sistema de caja";

const ACTIONABLE: LlmActionabilityVerdict = {
  actionable: true,
  reason: "La empresa puede asignar ese responsable y medir el resultado.",
};

const NOT_ACTIONABLE: LlmActionabilityVerdict = {
  actionable: false,
  reason: "Todavía describe un síntoma; di qué falla dentro de la empresa.",
};

function buildState(
  options: {
    whys?: string[];
    reformulateWhy?: boolean;
    subCauseName?: string;
    extraSubCauses?: IshikawaSubCause[];
  } = {}
): IshikawaState {
  const active: IshikawaSubCause = {
    id: SC_ID,
    name: options.subCauseName ?? "Cobro lento en horas pico",
    whys: options.whys ?? [],
  };
  if (options.reformulateWhy) active.reformulateWhy = true;

  return {
    problem: { text: "Tiempo de espera alto en la atención de caja" },
    categories: [
      {
        id: CAT_ID,
        name: "Método",
        mainCauses: [
          {
            id: MC_ID,
            name: "Demoras en caja",
            subCauses: [active, ...(options.extraSubCauses ?? [])],
          },
        ],
      },
      { id: "cat_maquina", name: "Máquina", mainCauses: [] },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: { categoryId: CAT_ID, mainCauseId: MC_ID, subCauseId: SC_ID },
  };
}

function subCause(state: IshikawaState, id = SC_ID): IshikawaSubCause {
  const found = state.categories
    .flatMap((cat) => cat.mainCauses)
    .flatMap((mc) => mc.subCauses)
    .find((sc) => sc.id === id);

  if (!found) throw new Error(`falta la subcausa ${id}`);
  return found;
}

// Gemini simulado: registra las consultas y responde siempre el mismo veredicto.
function mockJudge(verdict: LlmActionabilityVerdict | null) {
  const calls: BranchForJudge[] = [];
  const judge: BranchJudge = async (branch) => {
    calls.push(branch);
    return verdict;
  };
  return { judge, calls };
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K
): Extract<T, { kind: K }> {
  assert.equal(value.kind, kind);
  return value as Extract<T, { kind: K }>;
}

async function main() {
  // --- Detector de confirmación de cierre -----------------------------------------
  for (const text of [
    "cerremos",
    "cerramos",
    "ok, cerrar",
    "cerrar ahí",
    "Sí, cerremos esta rama",
    "de acuerdo, cerrar",
    "Listo, la cerramos.",
  ]) {
    assert.equal(isCloseBranchConfirm(text), true, text);
  }

  for (const text of [
    "el sitio queda cerrado",
    "las cajas están cerradas",
    "falta personal para cerrar la caja",
    "no sé si cerrar",
    "cerramos porque falta control",
    "todavía no cerramos",
  ]) {
    assert.equal(isCloseBranchConfirm(text), false, text);
  }

  // --- Caso 1: "cerramos" con 5 porqués no accionables NO cierra ------------------
  {
    const state = buildState({ whys: WHYS });
    assert.equal(isCloseBranchConfirm("cerramos"), true);

    const { judge, calls } = mockJudge(NOT_ACTIONABLE);
    const outcome = expectKind(await resolveCloseConfirmation({ state, now: NOW }, judge), "not_ready");

    assert.equal(calls.length, 1); // una sola consulta de calidad
    assert.equal(calls[0].whys.length, 5);
    assert.equal(outcome.decision, "reformulate"); // en el tope: reformular, no cerrar
    assert.equal(outcome.hint, NOT_ACTIONABLE.reason);

    const sc = subCause(outcome.nextState);
    assert.equal(sc.closure, undefined);
    assert.equal(sc.reformulateWhy, true);
    assert.deepEqual(outcome.nextState.cursor, state.cursor);
    assert.deepEqual(buildIshikawaTurnUi(outcome.nextState), {
      branchJustClosed: false,
      offerStageClose: true,
      awaitingWhy: true,
      awaitingRootMatch: false,
    });
    assert.deepEqual(deriveRootCauses(outcome.nextState).roots, []);

    // Si la consulta al LLM falla, tampoco se cierra.
    const failed = expectKind(
      await resolveCloseConfirmation({ state, now: NOW }, mockJudge(null).judge),
      "not_ready"
    );
    assert.equal(failed.decision, "reformulate");
    assert.equal(failed.hint, HINT_REFORMULATE);
    assert.equal(subCause(failed.nextState).closure, undefined);
  }

  // --- Caso 2: "falta personal para cerrar la caja" guarda el porqué y no cierra --
  {
    const message = "falta personal para cerrar la caja";
    assert.equal(isCloseBranchConfirm(message), false);

    const state = buildState({ whys: WHYS.slice(0, 1) });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(
      await resolveFastPathWhyTurn({ state, studentMessage: message, contextualIntent: null, now: NOW }, judge),
      "ask_next"
    );

    assert.equal(calls.length, 0); // profundidad 2: antes del mínimo ni se consulta
    const sc = subCause(outcome.nextState);
    // El porqué guardado se conserva aunque no tenga frase causal.
    assert.deepEqual(sc.whys, [WHYS[0], "Falta personal para cerrar la caja"]);
    assert.equal(sc.closure, undefined);
    assert.deepEqual(outcome.nextState.cursor, state.cursor);
  }

  // --- Caso 3: "el sitio queda cerrado" no dispara el cierre ----------------------
  {
    const message = "el sitio queda cerrado";
    assert.equal(isCloseBranchConfirm(message), false);

    const state = buildState({ whys: WHYS.slice(0, 3) });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(
      await resolveFastPathWhyTurn({ state, studentMessage: message, contextualIntent: null, now: NOW }, judge),
      "guided_help"
    );

    // No es una causa: se ayuda a precisarla con la cadena guardada completa; sin consultas.
    assert.deepEqual(outcome.whys, WHYS.slice(0, 3));
    assert.equal(calls.length, 0);
  }

  // --- Caso 4: un cierre legítimo escribe closure.reviewed = true -----------------
  {
    // a) Confirmación del estudiante con cadena accionable.
    const state = buildState({ whys: WHYS.slice(0, 3) });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(await resolveCloseConfirmation({ state, now: NOW }, judge), "closed");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].whys, WHYS.slice(0, 3));
    assert.deepEqual(subCause(outcome.nextState).closure, {
      reviewed: true,
      at: NOW,
      verdict: "actionable",
      origin: "student_confirm",
      rootId: null,
    });
    assert.deepEqual(outcome.nextState.cursor, { categoryId: CAT_ID, mainCauseId: MC_ID });
    assert.equal(outcome.rootCause, WHYS[2]);
    assert.deepEqual(buildIshikawaTurnUi(outcome.nextState, { branchJustClosed: true }), {
      branchJustClosed: true,
      offerStageClose: false,
      awaitingWhy: false,
      awaitingRootMatch: false,
    });

    // Cuenta recién cuando la raíz queda en el registro (la ruta lo hace tras el cierre).
    assert.deepEqual(deriveRootCauses(outcome.nextState).roots, []);
    const root = await resolveBranchRoot(
      { state: outcome.nextState, path: outcome.path, now: NOW, newId: () => "root_4a" },
      async () => null
    );
    assert.equal(subCause(root.nextState).closure?.rootId, "root_4a");
    assert.deepEqual(deriveRootCauses(root.nextState).roots, [WHYS[2]]);
  }

  {
    // b) Ruta rápida: el tercer porqué es accionable y cierra por calidad. Los dos guardados
    //    no tienen frase causal y cuentan igual.
    const state = buildState({ whys: WHYS.slice(0, 2) });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(
      await resolveFastPathWhyTurn({ state, studentMessage: ANSWER_THIRD, contextualIntent: null, now: NOW }, judge),
      "closed"
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].whys.length, 3);
    const sc = subCause(outcome.nextState);
    assert.deepEqual(sc.whys, [WHYS[0], WHYS[1], ANSWER_THIRD]);
    assert.deepEqual(sc.closure, {
      reviewed: true,
      at: NOW,
      verdict: "actionable",
      origin: "system",
      rootId: null,
    });
    assert.equal(outcome.nextState.cursor?.subCauseId, undefined);

    // Si el LLM falla en ese mismo punto, se pide otro porqué y no se cierra.
    const failed = expectKind(
      await resolveFastPathWhyTurn(
        { state, studentMessage: ANSWER_THIRD, contextualIntent: null, now: NOW },
        mockJudge(null).judge
      ),
      "ask_next"
    );
    assert.equal(subCause(failed.nextState).closure, undefined);
    assert.equal(failed.nextState.cursor?.subCauseId, SC_ID);
  }

  {
    // c) El LLM suelta el cursor como en la regla 8 (solo la categoría).
    const prevState = buildState({ whys: WHYS.slice(0, 3) });
    const mergedState = cloneIshikawaState(prevState);
    mergedState.cursor = { categoryId: CAT_ID };
    assert.equal(classifyLlmCursorChange(prevState, mergedState), "release");

    const closed = expectKind(
      await resolveLlmCursorRelease({ prevState, mergedState, now: NOW }, mockJudge(ACTIONABLE).judge),
      "closed"
    );
    assert.deepEqual(subCause(closed.nextState).closure, {
      reviewed: true,
      at: NOW,
      verdict: "actionable",
      origin: "system",
      rootId: null,
    });
    assert.deepEqual(closed.nextState.cursor, { categoryId: CAT_ID });

    // Sin validación del gate, el cursor vuelve a la subcausa y se pide lo que falta.
    const kept = expectKind(
      await resolveLlmCursorRelease({ prevState, mergedState, now: NOW }, mockJudge(NOT_ACTIONABLE).judge),
      "kept_open"
    );
    assert.deepEqual(kept.nextState.cursor, prevState.cursor);
    assert.equal(subCause(kept.nextState).closure, undefined);
    assert.equal(kept.decision, "ask_next");
    assert.equal(kept.hint, NOT_ACTIONABLE.reason);

    // Antes del mínimo ni siquiera se consulta al LLM.
    const shallow = buildState({ whys: WHYS.slice(0, 1) });
    const shallowMerged = cloneIshikawaState(shallow);
    shallowMerged.cursor = { categoryId: CAT_ID };
    const shallowJudge = mockJudge(ACTIONABLE);
    const shallowKept = expectKind(
      await resolveLlmCursorRelease(
        { prevState: shallow, mergedState: shallowMerged, now: NOW },
        shallowJudge.judge
      ),
      "kept_open"
    );
    assert.equal(shallowJudge.calls.length, 0);
    assert.equal(shallowKept.depth, 1);

    // El LLM devuelve la cadena recortada al soltar el cursor: se restituye la guardada y el
    // gate decide sobre los 3 porqués reales.
    const shortened = cloneIshikawaState(prevState);
    subCause(shortened).whys = [WHYS[0]];
    shortened.cursor = { categoryId: CAT_ID };
    const repaired = keepStoredWhys(prevState, shortened);
    assert.deepEqual(subCause(repaired).whys, WHYS.slice(0, 3));

    const repairedJudge = mockJudge(ACTIONABLE);
    const repairedClose = await resolveLlmCursorRelease(
      { prevState, mergedState: repaired, now: NOW },
      repairedJudge.judge
    );
    assert.equal(repairedClose.kind, "closed");
    assert.equal(repairedJudge.calls[0].whys.length, 3);
  }

  // --- Caso 5: una rama abandonada no cuenta como raíz ----------------------------
  {
    const extra: IshikawaSubCause = { id: "sc_filas", name: "Filas desordenadas", whys: WHYS.slice(0, 4) };
    const state = buildState({ whys: WHYS.slice(0, 3), extraSubCauses: [extra] });

    // Se cierra legítimamente la rama activa y su raíz queda en el registro.
    const closed = expectKind(
      await resolveCloseConfirmation({ state, now: NOW }, mockJudge(ACTIONABLE).judge),
      "closed"
    );
    const resolved = await resolveBranchRoot(
      { state: closed.nextState, path: closed.path, now: NOW, newId: () => "root_5" },
      async () => null
    );

    // El LLM lleva el cursor a la otra subcausa y después a otra categoría sin cerrarla.
    const onExtra = cloneIshikawaState(resolved.nextState);
    onExtra.cursor = { categoryId: CAT_ID, mainCauseId: MC_ID, subCauseId: "sc_filas" };
    const moved = cloneIshikawaState(onExtra);
    moved.cursor = { categoryId: "cat_maquina" };
    assert.equal(classifyLlmCursorChange(onExtra, moved), "navigation");

    const { judge, calls } = mockJudge(ACTIONABLE);
    const accepted = expectKind(
      await resolveLlmCursorRelease({ prevState: onExtra, mergedState: moved, now: NOW }, judge),
      "accepted"
    );
    assert.equal(calls.length, 0); // la navegación no se bloquea ni se valida
    assert.equal(subCause(accepted.nextState, "sc_filas").closure, undefined);

    const summary = deriveRootCauses(accepted.nextState);
    assert.deepEqual(summary.roots, [WHYS[2]]);
    assert.deepEqual(
      summary.pendingBranches.map((branch) => branch.subCauseName),
      ["Filas desordenadas"]
    );

    // Con el conteo anterior (sin exigir cierre) la rama abandonada sí contaba.
    assert.deepEqual(deriveRootCauses(accepted.nextState, { requireReviewedClosure: false }).roots, [
      WHYS[2],
      WHYS[3],
    ]);
  }

  // --- Caso 6: tras reformular y recargar, el texto nuevo persiste y el viejo no vuelve
  {
    const OLD = WHYS[4];
    const NEW = "No existe un procedimiento para configurar el software de ventas";
    const state = buildState({ whys: WHYS, reformulateWhy: true });

    // Lo que ya está en la BD antes del turno.
    const saved0 = compactIshikawaState(mergeIshikawaStateForSave(null, state));

    // Turno de reformulación (el LLM sigue sin verlo accionable: vuelve a pedir reformular).
    const turn = expectKind(
      await resolveFastPathWhyTurn(
        { state, studentMessage: NEW, contextualIntent: null, now: NOW },
        mockJudge(NOT_ACTIONABLE).judge
      ),
      "reformulate"
    );
    const sent = subCause(turn.nextState);
    assert.deepEqual(sent.whys, [...WHYS.slice(0, 4), NEW]);
    assert.equal(sent.whysReplace, true);

    // Guardado (POST ishikawa/state): fusión con lo guardado + compactación.
    const saved1 = compactIshikawaState(mergeIshikawaStateForSave(saved0, turn.nextState));

    // Recarga (GET ishikawa/state): compactación del estado guardado.
    const reloaded = compactIshikawaState(saved1) as IshikawaState;
    const afterReload = subCause(reloaded);
    assert.deepEqual(afterReload.whys, [...WHYS.slice(0, 4), NEW]);
    assert.equal("whysReplace" in afterReload, false);

    // Turno siguiente: el cliente reenvía lo recargado y se guarda sin flag (unión).
    const saved2 = compactIshikawaState(mergeIshikawaStateForSave(saved1, reloaded)) as IshikawaState;
    const finalWhys = subCause(saved2).whys ?? [];
    assert.equal(finalWhys.includes(NEW), true);
    assert.equal(finalWhys.includes(OLD), false);

    // Control: sin whysReplace, la unión con lo guardado habría devuelto el porqué viejo.
    const withoutFlag = cloneIshikawaState(turn.nextState);
    delete subCause(withoutFlag).whysReplace;
    const unionOnly = compactIshikawaState(mergeIshikawaStateForSave(saved0, withoutFlag)) as IshikawaState;
    assert.equal((subCause(unionOnly).whys ?? []).includes(OLD), true);
  }

  // --- El LLM no escribe closure; una cadena cambiada reabre la rama --------------
  {
    const prev = buildState({ whys: WHYS.slice(0, 3) });
    const prevClosed = cloneIshikawaState(prev);
    subCause(prevClosed).closure = {
      reviewed: true,
      at: EARLIER,
      verdict: "actionable",
      origin: "system",
      rootId: "root_x",
    };
    prevClosed.rootCauses = [
      {
        id: "root_x",
        canonicalText: WHYS[2],
        normalizedText: normalizeRootText(WHYS[2]),
        occurrences: [{ categoryId: CAT_ID, mainCauseId: MC_ID, subCauseId: SC_ID, text: WHYS[2] }],
        distinctFrom: [],
      },
    ];

    // Cierre inventado por el LLM en una rama sin closure: se descarta.
    const invented = cloneIshikawaState(prev);
    subCause(invented).closure = {
      reviewed: true,
      at: NOW,
      verdict: "actionable",
      origin: "student_confirm",
      rootId: null,
    };
    assert.equal(subCause(protectServerFields(prev, invented, NOW)).closure, undefined);

    // El LLM agrega un porqué a una rama cerrada: se reabre de forma explícita.
    const extended = cloneIshikawaState(prevClosed);
    subCause(extended).whys = WHYS.slice(0, 4);
    assert.deepEqual(subCause(protectServerFields(prevClosed, extended, NOW)).closure, {
      reviewed: false,
      at: NOW,
      verdict: "actionable",
      origin: "system",
      rootId: null,
    });
    // Y suelta su causa raíz: sin otras ramas, la raíz sale del registro (C.7).
    assert.deepEqual(protectServerFields(prevClosed, extended, NOW).rootCauses, []);

    // Cadena intacta: el cierre se conserva aunque el LLM lo omita.
    const untouched = cloneIshikawaState(prevClosed);
    delete subCause(untouched).closure;
    assert.deepEqual(
      subCause(protectServerFields(prevClosed, untouched, NOW)).closure,
      subCause(prevClosed).closure
    );
    assert.equal(protectServerFields(prevClosed, untouched, NOW).rootCauses?.length, 1);

    // Un porqué nuevo en la ruta rápida sobre una rama cerrada también la reabre; con la
    // cadena guardada completa, el gate consulta con 4.
    const reopenJudge = mockJudge(NOT_ACTIONABLE);
    const reopened = expectKind(
      await resolveFastPathWhyTurn(
        { state: prevClosed, studentMessage: ANSWER_FOURTH, contextualIntent: null, now: NOW },
        reopenJudge.judge
      ),
      "ask_next"
    );
    assert.equal(reopenJudge.calls[0].whys.length, 4);
    assert.deepEqual(subCause(reopened.nextState).closure, {
      reviewed: false,
      at: NOW,
      verdict: "actionable",
      origin: "system",
      rootId: null,
    });
    assert.deepEqual(reopened.nextState.rootCauses, []);
  }

  // --- Rechazo determinista: repetir un porqué guardado no lo guarda y cuenta el intento
  {
    const state = buildState({ whys: WHYS.slice(0, 2) });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(
      await resolveFastPathWhyTurn(
        {
          state,
          studentMessage: "porque los cajeros tardan en registrar cada venta",
          contextualIntent: null,
          now: NOW,
        },
        judge
      ),
      "blocked"
    );

    assert.equal(outcome.reason, "tautology");
    assert.equal(calls.length, 0);
    assert.deepEqual(subCause(outcome.nextState).whys, WHYS.slice(0, 2));
    assert.equal(subCause(outcome.nextState).rejectedWhyAttempts, 1);
  }

  // --- Caso trazado de la Fase D: la profundidad se cuenta sobre la lista guardada ----
  {
    const stored = ["tardan", "no conoce el proceso", "no hay capacitación"];
    const state = buildState({ whys: stored, subCauseName: "Operarios nuevos" });
    const { judge, calls } = mockJudge(ACTIONABLE);
    const outcome = expectKind(
      await resolveFastPathWhyTurn(
        {
          state,
          studentMessage: "no existe un plan de inducción para operarios nuevos",
          contextualIntent: null,
          now: NOW,
        },
        judge
      ),
      "closed"
    );

    // Antes veía 2 (["No hay capacitación", nuevo]) y ni consultaba; ahora ve los 4 reales.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].whys.length, 4);
    assert.deepEqual(subCause(outcome.nextState).whys, [
      ...stored,
      "No existe un plan de inducción para operarios nuevos",
    ]);
  }

  // --- Camino general: los porqués guardados se conservan; lo nuevo del LLM se filtra ----
  {
    const prev = buildState({ whys: WHYS.slice(0, 3) });
    const next = cloneIshikawaState(prev);
    // El LLM devuelve la lista recortada, con un porqué útil y otro que es texto meta.
    subCause(next).whys = [WHYS[0], "Falta un responsable de configurar la caja", "ayúdame a encontrar la raíz"];

    const kept = keepStoredWhys(prev, next);
    assert.deepEqual(subCause(kept).whys, [
      ...WHYS.slice(0, 3),
      "Falta un responsable de configurar la caja",
    ]);
  }
}

main()
  .then(() => console.log("ishikawaBranchFlow tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
