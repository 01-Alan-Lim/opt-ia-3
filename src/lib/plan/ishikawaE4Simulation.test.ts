import assert from "node:assert/strict";

import {
  prepareLlmTurnState,
  resolveCloseConfirmation,
  resolveFastPathWhyTurn,
  resolveLlmCursorRelease,
  type BranchJudge,
  type FastPathWhyOutcome,
} from "./ishikawaBranchFlow";
import { describeStageCloseGaps, evaluateIshikawaReadiness } from "./ishikawaReadiness";
import { listUnreviewedBranches, resumeBranch } from "./ishikawaResume";
import {
  answerPendingRootMatch,
  resolveBranchRoot,
  resolveDeferredRootQuestion,
  type RootMatcher,
  type RootPath,
} from "./ishikawaRootRegistry";
import { deriveRootCauses } from "./ishikawaRoots";
import {
  compactIshikawaState,
  hydrateServerFields,
  mergeAssistantIshikawaState,
  mergeClientIshikawaState,
  serverFieldsFingerprint,
} from "./ishikawaStateMerge";
import {
  cloneIshikawaState,
  findActiveNodes,
  parsePendingRootMatch,
  parseRootRegistry,
  whyTexts,
  type IshikawaState,
} from "./ishikawaTree";
import { routeIshikawaTurn } from "./ishikawaTurnRouter";
import { MAX_WHY_DEPTH, MIN_ROOT_CAUSES } from "./rootCauseLimits";

// Arnés de simulación de la Etapa 4 completa (Tanda 3, Fase 4.2), con Gemini simulado.
//
// Recorre E4 de punta a punta: categorías, causas y subcausas creadas por el camino general
// (el LLM simulado devuelve el estado), porqués con y sin frase causal, rechazos por calidad,
// reformulación en el tope, cierre por el gate y por "cerremos", causa repetida exacta, causa
// parecida (pregunta que no traba y se responde después, con una raíz diferida), rama
// abandonada y retomada, hasta el mínimo de raíces y el paso a Pareto.
//
// Usa las mismas funciones que ishikawa/assistant: el enrutador del comienzo del turno
// (routeIshikawaTurn), la ruta rápida, la confirmación de cierre, el camino general
// (prepareLlmTurnState + resolveLlmCursorRelease), el registro de raíces y la reanudación.
// Simula además la persistencia de cada turno: el cliente manda su estado, el servidor
// rehidrata los campos de autoridad de la base, escribe si cambiaron y el cliente guarda.
// No cubre la redacción de los mensajes, el HTTP ni la base real. El cambio de categoría
// (buildSwitchCategoryResponse de la ruta) se simula moviendo el cursor. Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Gemini simulado
// ---------------------------------------------------------------------------

// Juicio de accionabilidad: accionable solo si el último porqué está en esta lista.
const ACTIONABLE_ROOTS = new Set(
  [
    "No existe una rutina de revisión diaria de pedidos",
    "No hay un procedimiento para aceptar pedidos urgentes",
    "La empresa no definió rutas por zona",
    "No existe un plan de mantenimiento preventivo de hornos",
    "No existe un plan de uso de la amasadora según la capacidad",
    "No existe un plan de inducción para ayudantes nuevos",
    "La empresa no tiene una política de incentivos por permanencia",
    "No existe un procedimiento para planificar turnos según la demanda",
    "Falta un procedimiento para planificar los turnos según la demanda",
    "No hay un procedimiento para aceptar pedidos urgentes por teléfono",
    "No existe una especificación de compra de empaques",
  ].map((text) => text.toLowerCase())
);

// Comparación de raíces: la IA propone que la raíz nueva (clave) es la misma que otra (valor).
const SAME_ROOT_PROPOSALS = new Map([
  [
    "Falta un procedimiento para planificar los turnos según la demanda",
    "No existe un procedimiento para planificar turnos según la demanda",
  ],
  [
    "No hay un procedimiento para aceptar pedidos urgentes por teléfono",
    "No hay un procedimiento para aceptar pedidos urgentes",
  ],
]);

