// src/lib/plan/ishikawaBranchFlow.ts

// Cierre de ramas de Ishikawa (E4). Lógica pura: sin I/O ni llamadas a red; el juicio de
// accionabilidad del LLM se inyecta (BranchJudge) para poder simularlo en pruebas.
// Todo cierre pasa por el mismo gate (decideWhyStep) y solo un cierre legítimo escribe
// closure.reviewed = true. Mover el cursor a otra rama sin cerrar deja la rama anterior
// sin closure: no cuenta como causa raíz (REQUIRE_REVIEWED_CLOSURE).
//
// Las funciones decide* son de dos fases: si el gate necesita al LLM, *BranchToJudge
// devuelve la rama a juzgar; el llamador consulta una vez y pasa el veredicto
// (undefined = no se consultó, null = falló). Sin veredicto accionable nunca se cierra.
// Las funciones resolve* hacen ese recorrido con un BranchJudge.
//
// Cubre la confirmación de cierre del estudiante, el cursor que suelta el LLM y la ruta
// rápida (respuesta corta a un "¿por qué?"). La redacción queda en ishikawa/assistant.
//
// La profundidad y el cierre se deciden SIEMPRE sobre la lista de porqués guardada tal cual
// (whyTexts), nunca sobre una lista filtrada.

import { MAX_WHY_DEPTH, REJECTED_WHY_ATTEMPTS_LIMIT } from "./rootCauseLimits";
import {
  decideWhyStep,
  evaluateWhyDeterministic,
  type LlmActionabilityVerdict,
  type WhyBlockReason,
  type WhyStepDecision,
} from "./whyQuality";
import {
  classifyWhyIntent,
  isActionableWhyText,
  isNonCausalMessage,
  isVagueWhyAnswer,
  normalizeIntentText,
  normalizeWhyText,
  sanitizeWhyCandidate,
  sanitizeWhyList,
} from "./ishikawaWhyInterpreter";
import {
  cloneIshikawaState,
  findActiveNodes,
  whyTexts,
  type BranchClosure,
  type IshikawaCategory,
  type IshikawaMainCause,
  type IshikawaState,
  type IshikawaSubCause,
} from "./ishikawaTree";
import { hydrateServerFields } from "./ishikawaStateMerge";
import { dedupeWhys } from "./whyList";
import { releaseRootOccurrenceInPlace, type RootPath } from "./ishikawaRootRegistry";

// Confirmación explícita de cierre: el mensaje completo debe serlo (muletillas de acuerdo
// + verbo de cierre + complementos cortos: "sí, cerremos esta rama", "ok, cerrar", "cerrar
// ahí"). Una frase que solo contiene la palabra no confirma: "falta personal para cerrar
// la caja", "el sitio queda cerrado", "no sé si cerrar".
const CLOSE_CONFIRM_PATTERN = new RegExp(
  "^" +
    "(?:(?:ok|okay|okey|si|dale|listo|bueno|perfecto|de acuerdo|entonces|ya|vale|va)\\s+)*" +
    "(?:(?:la|lo)\\s+)?" +
    "(?:cerremos(?:la|lo)?|cerramos|cerrar(?:la|lo)?|cierra(?:la|lo)?)" +
    "(?:\\s+(?:ahi|aqui|ya|entonces|nomas|asi|por favor|porfa|esta|esa|la|rama|subcausa|causa|raiz))*" +
    "$"
);

export function isCloseBranchConfirm(text: string): boolean {
  return CLOSE_CONFIRM_PATTERN.test(normalizeIntentText(text));
}

export type BranchLabels = {
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
};

// Rama que se lleva al juicio de accionabilidad del LLM.
export type BranchForJudge = BranchLabels & { whys: string[] };

// Juicio de accionabilidad del LLM. null = la consulta falló (nunca cierra).
export type BranchJudge = (branch: BranchForJudge) => Promise<LlmActionabilityVerdict | null>;

export type BranchClosureCheck = {
  depth: number;
  lastWhy: string | null;
  decision: WhyStepDecision;
};

