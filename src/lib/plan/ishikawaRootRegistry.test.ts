import assert from "node:assert/strict";

import {
  answerPendingRootMatch,
  findRootCandidates,
  interpretRootMatchResponse,
  interpretYesNo,
  normalizeRootText,
  reconcileRootRegistry,
  releaseRootOccurrence,
  resolveBranchRoot,
  type RootMatchCandidateInput,
  type RootMatcher,
  type RootMatchVerdict,
  type RootPath,
} from "./ishikawaRootRegistry";
import { deriveRootCauses } from "./ishikawaRoots";
import {
  buildIshikawaTurnUi,
  cloneIshikawaState,
  parseRootRegistry,
  type BranchClosure,
  type IshikawaState,
  type IshikawaSubCause,
} from "./ishikawaTree";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import { ROOT_SIMILARITY_JACCARD_THRESHOLD, rootTextSimilarity } from "./whyQuality";

// Registro de causas raíz con detección de repetidas (Paso C, Fase C). La comparación con
// Gemini está simulada: registra cada consulta y responde según el caso. Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";

type BranchSpec = { cat: string; mc: string; sc: string; root: string };

const A: BranchSpec = {
  cat: "Método",
  mc: "mc_compras",
  sc: "sc_a",
  root: "No hay un procedimiento para priorizar compras de equipos",
};
// La misma causa que A escrita con otras mayúsculas y espacios: coincidencia exacta.
const B: BranchSpec = {
  cat: "Hombre",
  mc: "mc_personal",
  sc: "sc_b",
  root: "no hay un  procedimiento para priorizar compras de EQUIPOS",
};
// Parecida a A, escrita distinto: candidata para la IA.
const C: BranchSpec = {
  cat: "Máquina",
  mc: "mc_equipos",
  sc: "sc_c",
  root: "Falta un procedimiento para priorizar las compras de equipos",
};
// Distinta: solo comparte un sustantivo con A.
const D: BranchSpec = {
  cat: "Medida",
  mc: "mc_registro",
  sc: "sc_d",
  root: "Nadie revisa las necesidades de equipos de caja",
};

const CLOSED: BranchClosure = {
  reviewed: true,
  at: NOW,
  verdict: "actionable",
  origin: "system",
  rootId: null,
};

// Ramas ya cerradas por el gate (closure revisado), todavía sin resolver contra el registro.
function buildState(branches: BranchSpec[]): IshikawaState {
  const state: IshikawaState = {
    problem: { text: "Tiempo de espera alto en la atención" },
    categories: [],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: null,
    rootCauses: [],
    pendingRootMatch: null,
  };

  for (const spec of branches) {
    let cat = state.categories.find((c) => c.id === spec.cat);
    if (!cat) {
      cat = { id: spec.cat, name: spec.cat, mainCauses: [] };
      state.categories.push(cat);
    }

    let mc = cat.mainCauses.find((m) => m.id === spec.mc);
    if (!mc) {
      mc = { id: spec.mc, name: `Causa ${spec.mc}`, subCauses: [] };
      cat.mainCauses.push(mc);
    }

    mc.subCauses.push({
      id: spec.sc,
      name: `Subcausa ${spec.sc}`,
      whys: [`Primer porqué de ${spec.sc}`, spec.root],
      closure: { ...CLOSED },
    });
  }

  return state;
}

const pathOf = (spec: BranchSpec): RootPath => ({
  categoryId: spec.cat,
  mainCauseId: spec.mc,
  subCauseId: spec.sc,
});

function subCause(state: IshikawaState, spec: BranchSpec): IshikawaSubCause {
  const found = state.categories
    .find((cat) => cat.id === spec.cat)
    ?.mainCauses.find((mc) => mc.id === spec.mc)
    ?.subCauses.find((sc) => sc.id === spec.sc);
  if (!found) throw new Error(`falta la subcausa ${spec.sc}`);
  return found;
}

let idCounter = 0;
const newId = () => `root_${++idCounter}`;

// Gemini simulado: registra cada consulta y responde con `respond`.
function recordingMatcher(respond: (candidates: RootMatchCandidateInput[]) => RootMatchVerdict | null) {
  const calls: Array<{ newRoot: string; candidates: RootMatchCandidateInput[] }> = [];
  const matcher: RootMatcher = async (input) => {
    calls.push(input);
    return respond(input.candidates);
  };
  return { matcher, calls };
}

const PROPOSES_FIRST = (candidates: RootMatchCandidateInput[]): RootMatchVerdict => ({
  sameAs: candidates[0]?.id ?? null,
  reason: "Las dos describen el mismo procedimiento que falta.",
});