let judgeFailsNext = false;
const judge: BranchJudge = async (branch) => {
  if (judgeFailsNext) {
    judgeFailsNext = false;
    return null; // la consulta falla: nunca cierra
  }

  const last = (branch.whys[branch.whys.length - 1] ?? "").toLowerCase();
  return ACTIONABLE_ROOTS.has(last)
    ? { actionable: true, reason: "La empresa puede cambiarlo con una acción concreta." }
    : { actionable: false, reason: "Todavía describe un síntoma; di qué falla dentro de la empresa." };
};

const matcherCalls: string[] = [];
const matcher: RootMatcher = async ({ newRoot, candidates }) => {
  matcherCalls.push(newRoot);
  const target = SAME_ROOT_PROPOSALS.get(newRoot);
  const match = candidates.find((candidate) => candidate.text === target);
  return { sameAs: match?.id ?? null, reason: match ? "Describen la misma falla de la empresa." : "" };
};

let rootIds = 0;
let nodeIds = 0;

// ---------------------------------------------------------------------------
// Cliente y base simulados
// ---------------------------------------------------------------------------

const CATEGORIES = [
  ["cat_hombre", "Hombre"],
  ["cat_maquina", "Máquina"],
  ["cat_metodo", "Método"],
  ["cat_material", "Material"],
  ["cat_medida", "Medida"],
  ["cat_entorno", "Entorno"],
] as const;

let clientState: IshikawaState = {
  problem: { text: "Demoras en la entrega de pedidos de la panadería" },
  categories: CATEGORIES.map(([id, name]) => ({ id, name, mainCauses: [] })),
  minCategories: 3,
  minMainCausesPerCategory: 2,
  minSubCausesPerMain: 1,
  maxWhyDepth: MAX_WHY_DEPTH,
  cursor: null,
};
let row: unknown = compactIshikawaState(clientState);

// Lo que recibe el servidor: el estado del cliente con los campos de autoridad releídos de la
// base (como hace ishikawa/assistant al comenzar el turno).
function serverTurnInput(): IshikawaState {
  const state = hydrateServerFields(clientState, row);
  for (const cat of state.categories) {
    for (const mc of cat.mainCauses) {
      for (const sc of mc.subCauses) delete sc.whysReplace;
    }
  }
  state.rootCauses = parseRootRegistry(state.rootCauses);
  state.pendingRootMatch = parsePendingRootMatch(state.pendingRootMatch);
  return state;
}

// Fin del turno: el asistente escribe si cambió algún campo del servidor y después guarda el
// cliente (que no puede pisar esos campos).
function finishTurn(start: IshikawaState, next: IshikawaState) {
  if (serverFieldsFingerprint(next) !== serverFieldsFingerprint(start)) {
    row = compactIshikawaState(mergeAssistantIshikawaState(row, next));
  }
  row = compactIshikawaState(mergeClientIshikawaState(row, next, row));
  clientState = next;
}

function resolveRoot(state: IshikawaState, path: RootPath) {
  return resolveBranchRoot(
    {
      state,
      path,
      now: NOW,
      newId: () => `root_${++rootIds}`,
      canAsk: parsePendingRootMatch(state.pendingRootMatch) === null,
    },
    matcher
  );
}

async function applyFastPath(
  state: IshikawaState,
  outcome: FastPathWhyOutcome
): Promise<{ next: IshikawaState; detail: string }> {
  switch (outcome.kind) {
    case "closed": {
      const root = await resolveRoot(outcome.nextState, outcome.path);
      return { next: root.nextState, detail: `closed:${root.kind}` };
    }
    case "blocked":
      return { next: outcome.nextState, detail: `blocked:${outcome.reason}` };
    case "escalate":
      return { next: outcome.nextState, detail: `escalate:${outcome.reason}` };
    case "reformulate":
    case "ask_next":
      return { next: outcome.nextState, detail: outcome.kind };
    default:
      return { next: state, detail: outcome.kind };
  }
}

// El LLM del camino general crea una subcausa (y la causa principal si no existe) y lleva el
// cursor a ella.
function llmCreatesBranch(categoryId: string, mainCauseName: string, subCauseName: string) {
  return (state: IshikawaState): IshikawaState => {
    const next = cloneIshikawaState(state);
    const cat = next.categories.find((category) => category.id === categoryId);
    if (!cat) throw new Error(`falta la categoría ${categoryId}`);

    let mc = cat.mainCauses.find((mainCause) => mainCause.name === mainCauseName);
    if (!mc) {
      mc = { id: `mc_${++nodeIds}`, name: mainCauseName, subCauses: [] };
      cat.mainCauses.push(mc);
    }

    const sc = { id: `sc_${++nodeIds}`, name: subCauseName, whys: [] };
    mc.subCauses.push(sc);
    next.cursor = { categoryId, mainCauseId: mc.id, subCauseId: sc.id };
    return next;
  };
}