// Qué falta para cerrar; se le explica al estudiante sin cerrar la rama.
export type BranchNotReady = {
  labels: BranchLabels;
  decision: "ask_next" | "reformulate";
  hint?: string;
  depth: number;
  lastWhy: string | null;
  judgeFailed: boolean; // no hubo veredicto del LLM (falló o no se consultó)
};

type BranchNodes = {
  cat: IshikawaCategory;
  mc: IshikawaMainCause;
  sc: IshikawaSubCause;
};

export function branchLabels(
  cat: IshikawaCategory,
  mc: IshikawaMainCause,
  sc: IshikawaSubCause
): BranchLabels {
  return {
    categoryName: cat.name ?? "Sin categoría",
    mainCauseName: mc.name ?? mc.text ?? "Sin causa principal",
    subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
  };
}

// Gate único de cierre sobre la cadena guardada, tal cual (no agrega un candidato): el
// último porqué se evalúa contra la subcausa y los porqués anteriores. Sin porqués no hay
// nada que cerrar.
export function evaluateBranchClosure(input: {
  subCauseText: string;
  whys: readonly string[];
  llmVerdict?: LlmActionabilityVerdict | null;
}): BranchClosureCheck {
  const depth = input.whys.length;
  const lastWhy = depth > 0 ? input.whys[depth - 1] : null;

  if (lastWhy === null) {
    return { depth, lastWhy, decision: { action: "ask_next" } };
  }

  const deterministic = evaluateWhyDeterministic({
    why: lastWhy,
    subCauseText: input.subCauseText,
    previousWhys: input.whys.slice(0, -1),
  });

  return {
    depth,
    lastWhy,
    decision: decideWhyStep({ depth, deterministic, llmVerdict: input.llmVerdict }),
  };
}

// Cierre legítimo: el gate dictaminó "actionable". rootId se asigna al resolver la raíz
// contra el registro de causas raíz.
export function reviewedClosure(origin: BranchClosure["origin"], now: string): BranchClosure {
  return { reviewed: true, at: now, verdict: "actionable", origin, rootId: null };
}

// La cadena de una rama revisada cambió: el cierre deja de valer hasta pasar de nuevo el
// gate y la rama suelta su causa raíz. Queda explícito (reviewed: false) porque el guardado
// conserva el campo anterior si se omite.
export function reopenClosure(closure: BranchClosure, now: string): BranchClosure {
  return closure.reviewed ? { ...closure, reviewed: false, at: now, rootId: null } : closure;
}

function notReady(
  labels: BranchLabels,
  check: BranchClosureCheck,
  llmVerdict: LlmActionabilityVerdict | null | undefined
): BranchNotReady {
  const base = { labels, depth: check.depth, lastWhy: check.lastWhy };
  const { decision } = check;

  if (decision.action === "reformulate") {
    return { ...base, decision: "reformulate", hint: decision.hint, judgeFailed: llmVerdict === null };
  }

  if (decision.action === "ask_next") {
    return { ...base, decision: "ask_next", hint: decision.hint, judgeFailed: llmVerdict === null };
  }

  // Sin veredicto (no se consultó al LLM): no se cierra.
  return { ...base, decision: "ask_next", judgeFailed: true };
}

function activeBranch(state: IshikawaState): BranchNodes | null {
  const active = findActiveNodes(state);
  const sc = active?.sc;
  if (!active || !sc) return null;
  return { cat: active.cat, mc: active.mc, sc };
}

function locateBranch(
  state: IshikawaState,
  ids: { categoryId: string; mainCauseId: string; subCauseId: string }
): BranchNodes | null {
  const cat = (state.categories ?? []).find((c) => c.id === ids.categoryId);
  const mc = (cat?.mainCauses ?? []).find((m) => m.id === ids.mainCauseId);
  const sc = (mc?.subCauses ?? []).find((s) => s.id === ids.subCauseId);
  return cat && mc && sc ? { cat, mc, sc } : null;
}

