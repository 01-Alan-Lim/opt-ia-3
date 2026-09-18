import assert from "node:assert/strict";

import { resolveFastPathWhyTurn, type BranchJudge } from "./ishikawaBranchFlow";
import {
  buildUnreviewedBranchesOffer,
  describeUnreviewedBranch,
  detectResumeRequest,
  listUnreviewedBranches,
  resumeBranch,
} from "./ishikawaResume";
import type { IshikawaState, IshikawaSubCause } from "./ishikawaTree";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import type { LlmActionabilityVerdict } from "./whyQuality";

// Tanda 3, Fase 3: listar las ramas sin revisar (3.1), mover el cursor a una de forma
// determinista (3.2) y retomar una rama con 5 porqués y reformulateWhy (3.5). Sin IA; el juicio
// de calidad del último caso es un doble. Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";

const FIVE_WHYS = [
  "Los conteos se hacen a mano",
  "El conteo depende de quien esté de turno",
  "Cada encargado cuenta a su manera",
  "Los encargados cambian seguido",
  "La planilla de conteo se pierde",
];

const ACTIONABLE: LlmActionabilityVerdict = { actionable: true, reason: "La empresa puede fijar ese estándar." };
const NOT_ACTIONABLE: LlmActionabilityVerdict = { actionable: false, reason: "Todavía es un síntoma." };