type SendOptions = { llm?: (state: IshikawaState) => IshikawaState; switchTo?: string };

// Un turno completo. Devuelve qué pasó, para compararlo con lo esperado.
async function send(message: string, options: SendOptions = {}): Promise<string> {
  const state = serverTurnInput();
  let next: IshikawaState = state;
  let detail: string;

  if (options.switchTo) {
    next = cloneIshikawaState(state);
    next.cursor = { categoryId: options.switchTo };
    detail = "switch";
  } else {
    const route = routeIshikawaTurn({ state, message });
    detail = route.kind;

    switch (route.kind) {
      case "root_answer": {
        const answered = answerPendingRootMatch(state, route.answer);
        const deferred = await resolveDeferredRootQuestion({ state: answered.nextState, now: NOW }, matcher);
        next = deferred.nextState;
        detail = `root_answer:${answered.kind}${deferred.kind === "question" ? "+question" : ""}`;
        break;
      }

      case "resume": {
        if (route.request.kind === "resume") {
          const outcome = resumeBranch(state, route.request.branch.path);
          if (outcome.kind === "resumed") {
            next = outcome.nextState;
            detail = `resume:${outcome.prompt}`;
          }
        } else {
          detail = `resume:${route.request.kind}`;
        }
        break;
      }

      case "close_branch": {
        const outcome = await resolveCloseConfirmation({ state, now: NOW }, judge);
        if (outcome.kind === "closed") {
          const root = await resolveRoot(outcome.nextState, outcome.path);
          next = root.nextState;
          detail = `closed:${root.kind}`;
        } else if (outcome.kind === "not_ready") {
          next = outcome.nextState;
          detail = `not_ready:${outcome.decision}`;
        } else {
          detail = outcome.kind;
        }
        break;
      }

      case "capture": {
        const outcome = await resolveFastPathWhyTurn(
          { state, studentMessage: message, contextualIntent: null, now: NOW },
          judge
        );
        ({ next, detail } = await applyFastPath(state, outcome));
        break;
      }

      case "continue": {
        if (options.llm) {
          const prepared = prepareLlmTurnState(state, options.llm(state), NOW);
          const gate = await resolveLlmCursorRelease(
            { prevState: state, mergedState: prepared.state, now: NOW },
            judge
          );
          next = gate.nextState;
          detail = `llm:${gate.kind}`;

          if (gate.kind === "closed") {
            const root = await resolveRoot(gate.nextState, gate.path);
            next = root.nextState;
            detail += `:${root.kind}`;
          }
        } else if (findActiveNodes(state)?.sc) {
          // Navegación, consulta o ayuda con la subcausa abierta: ruta rápida.
          const outcome = await resolveFastPathWhyTurn(
            { state, studentMessage: message, contextualIntent: null, now: NOW },
            judge
          );
          ({ next, detail } = await applyFastPath(state, outcome));
        }
        break;
      }

      default:
        // root_reminder, progress, stage_advance, reprompt: sin cambios de estado.
        break;
    }
  }

  finishTurn(state, next);
  return detail;
}

type Step = [message: string, expected: string, options?: SendOptions];

async function run(steps: readonly Step[]) {
  for (const [message, expected, options] of steps) {
    assert.equal(await send(message, options), expected, message);
  }
}

function stored(): IshikawaState {
  return row as IshikawaState;
}