function branchToJudge(branch: BranchNodes | null): BranchForJudge | null {
  if (!branch) return null;

  const labels = branchLabels(branch.cat, branch.mc, branch.sc);
  const whys = whyTexts(branch.sc.whys);
  const check = evaluateBranchClosure({ subCauseText: labels.subCauseName, whys });

  return check.decision.action === "consult_quality" ? { ...labels, whys } : null;
}

// ---------------------------------------------------------------------------
// Confirmación de cierre del estudiante ("cerremos", "ok, cerrar")
// ---------------------------------------------------------------------------

export type CloseConfirmationOutcome =
  | { kind: "no_active_subcause" }
  | {
      kind: "closed";
      nextState: IshikawaState;
      labels: BranchLabels;
      rootCause: string;
      reason: string;
      path: RootPath;
    }
  | ({ kind: "not_ready"; nextState: IshikawaState } & BranchNotReady);

export function closeConfirmationBranchToJudge(state: IshikawaState): BranchForJudge | null {
  return branchToJudge(activeBranch(state));
}

// Solo cierra con veredicto accionable explícito; si no, la rama sigue abierta (el cursor
// no se mueve) y el resultado dice qué falta.
export function decideCloseConfirmation(input: {
  state: IshikawaState;
  now: string;
  llmVerdict?: LlmActionabilityVerdict | null;
}): CloseConfirmationOutcome {
  const nextState = cloneIshikawaState(input.state);
  const branch = activeBranch(nextState);
  if (!branch) return { kind: "no_active_subcause" };

  const { cat, mc, sc } = branch;
  const labels = branchLabels(cat, mc, sc);
  const check = evaluateBranchClosure({
    subCauseText: labels.subCauseName,
    whys: whyTexts(sc.whys),
    llmVerdict: input.llmVerdict,
  });

  if (check.decision.action === "close" && input.llmVerdict) {
    // Cierre legítimo: se libera la subcausa, igual que en el cierre por calidad.
    sc.closure = reviewedClosure("student_confirm", input.now);
    sc.reformulateWhy = false;
    nextState.cursor = { categoryId: cat.id, mainCauseId: mc.id };

    return {
      kind: "closed",
      nextState,
      labels,
      rootCause: check.lastWhy ?? labels.subCauseName,
      reason: input.llmVerdict.reason,
      path: { categoryId: cat.id, mainCauseId: mc.id, subCauseId: sc.id },
    };
  }

  // Al reformular, el próximo porqué aceptado reemplaza al último.
  if (check.decision.action === "reformulate") sc.reformulateWhy = true;

  return { kind: "not_ready", nextState, ...notReady(labels, check, input.llmVerdict) };
}

export async function resolveCloseConfirmation(
  input: { state: IshikawaState; now: string },
  judge: BranchJudge
): Promise<CloseConfirmationOutcome> {
  const branch = closeConfirmationBranchToJudge(input.state);
  const llmVerdict = branch ? await judge(branch) : undefined;
  return decideCloseConfirmation({ ...input, llmVerdict });
}

// ---------------------------------------------------------------------------
// Cursor decidido por el LLM (camino general)
// ---------------------------------------------------------------------------

// Qué hizo el LLM con el cursor cuando había una subcausa abierta:
// - kept: sigue en la misma subcausa (o no había subcausa abierta).
// - navigation: pasó a otra categoría, a otra causa principal o a otra subcausa (también
//   a una subcausa nueva en la misma causa principal). La rama anterior queda
//   abandonada, sin closure; no se bloquea.
// - release: soltó la subcausa sin ir a otra rama (patrón de cierre de la regla 8 del
//   prompt, o cursor vacío). Se valida con el gate antes de aceptarlo.
export type LlmCursorChange = "kept" | "navigation" | "release";

function hasNewSubCause(prev: BranchNodes, mergedState: IshikawaState): boolean {
  const mergedCat = (mergedState.categories ?? []).find((c) => c.id === prev.cat.id);
  const mergedMc = (mergedCat?.mainCauses ?? []).find((m) => m.id === prev.mc.id);
  if (!mergedMc) return false;

  const previousIds = new Set((prev.mc.subCauses ?? []).map((s) => s.id));
  return (mergedMc.subCauses ?? []).some((s) => !previousIds.has(s.id));
}