function buildState(): IshikawaState {
  return {
    problem: { text: "Diferencias entre el stock físico y el del sistema" },
    categories: [
      {
        id: "cat_metodo",
        name: "Método",
        mainCauses: [
          {
            id: "mc_caja",
            name: "Demoras en caja",
            subCauses: [
              { id: "sc_cobro", name: "Cobro lento", whys: ["Los cajeros tardan en cobrar", "El sistema pide datos innecesarios"] },
              {
                id: "sc_filas",
                name: "Filas en horas pico",
                whys: ["Hay un solo cajero", "Nadie ajusta los turnos", "No existe un plan de turnos por demanda"],
                closure: { reviewed: true, at: NOW, verdict: "actionable", origin: "system", rootId: "root_1" },
              },
            ],
          },
          {
            id: "mc_inventario",
            name: "Inventario desordenado",
            subCauses: [{ id: "sc_conteo", name: "Conteo manual", whys: FIVE_WHYS, reformulateWhy: true }],
          },
        ],
      },
      {
        id: "cat_maquina",
        name: "Máquina",
        mainCauses: [
          {
            id: "mc_impresora",
            name: "Impresora de tickets",
            subCauses: [
              { id: "sc_atascos", name: "Atascos de papel", whys: [] },
              { id: "sc_vacia", name: "subcausa", whys: [] },
            ],
          },
        ],
      },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: { categoryId: "cat_metodo", mainCauseId: "mc_caja", subCauseId: "sc_cobro" },
  };
}

function subCause(state: IshikawaState, id: string): IshikawaSubCause {
  const found = state.categories
    .flatMap((cat) => cat.mainCauses)
    .flatMap((mc) => mc.subCauses)
    .find((sc) => sc.id === id);

  if (!found) throw new Error(`falta la subcausa ${id}`);
  return found;
}

function fixedJudge(verdict: LlmActionabilityVerdict): BranchJudge {
  return async () => verdict;
}

async function main() {
  const state = buildState();

  // --- 3.1 Ramas sin revisar, en orden del árbol y numeradas -------------------------
  const branches = listUnreviewedBranches(state);
  assert.deepEqual(
    branches.map((branch) => [branch.index, branch.path.subCauseId]),
    [
      [1, "sc_cobro"],
      [2, "sc_conteo"],
      [3, "sc_atascos"],
    ]
  ); // sc_filas está cerrada; sc_vacia no tiene nombre útil ni porqués

  assert.deepEqual(branches[1].labels, {
    categoryName: "Método",
    mainCauseName: "Inventario desordenado",
    subCauseName: "Conteo manual",
  });
  assert.equal(branches[1].awaitingReformulation, true);
  assert.equal(describeUnreviewedBranch(branches[0]), "Método → Demoras en caja → Cobro lento (2 porqués)");
  assert.equal(
    describeUnreviewedBranch(branches[1]),
    "Método → Inventario desordenado → Conteo manual (espera que reformules el último porqué)"
  );
  assert.equal(describeUnreviewedBranch(branches[2]), "Máquina → Impresora de tickets → Atascos de papel (sin porqués)");

  // La oferta omite la rama activa pero conserva los números.
  const offer = buildUnreviewedBranchesOffer(branches, { activePath: branches[0].path }) ?? "";
  assert.ok(offer.includes("2) Método → Inventario desordenado → Conteo manual"));
  assert.ok(offer.includes("3) Máquina → Impresora de tickets → Atascos de papel"));
  assert.ok(!offer.includes("1) "));
  assert.ok(offer.includes("retomar 2"));
  assert.equal(buildUnreviewedBranchesOffer([]), null);

  // --- 3.2 Pedido de retomar y cursor determinista ----------------------------------
  const expectResume = (message: string, allowBareReference: boolean, subCauseId: string) => {
    const request = detectResumeRequest(message, branches, { allowBareReference });
    assert.equal(request?.kind, "resume", message);
    if (request?.kind === "resume") assert.equal(request.branch.path.subCauseId, subCauseId, message);
  };

  expectResume("retomar 2", false, "sc_conteo");
  expectResume("Retomemos la rama 3", false, "sc_atascos");
  expectResume("volvamos a la segunda", false, "sc_conteo");
  expectResume("retomemos la de conteo manual", false, "sc_conteo");
  expectResume("quiero retomar atascos", false, "sc_atascos");
  expectResume("sigamos con cobro lento", false, "sc_cobro");
  expectResume("2", true, "sc_conteo"); // sin subcausa abierta, basta el número

  assert.equal(detectResumeRequest("2", branches, { allowBareReference: false }), null);
  assert.equal(detectResumeRequest("sigamos con otra causa", branches, { allowBareReference: true }), null);
  assert.equal(detectResumeRequest("El operario no conoce el procedimiento", branches, { allowBareReference: true }), null);

  const noReference = detectResumeRequest("retomemos", branches, { allowBareReference: false });
  assert.equal(noReference?.kind === "choose" ? noReference.reason : null, "no_reference");
  const notFound = detectResumeRequest("retomar 9", branches, { allowBareReference: false });
  assert.equal(notFound?.kind === "choose" ? notFound.reason : null, "not_found");
  assert.equal(detectResumeRequest("retomar 1", [], { allowBareReference: false })?.kind, "nothing_pending");

  const resumed = resumeBranch(state, branches[1].path);
  assert.equal(resumed.kind, "resumed");
  if (resumed.kind !== "resumed") return;
  assert.deepEqual(resumed.nextState.cursor, branches[1].path);
  assert.equal(resumed.prompt, "reformulate");
  // Retomar no toca la rama: porqués y reformulateWhy quedan como estaban; el estado de entrada
  // no se modifica.
  assert.deepEqual(subCause(resumed.nextState, "sc_conteo").whys, FIVE_WHYS);
  assert.equal(subCause(resumed.nextState, "sc_conteo").reformulateWhy, true);
  assert.deepEqual(state.cursor, { categoryId: "cat_metodo", mainCauseId: "mc_caja", subCauseId: "sc_cobro" });

  const cobro = resumeBranch(state, branches[0].path);
  assert.equal(cobro.kind === "resumed" ? cobro.prompt : null, "ask_why");
  const atascos = resumeBranch(state, branches[2].path);
  assert.equal(atascos.kind === "resumed" ? atascos.prompt : null, "ask_first_why");
  // Una rama cerrada no se retoma.
  assert.equal(
    resumeBranch(state, { categoryId: "cat_metodo", mainCauseId: "mc_caja", subCauseId: "sc_filas" }).kind,
    "not_found"
  );

  // --- 3.5 Rama con 5 porqués y reformulateWhy, retomada ------------------------------
  // La respuesta reemplaza el quinto porqué (no se agrega un sexto) y pasa por el gate.
  const answer = "No existe un procedimiento estándar de conteo semanal";

  const stillNot = await resolveFastPathWhyTurn(
    { state: resumed.nextState, studentMessage: answer, contextualIntent: null, now: NOW },
    fixedJudge(NOT_ACTIONABLE)
  );
  assert.equal(stillNot.kind, "reformulate");
  if (stillNot.kind === "reformulate") {
    const whys = subCause(stillNot.nextState, "sc_conteo").whys ?? [];
    assert.equal(whys.length, MAX_WHY_DEPTH);
    assert.deepEqual(whys.slice(0, 4), FIVE_WHYS.slice(0, 4));
    assert.equal(whys[4], answer);
  }

  const closed = await resolveFastPathWhyTurn(
    { state: resumed.nextState, studentMessage: answer, contextualIntent: null, now: NOW },
    fixedJudge(ACTIONABLE)
  );
  assert.equal(closed.kind, "closed");
  if (closed.kind === "closed") {
    const sc = subCause(closed.nextState, "sc_conteo");
    assert.equal(sc.whys?.length, MAX_WHY_DEPTH);
    assert.equal(sc.closure?.reviewed, true);
    assert.equal(sc.reformulateWhy, false);
    assert.equal(closed.rootCause, answer);
  }
}

main()
  .then(() => console.log("ishikawaResume tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