async function resolveInOrder(state: IshikawaState, specs: BranchSpec[], matcher: RootMatcher) {
  let current = state;
  let last: Awaited<ReturnType<typeof resolveBranchRoot>> | null = null;

  for (const spec of specs) {
    last = await resolveBranchRoot({ state: current, path: pathOf(spec), now: NOW, newId }, matcher);
    current = last.nextState;
  }

  if (!last) throw new Error("sin ramas");
  return last;
}

async function main() {
  // --- Criterio de igualdad y compatibilidad con Pareto ----------------------------
  {
    assert.equal(normalizeRootText("  Falta   CONTROL  de stock "), "falta control de stock");
    assert.equal(normalizeRootText(A.root), normalizeRootText(B.root));
    assert.notEqual(normalizeRootText(A.root), normalizeRootText(C.root));
  }

  // --- Paso 1: misma raíz escrita igual → se informa, no se pregunta ni se llama a la IA
  {
    const { matcher, calls } = recordingMatcher(PROPOSES_FIRST);
    const first = await resolveInOrder(buildState([A, B]), [A], matcher);
    assert.equal(first.kind, "new");

    const second = await resolveBranchRoot(
      { state: first.nextState, path: pathOf(B), now: NOW, newId },
      matcher
    );
    assert.equal(second.kind, "repeated");
    if (second.kind !== "repeated") throw new Error("se esperaba repeated");

    assert.equal(calls.length, 0);
    assert.equal(second.occurrences, 2);
    assert.deepEqual(second.previous.map((occurrence) => occurrence.subCauseId), ["sc_a"]);
    assert.equal(second.nextState.pendingRootMatch, null);

    const summary = deriveRootCauses(second.nextState);
    assert.deepEqual(summary.roots, [A.root]); // se muestra como lo escribió la primera vez
    assert.equal(summary.entries[0].occurrences, 2);
    assert.equal(
      subCause(second.nextState, A).closure?.rootId,
      subCause(second.nextState, B).closure?.rootId
    );

    // Pareto (pareto/state/route.ts) deduplica en minúsculas: con el registro no pierde raíces.
    const roots = deriveRootCauses(second.nextState).roots;
    assert.equal(new Set(roots.map((root) => root.toLowerCase())).size, roots.length);
  }

  // --- Pasos 2-4: parecida → la IA propone → se pregunta; "sí" la une -----------------
  {
    const { matcher, calls } = recordingMatcher(PROPOSES_FIRST);
    const question = await resolveInOrder(buildState([A, C]), [A, C], matcher);
    assert.equal(question.kind, "question");
    if (question.kind !== "question") throw new Error("se esperaba question");

    assert.equal(calls.length, 1); // una sola consulta
    assert.deepEqual(calls[0].candidates.map((candidate) => candidate.text), [A.root]);
    assert.equal(question.nextState.pendingRootMatch?.subCauseId, "sc_c");
    assert.equal(question.candidate.canonicalText, A.root);

    const ui = buildIshikawaTurnUi(question.nextState, { branchJustClosed: true });
    assert.equal(ui.awaitingRootMatch, true);
    assert.equal(ui.offerStageClose, false);

    // Mientras no responde quedan como distintas: la raíz nueva es provisoria.
    assert.equal(deriveRootCauses(question.nextState).roots.length, 2);

    const yes = answerPendingRootMatch(question.nextState, "yes");
    assert.equal(yes.kind, "merged");

    const summary = deriveRootCauses(yes.nextState);
    assert.deepEqual(summary.roots, [A.root]); // el conteo no sube
    assert.equal(summary.entries[0].occurrences, 2);
    assert.equal(
      subCause(yes.nextState, C).closure?.rootId,
      subCause(yes.nextState, A).closure?.rootId
    );
    assert.equal(yes.nextState.pendingRootMatch, null);
  }

  // --- "No" → quedan distintas y el par no se vuelve a proponer (paso 5) -------------
  {
    const { matcher } = recordingMatcher(PROPOSES_FIRST);
    const question = await resolveInOrder(buildState([A, C]), [A, C], matcher);
    const no = answerPendingRootMatch(question.nextState, "no");
    assert.equal(no.kind, "kept_distinct");

    const registry = parseRootRegistry(no.nextState.rootCauses);
    assert.equal(registry.length, 2);
    const [first, second] = registry;
    assert.deepEqual(first.distinctFrom, [second.id]);
    assert.deepEqual(second.distinctFrom, [first.id]);
    assert.equal(deriveRootCauses(no.nextState).roots.length, 2);

    assert.deepEqual(findRootCandidates(registry, C.root, second.id), []);
    const unmarked = registry.map((entry) => ({ ...entry, distinctFrom: [] }));
    assert.equal(findRootCandidates(unmarked, C.root, second.id).length, 1);
  }

  // --- La IA falla, responde mal o propone un id ajeno → raíz nueva, sin preguntar ----
  {
    const failing: RootMatcher[] = [
      async () => null,
      async () => {
        throw new Error("sin red");
      },
      async () => ({ sameAs: "id_que_no_es_candidata", reason: "x" }),
      async () => ({ sameAs: null, reason: "" }),
    ];

    for (const matcher of failing) {
      const result = await resolveInOrder(buildState([A, C]), [A, C], matcher);
      assert.equal(result.kind, "new");
      assert.equal(result.nextState.pendingRootMatch, null);
      assert.equal(deriveRootCauses(result.nextState).roots.length, 2);
    }
  }

  // --- Causas distintas que comparten un sustantivo → sin candidatas, sin IA ---------
  {
    const { matcher, calls } = recordingMatcher(PROPOSES_FIRST);
    const result = await resolveInOrder(buildState([A, D]), [A, D], matcher);
    assert.equal(result.kind, "new");
    assert.equal(calls.length, 0);
  }

  // --- Reabrir una rama suelta su occurrence; sin ramas, la raíz sale (C.7) ----------
  {
    const { matcher } = recordingMatcher(PROPOSES_FIRST);
    const repeated = await resolveInOrder(buildState([A, B]), [A, B], matcher);

    const withoutB = releaseRootOccurrence(repeated.nextState, pathOf(B));
    assert.equal(parseRootRegistry(withoutB.rootCauses)[0].occurrences.length, 1);

    const withoutBoth = releaseRootOccurrence(withoutB, pathOf(A));
    assert.deepEqual(parseRootRegistry(withoutBoth.rootCauses), []);

    // Si la rama reabierta tenía la pregunta pendiente, la pregunta se descarta y la raíz
    // provisoria sale; la otra queda sin marcas.
    const question = await resolveInOrder(buildState([A, C]), [A, C], matcher);
    const released = releaseRootOccurrence(question.nextState, pathOf(C));
    assert.equal(released.pendingRootMatch, null);
    const left = parseRootRegistry(released.rootCauses);
    assert.equal(left.length, 1);
    assert.equal(left[0].canonicalText, A.root);
    assert.deepEqual(left[0].distinctFrom, []);
  }

  // --- Coherencia: una rama que ya no está revisada deja de contar ------------------
  {
    const { matcher } = recordingMatcher(PROPOSES_FIRST);
    const resolved = await resolveInOrder(buildState([A]), [A], matcher);
    const tampered = cloneIshikawaState(resolved.nextState);
    delete subCause(tampered, A).closure;

    assert.deepEqual(parseRootRegistry(reconcileRootRegistry(tampered).rootCauses), []);
    assert.deepEqual(deriveRootCauses(tampered).roots, []);

    // Volver a confirmar el cierre sin cambiar la cadena no crea otra raíz.
    const again = await resolveBranchRoot(
      { state: resolved.nextState, path: pathOf(A), now: NOW, newId },
      matcher
    );
    assert.equal(again.kind, "unchanged");
    assert.equal(parseRootRegistry(again.nextState.rootCauses).length, 1);
  }

  // --- Respuesta del estudiante a "¿es la misma?" ------------------------------------
  {
    for (const text of ["sí", "Si", "sí, es la misma", "es la misma causa", "claro", "correcto"]) {
      assert.equal(interpretYesNo(text), "yes", text);
    }
    for (const text of ["no", "No, son distintas.", "son diferentes", "no es la misma", "es otra causa"]) {
      assert.equal(interpretYesNo(text), "no", text);
    }
    for (const text of ["no sé", "tal vez", "claro que no", "muéstrame el avance", ""]) {
      assert.equal(interpretYesNo(text), "unclear", text);
    }
  }

  // --- Validación de la respuesta de la IA -------------------------------------------
  {
    assert.deepEqual(interpretRootMatchResponse('{"sameAs":"r1","reason":"Es la misma."}', ["r1"]), {
      sameAs: "r1",
      reason: "Es la misma.",
    });
    assert.deepEqual(interpretRootMatchResponse('```json\n{"sameAs":null,"reason":""}\n```', ["r1"]), {
      sameAs: null,
      reason: "",
    });
    assert.equal(interpretRootMatchResponse('{"sameAs":"r9","reason":"x"}', ["r1"]), null);
    assert.equal(interpretRootMatchResponse("no es JSON", ["r1"]), null);
    assert.equal(interpretRootMatchResponse('{"same":"r1"}', ["r1"]), null);
  }

  // --- Umbral del filtro de parecido ---------------------------------------------------
  {
    assert.ok(rootTextSimilarity(A.root, C.root) >= ROOT_SIMILARITY_JACCARD_THRESHOLD);
    assert.ok(rootTextSimilarity(A.root, D.root) < ROOT_SIMILARITY_JACCARD_THRESHOLD);
    assert.equal(rootTextSimilarity("Falta capacitación", "Falta capacitación del personal nuevo"), 1);
  }
}

main()
  .then(() => console.log("ishikawaRootRegistry tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