export function classifyLlmCursorChange(
  prevState: IshikawaState,
  mergedState: IshikawaState
): LlmCursorChange {
  const prev = activeBranch(prevState);
  if (!prev) return "kept";

  if (activeBranch(mergedState)?.sc.id === prev.sc.id) return "kept";

  const next = mergedState.cursor ?? null;
  if (next?.subCauseId) return "navigation";
  if (!next?.categoryId) return "release";
  if (next.categoryId !== prev.cat.id) return "navigation";
  if (next.mainCauseId && next.mainCauseId !== prev.mc.id) return "navigation";
  if (next.mainCauseId && hasNewSubCause(prev, mergedState)) return "navigation";

  return "release";
}

function releasedBranch(prevState: IshikawaState, mergedState: IshikawaState): BranchNodes | null {
  if (classifyLlmCursorChange(prevState, mergedState) !== "release") return null;

  const prev = activeBranch(prevState);
  if (!prev) return null;

  return locateBranch(mergedState, {
    categoryId: prev.cat.id,
    mainCauseId: prev.mc.id,
    subCauseId: prev.sc.id,
  });
}

export type LlmCursorOutcome =
  | { kind: "accepted"; nextState: IshikawaState }
  | {
      kind: "closed";
      nextState: IshikawaState;
      labels: BranchLabels;
      rootCause: string;
      reason: string;
      path: RootPath;
    }
  | ({ kind: "kept_open"; nextState: IshikawaState } & BranchNotReady);

export function llmReleaseBranchToJudge(
  prevState: IshikawaState,
  mergedState: IshikawaState
): BranchForJudge | null {
  return branchToJudge(releasedBranch(prevState, mergedState));
}

// El LLM soltó la subcausa activa: se acepta solo si el gate cierra la rama (y entonces
// se escribe closure). Si no, el cursor vuelve a la subcausa y el resultado dice qué falta.
export function decideLlmCursorRelease(input: {
  prevState: IshikawaState;
  mergedState: IshikawaState;
  now: string;
  llmVerdict?: LlmActionabilityVerdict | null;
}): LlmCursorOutcome {
  const nextState = cloneIshikawaState(input.mergedState);
  const branch = releasedBranch(input.prevState, nextState);
  if (!branch) return { kind: "accepted", nextState };

  const { cat, mc, sc } = branch;
  const labels = branchLabels(cat, mc, sc);
  const check = evaluateBranchClosure({
    subCauseText: labels.subCauseName,
    whys: whyTexts(sc.whys),
    llmVerdict: input.llmVerdict,
  });

  if (check.decision.action === "close") {
    sc.closure = reviewedClosure("system", input.now);
    sc.reformulateWhy = false;
    return {
      kind: "closed",
      nextState,
      labels,
      rootCause: check.lastWhy ?? labels.subCauseName,
      reason: input.llmVerdict?.reason ?? "",
      path: { categoryId: cat.id, mainCauseId: mc.id, subCauseId: sc.id },
    };
  }

  nextState.cursor = { categoryId: cat.id, mainCauseId: mc.id, subCauseId: sc.id };
  if (check.decision.action === "reformulate") sc.reformulateWhy = true;

  return { kind: "kept_open", nextState, ...notReady(labels, check, input.llmVerdict) };
}

export async function resolveLlmCursorRelease(
  input: { prevState: IshikawaState; mergedState: IshikawaState; now: string },
  judge: BranchJudge
): Promise<LlmCursorOutcome> {
  const branch = llmReleaseBranchToJudge(input.prevState, input.mergedState);
  const llmVerdict = branch ? await judge(branch) : undefined;
  return decideLlmCursorRelease({ ...input, llmVerdict });
}