async function main() {
  // --- Método: primera rama, porqués sin frase causal, acuse, avance ------------------
  await run([
    [
      "Los pedidos se arman al momento",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_metodo", "Pedidos sin planificación", "Los pedidos se arman al momento") },
    ],
    ["Los encargados no ven los pedidos del día siguiente", "ask_next"],
    ["ok", "reprompt"],
    ["El sistema no muestra la agenda de pedidos", "ask_next"],
    ["No existe una rutina de revisión diaria de pedidos", "closed:new"],
    ["muéstrame el avance", "progress"],
    ["pasemos a Pareto", "stage_advance"],
  ]);
  assert.ok(describeStageCloseGaps(evaluateIshikawaReadiness(stored())).length > 0);

  // --- Rechazos por calidad (generalidad y tautología) y cierre por el gate ----------
  await run([
    [
      "Pedidos urgentes interrumpen la producción",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_metodo", "Pedidos sin planificación", "Pedidos urgentes interrumpen la producción") },
    ],
    ["mala gestión", "blocked:too_generic"],
    ["Los pedidos urgentes interrumpen la producción", "blocked:tautology"],
    ["Los vendedores aceptan pedidos sin consultar a producción", "ask_next"],
    ["Nadie coordina las ventas con producción", "ask_next"],
    ["No hay un procedimiento para aceptar pedidos urgentes", "closed:new"],
    [
      "El repartidor decide la ruta",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_metodo", "Rutas de entrega improvisadas", "El repartidor decide la ruta") },
    ],
    ["El repartidor no conoce las zonas", "ask_next"],
    ["No hay mapa de zonas de entrega", "ask_next"],
    ["La empresa no definió rutas por zona", "closed:new"],
  ]);

  // --- Máquina: causa raíz repetida exacta (se informa, cuenta una vez) ------------------
  await run([
    [
      "El horno principal se apaga",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_maquina", "Hornos con fallas", "El horno principal se apaga") },
    ],
    ["Los quemadores se ensucian", "ask_next"],
    ["El técnico no revisa los quemadores", "ask_next"],
    ["No existe un plan de mantenimiento preventivo de hornos", "closed:new"],
    [
      "El horno secundario tarda en calentar",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_maquina", "Hornos con fallas", "El horno secundario tarda en calentar") },
    ],
    ["La resistencia está desgastada", "ask_next"],
    ["Nadie reemplaza las piezas a tiempo", "ask_next"],
    ["No existe un plan de mantenimiento preventivo de hornos", "closed:repeated"],
  ]);

  // --- Reformulación en el tope y rama abandonada ---------------------------------------
  await run([
    [
      "La amasadora se traba",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_maquina", "Amasadora antigua", "La amasadora se traba") },
    ],
    ["La máquina es vieja", "ask_next"],
    ["Se usa más horas de las previstas", "ask_next"],
    ["Hay mucha demanda los fines de semana", "ask_next"], // tercer porqué: la calidad dice que no
    ["Los pedidos de fin de semana superan la capacidad", "ask_next"],
    ["La amasadora trabaja sin descanso los sábados", "reformulate"], // quinto: reformular
    ["cambiemos de rama", "switch_category"],
    ["Hombre", "switch", { switchTo: "cat_hombre" }],
    [
      "Rotación alta de ayudantes",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_hombre", "Personal nuevo sin experiencia", "Rotación alta de ayudantes") },
    ],
    ["Los ayudantes renuncian a los pocos meses", "ask_next"],
    ["otra causa", "switch", { switchTo: "cat_hombre" }], // queda abandonada con un porqué
    [
      "Los ayudantes nuevos se equivocan en las recetas",
      "llm:accepted",
      {
        llm: llmCreatesBranch("cat_hombre", "Personal nuevo sin experiencia", "Los ayudantes nuevos se equivocan en las recetas"),
      },
    ],
    ["Nadie les muestra las recetas estándar", "ask_next"],
    ["Las recetas no están escritas", "ask_next"],
    ["No existe un plan de inducción para ayudantes nuevos", "closed:new"],
  ]);

  // --- Causa parecida: la pregunta no traba; otra raíz parecida queda diferida ------------
  await run([
    [
      "Faltan ayudantes en la madrugada",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_hombre", "Turnos mal distribuidos", "Faltan ayudantes en la madrugada") },
    ],
    ["Los turnos se arman sin mirar la demanda", "ask_next"],
    ["Nadie cruza la demanda con los turnos", "ask_next"],
    ["No existe un procedimiento para planificar turnos según la demanda", "closed:new"],
    [
      "El encargado cambia los turnos a último momento",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_hombre", "Turnos mal distribuidos", "El encargado cambia los turnos a último momento") },
    ],
    ["Los ayudantes piden cambios de turno", "ask_next"],
    ["El encargado acepta todos los cambios", "ask_next"],
    ["Falta un procedimiento para planificar los turnos según la demanda", "closed:question"],
    ["ok", "root_reminder"],
    ["Medida", "switch", { switchTo: "cat_medida" }],
    [
      "No se mide el tiempo de entrega",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_medida", "Sin indicadores de entrega", "No se mide el tiempo de entrega") },
    ],
    ["Nadie registra la hora de salida", "ask_next"],
    ["No hay una planilla de despacho", "ask_next"], // empieza con "no" y no responde la pregunta
    ["No hay un procedimiento para aceptar pedidos urgentes por teléfono", "closed:new"],
  ]);
  assert.equal(matcherCalls.length, 1); // la raíz parecida con la pregunta abierta no consultó

  // El estudiante responde cuando quiere; entonces se compara la raíz diferida.
  await run([
    ["sí", "root_answer:merged+question"],
    ["No, son distintas", "root_answer:kept_distinct"],
  ]);
  assert.equal(matcherCalls.length, 2);
  assert.equal(parsePendingRootMatch(stored().pendingRootMatch), null);

  // --- Ramas abandonadas: se listan numeradas y se retoman sin IA --------------------------
  assert.deepEqual(
    listUnreviewedBranches(stored()).map((branch) => [branch.index, branch.labels.subCauseName, branch.awaitingReformulation]),
    [
      [1, "Rotación alta de ayudantes", false],
      [2, "La amasadora se traba", true],
    ]
  );

  await run([
    ["muéstrame el avance", "progress"],
    ["retomar 2", "resume:reformulate"], // 5 porqués + reformulateWhy: pide reformular
    ["No existe un plan de uso de la amasadora según la capacidad", "closed:new"],
    ["retomar rotación de ayudantes", "resume:ask_why"],
    ["El sueldo es bajo comparado con otras panaderías", "ask_next"],
    ["La empresa no tiene una política de incentivos por permanencia", "closed:new"],
  ]);

  // --- Material: la consulta de calidad falla (no cierra) y "cerremos" pasa por el gate ----
  await run([
    ["Material", "switch", { switchTo: "cat_material" }],
    [
      "Las cajas no conservan el calor",
      "llm:accepted",
      { llm: llmCreatesBranch("cat_material", "Empaques inadecuados", "Las cajas no conservan el calor") },
    ],
    ["Las cajas son de cartón delgado", "ask_next"],
    ["Se compran las cajas más baratas", "ask_next"],
  ]);
  judgeFailsNext = true;
  await run([
    ["No existe una especificación de compra de empaques", "ask_next"],
    ["cerremos", "closed:new"],
  ]);

  // --- Mínimo alcanzado --------------------------------------------------------------------
  const readiness = evaluateIshikawaReadiness(stored());
  assert.equal(readiness.completeCategories, 3);
  assert.equal(readiness.rootCount, MIN_ROOT_CAUSES);
  assert.equal(readiness.ready, true);
  assert.deepEqual(describeStageCloseGaps(readiness), []);
  assert.deepEqual(listUnreviewedBranches(stored()), []);

  const occurrences = new Map(deriveRootCauses(stored()).entries.map((entry) => [entry.text, entry.occurrences]));
  assert.equal(occurrences.get("No existe un plan de mantenimiento preventivo de hornos"), 2); // repetida exacta
  assert.equal(occurrences.get("No existe un procedimiento para planificar turnos según la demanda"), 2); // unidas
  assert.equal(occurrences.get("No hay un procedimiento para aceptar pedidos urgentes por teléfono"), 1); // distintas

  // La rama retomada en el tope se cerró con 5 porqués: el último, reemplazado.
  const kneader = stored()
    .categories.flatMap((cat) => cat.mainCauses)
    .flatMap((mc) => mc.subCauses)
    .find((sc) => sc.name === "La amasadora se traba");
  const kneaderWhys = whyTexts(kneader?.whys);
  assert.equal(kneaderWhys.length, MAX_WHY_DEPTH);
  assert.equal(kneaderWhys[MAX_WHY_DEPTH - 1], "No existe un plan de uso de la amasadora según la capacidad");

  assert.equal(await send("pasemos a Pareto"), "stage_advance");
}

main()
  .then(() => console.log("ishikawaE4Simulation tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