// El LLM no escribe campos del servidor: cada subcausa conserva closure,
// rejectedWhyAttempts y reformulateWhy como estaban antes del turno (o ninguno), y el estado
// conserva el registro de raíces y la pregunta pendiente. Si el último porqué de una rama
// revisada cambió, la rama se reabre.
export function protectServerFields(
  prevState: IshikawaState,
  mergedState: IshikawaState,
  now: string
): IshikawaState {
  const key = (categoryId: string, mainCauseId: string, subCauseId: string) =>
    `${categoryId}/${mainCauseId}/${subCauseId}`;

  const previous = new Map<string, IshikawaSubCause>();
  for (const cat of prevState.categories ?? []) {
    for (const mc of cat.mainCauses ?? []) {
      for (const sc of mc.subCauses ?? []) previous.set(key(cat.id, mc.id, sc.id), sc);
    }
  }

  const nextState = hydrateServerFields(mergedState, prevState);

  for (const cat of nextState.categories ?? []) {
    for (const mc of cat.mainCauses ?? []) {
      for (const sc of mc.subCauses ?? []) {
        const prevSc = previous.get(key(cat.id, mc.id, sc.id));
        if (!prevSc || !sc.closure?.reviewed) continue;

        const prevWhys = whyTexts(prevSc.whys);
        const nextWhys = whyTexts(sc.whys);
        const lastChanged = prevWhys[prevWhys.length - 1] !== nextWhys[nextWhys.length - 1];

        if (lastChanged) {
          sc.closure = reopenClosure(sc.closure, now);
          releaseRootOccurrenceInPlace(nextState, {
            categoryId: cat.id,
            mainCauseId: mc.id,
            subCauseId: sc.id,
          });
        }
      }
    }
  }

  return nextState;
}

// Camino general: el LLM puede devolver listas de porqués recortadas o con texto propio. Los
// porqués que ya estaban se conservan tal cual y en su orden (sobre ellos se cuenta la
// profundidad y decide el gate); solo los que el LLM agregó en este turno pasan por
// sanitizeWhyList, que descarta texto meta o vacío. Máximo MAX_WHY_DEPTH, como al guardar.
export function keepStoredWhys(prevState: IshikawaState, nextState: IshikawaState): IshikawaState {
  const key = (categoryId: string, mainCauseId: string, subCauseId: string) =>
    `${categoryId}/${mainCauseId}/${subCauseId}`;

  const previous = new Map<string, string[]>();
  for (const cat of prevState.categories ?? []) {
    for (const mc of cat.mainCauses ?? []) {
      for (const sc of mc.subCauses ?? []) previous.set(key(cat.id, mc.id, sc.id), whyTexts(sc.whys));
    }
  }

  const out = cloneIshikawaState(nextState);

  for (const cat of out.categories ?? []) {
    for (const mc of cat.mainCauses ?? []) {
      for (const sc of mc.subCauses ?? []) {
        const stored = previous.get(key(cat.id, mc.id, sc.id)) ?? [];
        const storedKeys = new Set(stored.map((why) => why.toLowerCase()));
        const added = whyTexts(sc.whys).filter((why) => !storedKeys.has(why.toLowerCase()));

        sc.whys = dedupeWhys(stored, sanitizeWhyList(added), MAX_WHY_DEPTH);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ruta rápida: respuesta corta con una subcausa abierta
// ---------------------------------------------------------------------------

// Intención contextual de la rama (clasificador por IA de ishikawa/assistant).
export type ContextualBranchIntent =
  | "SWITCH_CATEGORY"
  | "META_PROCESS"
  | "ASK_GUIDANCE"
  | "ANSWER_WHY"
  | "CONTINUE_SAME_CATEGORY"
  | "OTHER";

export type FastPathWhyInput = {
  state: IshikawaState;
  studentMessage: string;
  contextualIntent: ContextualBranchIntent | null;
  now: string;
  llmVerdict?: LlmActionabilityVerdict | null;
};

// Qué debe responder la ruta y con qué estado. La redacción (y las llamadas a Gemini
// para ayudar a redactar) quedan en la ruta.
export type FastPathWhyOutcome =
  | { kind: "no_active_subcause" }
  | { kind: "switch_category" }
  | { kind: "meta" }
  | { kind: "guided_help"; labels: BranchLabels; whys: string[] }
  | { kind: "blocked"; nextState: IshikawaState; reason: WhyBlockReason; hint: string }
  | {
      kind: "escalate";
      nextState: IshikawaState;
      labels: BranchLabels;
      reason: WhyBlockReason;
      hint: string;
      lastWhy: string | null;
    }
  | {
      kind: "closed";
      nextState: IshikawaState;
      labels: BranchLabels;
      rootCause: string;
      reason: string;
      path: RootPath;
    }
  | { kind: "reformulate"; nextState: IshikawaState; hint: string; lastWhy: string }
  | {
      kind: "ask_next";
      nextState: IshikawaState;
      labels: BranchLabels;
      whys: string[];
      hint?: string;
    };

type FastPathPlan = { outcome: FastPathWhyOutcome; judge: BranchForJudge | null };

function planFastPathWhyTurn(input: FastPathWhyInput): FastPathPlan {
  const done = (outcome: FastPathWhyOutcome): FastPathPlan => ({ outcome, judge: null });

  const nextState = cloneIshikawaState(input.state);
  const branch = activeBranch(nextState);
  if (!branch) return done({ kind: "no_active_subcause" });

  const { cat, mc, sc } = branch;
  const labels = branchLabels(cat, mc, sc);
  // Lista guardada tal cual: sobre ella se cuenta la profundidad, se decide el cierre y se
  // arman los prompts. (sanitizeWhyList descartaba porqués sin frase causal, como "tardan" o
  // "no conoce el proceso", y la ruta rápida contaba menos profundidad que la real.)
  const storedWhys = whyTexts(sc.whys);
  const answerRaw = input.studentMessage.trim();
  const whyIntent = classifyWhyIntent(answerRaw);
  const guidedHelp = done({ kind: "guided_help", labels, whys: storedWhys });

  // 1) Cambio de contexto/categoría: no se trata como causa.
  if (whyIntent === "switch_context" || input.contextualIntent === "SWITCH_CATEGORY") {
    return done({ kind: "switch_category" });
  }

  // 2) Consulta meta del proceso: se responde según la rama activa.
  if (whyIntent === "meta_process" || input.contextualIntent === "META_PROCESS") {
    return done({ kind: "meta" });
  }

  // 3) Pide ayuda o ejemplos, no responde una causa.
  if (
    whyIntent === "ask_guidance" ||
    whyIntent === "ask_example" ||
    input.contextualIntent === "ASK_GUIDANCE"
  ) {
    return guidedHelp;
  }

  // 4) Mensaje de navegación/control residual.
  if (isNonCausalMessage(answerRaw)) return done({ kind: "meta" });

  // 5) Todavía vaga, no sanitizable o no accionable como texto: ayuda contextual.
  if (isVagueWhyAnswer(answerRaw)) return guidedHelp;

  const cleanWhy = sanitizeWhyCandidate(answerRaw);
  if (!cleanWhy) return guidedHelp;

  const answer = normalizeWhyText(cleanWhy);
  if (!isActionableWhyText(answer)) return guidedHelp;

  // Modo reformulación: el tope ya se alcanzó; la respuesta reemplaza al último porqué en
  // vez de agregar uno nuevo.
  const reformulating = sc.reformulateWhy === true || storedWhys.length >= MAX_WHY_DEPTH;

  // El candidato se evalúa ANTES de agregarlo (contrato de evaluateWhyDeterministic). Al
  // reformular no se compara contra el porqué que se está reemplazando.
  const deterministic = evaluateWhyDeterministic({
    why: answer,
    subCauseText: labels.subCauseName,
    previousWhys: reformulating ? storedWhys.slice(0, -1) : storedWhys,
  });

  if (!deterministic.closable) {
    // Rechazo: no se guarda el candidato ni sube la profundidad.
    const attempts = (sc.rejectedWhyAttempts ?? 0) + 1;

    if (attempts < REJECTED_WHY_ATTEMPTS_LIMIT) {
      sc.rejectedWhyAttempts = attempts;
      return done({ kind: "blocked", nextState, reason: deterministic.reason, hint: deterministic.hint });
    }

    // Varios rechazos seguidos: se escala a ayuda con formulaciones para elegir.
    sc.rejectedWhyAttempts = 0;

    return done({
      kind: "escalate",
      nextState,
      labels,
      reason: deterministic.reason,
      hint: deterministic.hint,
      lastWhy: storedWhys.length > 0 ? storedWhys[storedWhys.length - 1] : null,
    });
  }

  // El candidato pasa: se registra y se reinicia el contador de rechazos.
  sc.rejectedWhyAttempts = 0;

  let branchWhys: string[];
  let chainChanged = true;
  if (reformulating) {
    // Reemplaza al último porqué; la lista viaja como autoritativa al guardar.
    branchWhys = [...storedWhys.slice(0, -1), answer];
    sc.whysReplace = true;
    sc.reformulateWhy = false;
  } else {
    const alreadyExists = storedWhys.some((w) => w.toLowerCase() === answer.toLowerCase());
    chainChanged = !alreadyExists;
    branchWhys = alreadyExists ? storedWhys : [...storedWhys, answer];
  }

  sc.whys = branchWhys;

  // La cadena cambió: un cierre revisado anterior deja de valer hasta pasar de nuevo el gate
  // y la rama suelta su causa raíz del registro.
  if (chainChanged && sc.closure?.reviewed) {
    sc.closure = reopenClosure(sc.closure, input.now);
    releaseRootOccurrenceInPlace(nextState, {
      categoryId: cat.id,
      mainCauseId: mc.id,
      subCauseId: sc.id,
    });
  }

  const depth = branchWhys.length;
  const lastWhy = branchWhys[branchWhys.length - 1] ?? answer;
  const decision = decideWhyStep({ depth, deterministic, llmVerdict: input.llmVerdict });

  switch (decision.action) {
    case "consult_quality":
      // Falta el veredicto del LLM y sin él nunca se cierra: la resolución consulta una
      // vez y vuelve a decidir.
      return {
        outcome: { kind: "ask_next", nextState, labels, whys: branchWhys },
        judge: { ...labels, whys: branchWhys },
      };

    case "close":
      // Se libera subCauseId para permitir otra subcausa en la misma causa principal.
      nextState.cursor = { categoryId: cat.id, mainCauseId: mc.id };
      sc.reformulateWhy = false;
      sc.closure = reviewedClosure("system", input.now);
      return done({
        kind: "closed",
        nextState,
        labels,
        rootCause: lastWhy,
        reason: input.llmVerdict?.actionable ? input.llmVerdict.reason : "",
        path: { categoryId: cat.id, mainCauseId: mc.id, subCauseId: sc.id },
      });

    case "reformulate":
      // No se agrega un porqué más: el siguiente reemplaza al último.
      sc.reformulateWhy = true;
      return done({ kind: "reformulate", nextState, hint: decision.hint, lastWhy });

    case "ask_next":
      return done({ kind: "ask_next", nextState, labels, whys: branchWhys, hint: decision.hint });
  }
}

// Decisión de un turno de la ruta rápida con la subcausa abierta.
export function decideFastPathWhyTurn(input: FastPathWhyInput): FastPathWhyOutcome {
  return planFastPathWhyTurn(input).outcome;
}

// Rama a llevar al juicio del LLM en este turno, o null si la decisión no lo necesita.
export function fastPathBranchToJudge(input: FastPathWhyInput): BranchForJudge | null {
  return planFastPathWhyTurn(input).judge;
}

// Turno completo: consulta al LLM a lo sumo una vez y solo si el gate lo pide.
export async function resolveFastPathWhyTurn(
  input: Omit<FastPathWhyInput, "llmVerdict">,
  judge: BranchJudge
): Promise<FastPathWhyOutcome> {
  const plan = planFastPathWhyTurn(input);
  if (!plan.judge) return plan.outcome;

  const llmVerdict = await judge(plan.judge);
  return decideFastPathWhyTurn({ ...input, llmVerdict });
}
