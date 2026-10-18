// src/lib/plan/ishikawaResume.ts

// Ramas sin terminar de Ishikawa (E4) y cómo retomarlas. Lógica pura: sin I/O ni IA.
//
// Una rama sin cierre revisado no cuenta como causa raíz (REQUIRE_REVIEWED_CLOSURE). Para que
// el estudiante pueda terminarla, el servidor lista las ramas sin revisar en orden del árbol
// (numeradas: ese número es el que el estudiante usa para nombrarlas) y mueve el cursor a la
// elegida sin depender de Gemini. Al retomarla, el mensaje siguiente sigue el flujo normal:
// más porqués o "cerremos", siempre por el gate de calidad. Si la rama quedó en el tope de
// porqués o esperando una reformulación, se pide reformular el último, no un porqué más.

import { branchLabels, type BranchLabels } from "./ishikawaBranchFlow";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import {
  cloneIshikawaState,
  findActiveNodes,
  isClosureReviewed,
  whyTexts,
  type IshikawaState,
} from "./ishikawaTree";
import type { RootPath } from "./ishikawaRootRegistry";
import { normalizeIntentText } from "./ishikawaWhyInterpreter";
import { significantTokens } from "./whyQuality";

export type UnreviewedBranch = {
  index: number; // 1, 2, 3… en orden del árbol
  path: RootPath;
  labels: BranchLabels;
  whys: string[];
  awaitingReformulation: boolean; // llegó al tope o quedó esperando reformular el último porqué
};

// Qué se le pide al estudiante en una rama abierta.
export type BranchPromptKind = "reformulate" | "ask_why" | "ask_first_why";

function isPlaceholder(value: string): boolean {
  const t = value.trim().toLowerCase();
  return !t || t === "causa" || t === "subcausa";
}

function samePath(a: RootPath, b: RootPath): boolean {
  return a.categoryId === b.categoryId && a.mainCauseId === b.mainCauseId && a.subCauseId === b.subCauseId;
}

export function branchPromptKind(whys: readonly string[], reformulateWhy: boolean | undefined): BranchPromptKind {
  if (reformulateWhy === true || whys.length >= MAX_WHY_DEPTH) return "reformulate";
  return whys.length === 0 ? "ask_first_why" : "ask_why";
}

// Ramas sin cierre revisado, en orden del árbol. Se omiten las subcausas vacías (sin nombre
// útil ni porqués). Tolera estados sin tipar (state_json de la base).
export function listUnreviewedBranches(state: IshikawaState): UnreviewedBranch[] {
  const branches: UnreviewedBranch[] = [];
  const categories = Array.isArray(state?.categories) ? state.categories : [];

  for (const cat of categories) {
    if (!cat || typeof cat.id !== "string") continue;
    const mainCauses = Array.isArray(cat.mainCauses) ? cat.mainCauses : [];

    for (const mc of mainCauses) {
      if (!mc || typeof mc.id !== "string") continue;
      const subCauses = Array.isArray(mc.subCauses) ? mc.subCauses : [];

      for (const sc of subCauses) {
        if (!sc || typeof sc.id !== "string") continue;
        if (isClosureReviewed(sc.closure)) continue;

        const whys = whyTexts(sc.whys);
        if (whys.length === 0 && isPlaceholder(sc.name ?? sc.text ?? "")) continue;

        branches.push({
          index: branches.length + 1,
          path: { categoryId: cat.id, mainCauseId: mc.id, subCauseId: sc.id },
          labels: branchLabels(cat, mc, sc),
          whys,
          awaitingReformulation: branchPromptKind(whys, sc.reformulateWhy) === "reformulate",
        });
      }
    }
  }

  return branches;
}

export function describeUnreviewedBranch(branch: UnreviewedBranch): string {
  const { categoryName, mainCauseName, subCauseName } = branch.labels;
  const depth = branch.whys.length;
  const status = branch.awaitingReformulation
    ? "espera que reformules el último porqué"
    : depth === 0
      ? "sin porqués"
      : `${depth} ${depth === 1 ? "porqué" : "porqués"}`;

  return `${categoryName} → ${mainCauseName} → ${subCauseName} (${status})`;
}

// Lista numerada de ramas sin terminar con la forma de retomarlas, o null si no hay ninguna.
// La rama activa se omite si se indica (el estudiante ya está en ella); los números son los
// de listUnreviewedBranches, así que no cambian por omitirla.
export function buildUnreviewedBranchesOffer(
  branches: readonly UnreviewedBranch[],
  options: { max?: number; activePath?: RootPath | null } = {}
): string | null {
  const activePath = options.activePath ?? null;
  const shown = branches.filter((branch) => !activePath || !samePath(branch.path, activePath));
  if (shown.length === 0) return null;

  const max = options.max ?? 5;
  const lines = [
    shown.length === 1
      ? "Te queda 1 rama sin terminar; no cuenta como causa raíz hasta cerrarla:"
      : `Te quedan ${shown.length} ramas sin terminar; no cuentan como causa raíz hasta cerrarlas:`,
  ];

  for (const branch of shown.slice(0, max)) lines.push(`${branch.index}) ${describeUnreviewedBranch(branch)}`);
  if (shown.length > max) {
    lines.push(`… y ${shown.length - max} más (escribe "muéstrame el avance" para verlas todas).`);
  }

  lines.push(`Para retomar una, escribe **retomar ${shown[0].index}** o el nombre de la subcausa.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pedido de retomar una rama
// ---------------------------------------------------------------------------

export type ResumeRequest =
  | { kind: "resume"; branch: UnreviewedBranch }
  | { kind: "choose"; reason: "no_reference" | "not_found" | "ambiguous"; options: UnreviewedBranch[] }
  | { kind: "nothing_pending" };

// "retomar", "volvamos a…": siempre es un pedido de retomar; si no se entiende cuál, se
// ofrecen las opciones.
const RESUME_LEAD =
  /^(?:(?:quiero|podemos|vamos a|me gustaria|prefiero|mejor)\s+)?(?:retomar|retomemos|retoma|retomo|volver a|volvamos a|vuelvo a|regresar a|regresemos a|regreso a)(?:\s+(.*))?$/;

// "sigamos con…", "terminemos…": solo retoma si nombra una rama sin terminar; si no, el
// mensaje sigue su camino ("sigamos con otra causa", "continuemos con Método").
const SOFT_LEAD =
  /^(?:(?:quiero|podemos|mejor)\s+)?(?:sigamos con|continuemos con|seguir con|continuar con|terminemos|terminar|completemos|completar|trabajemos)(?:\s+(.*))?$/;

// Solo una referencia ("2", "la 2", "rama 3", "la segunda"): vale cuando no hay una subcausa
// abierta esperando respuesta.
const BARE_REFERENCE = /^(?:(?:la|el)\s+)?(?:(?:rama|subcausa|opcion|numero|nro)\s+)?(\d{1,2}|[a-z]+)$/;

const ORDINALS: Record<string, number> = {
  primera: 1,
  primero: 1,
  primer: 1,
  segunda: 2,
  segundo: 2,
  tercera: 3,
  tercero: 3,
  tercer: 3,
  cuarta: 4,
  cuarto: 4,
  quinta: 5,
  quinto: 5,
  sexta: 6,
  sexto: 6,
  septima: 7,
  septimo: 7,
  octava: 8,
  octavo: 8,
  novena: 9,
  noveno: 9,
  decima: 10,
  decimo: 10,
};

// Palabras de la referencia que no nombran a la rama.
const REFERENCE_NOISE = new Set([
  "rama",
  "ramas",
  "subcausa",
  "subcausas",
  "causa",
  "causas",
  "opcion",
  "numero",
  "nro",
  "esa",
  "esta",
  "aquella",
  "sobre",
  "dice",
  "habla",
  "anterior",
]);

// Cobertura mínima de los términos de la referencia en el nombre de la rama.
const RESUME_NAME_MIN_COVERAGE = 0.6;

function indexFromWord(word: string, count: number): number | null {
  if (/^\d{1,2}$/.test(word)) return Number(word);
  if (word === "ultima" || word === "ultimo") return count > 0 ? count : null;
  return ORDINALS[word] ?? null;
}

function nameCoverage(referenceTokens: ReadonlySet<string>, branch: UnreviewedBranch): number {
  const names = [
    branch.labels.subCauseName,
    `${branch.labels.mainCauseName} ${branch.labels.subCauseName}`,
  ];

  let best = 0;
  for (const name of names) {
    const tokens = new Set(significantTokens(name));
    const shared = [...referenceTokens].filter((token) => tokens.has(token)).length;
    best = Math.max(best, shared / referenceTokens.size);
  }

  return best;
}

type ReferenceResolution =
  | { kind: "found"; branch: UnreviewedBranch }
  | { kind: "ambiguous"; options: UnreviewedBranch[] }
  | { kind: "not_found" }
  | { kind: "empty" };

function resolveReference(reference: string, branches: readonly UnreviewedBranch[]): ReferenceResolution {
  const referenceWords = words(reference).filter((word) => !REFERENCE_NOISE.has(word));
  const cleaned = referenceWords.filter((word) => !["la", "el", "de", "del", "los", "las", "un", "una"].includes(word));
  if (cleaned.length === 0) return { kind: "empty" };

  // Por número u ordinal: "2", "la segunda", "rama 3".
  const numeric = indexFromWord(cleaned[0], branches.length);
  if (numeric !== null) {
    const branch = branches.find((candidate) => candidate.index === numeric);
    return branch ? { kind: "found", branch } : { kind: "not_found" };
  }

  // Por nombre: la subcausa (o causa principal + subcausa) que más términos de la referencia
  // contiene.
  const referenceTokens = new Set(significantTokens(cleaned.join(" ")).filter((token) => !REFERENCE_NOISE.has(token)));
  if (referenceTokens.size === 0) return { kind: "empty" };

  const scored = branches
    .map((branch) => ({ branch, score: nameCoverage(referenceTokens, branch) }))
    .filter((candidate) => candidate.score >= RESUME_NAME_MIN_COVERAGE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "not_found" };

  const top = scored.filter((candidate) => candidate.score === scored[0].score);
  if (top.length > 1) return { kind: "ambiguous", options: top.map((candidate) => candidate.branch) };

  return { kind: "found", branch: scored[0].branch };
}

function words(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

export function detectResumeRequest(
  message: string,
  branches: readonly UnreviewedBranch[],
  options: { allowBareReference: boolean }
): ResumeRequest | null {
  const t = normalizeIntentText(message);
  if (!t) return null;

  const lead = RESUME_LEAD.exec(t);
  if (lead) {
    if (branches.length === 0) return { kind: "nothing_pending" };

    const resolution = resolveReference(lead[1] ?? "", branches);
    if (resolution.kind === "found") return { kind: "resume", branch: resolution.branch };
    if (resolution.kind === "ambiguous") return { kind: "choose", reason: "ambiguous", options: resolution.options };

    return {
      kind: "choose",
      reason: resolution.kind === "empty" ? "no_reference" : "not_found",
      options: [...branches],
    };
  }

  const soft = SOFT_LEAD.exec(t);
  if (soft && branches.length > 0) {
    const resolution = resolveReference(soft[1] ?? "", branches);
    if (resolution.kind === "found") return { kind: "resume", branch: resolution.branch };
    if (resolution.kind === "ambiguous") return { kind: "choose", reason: "ambiguous", options: resolution.options };
    return null;
  }

  if (options.allowBareReference && branches.length > 0) {
    const bare = BARE_REFERENCE.exec(t);
    const index = bare ? indexFromWord(bare[1], branches.length) : null;
    const branch = index !== null ? branches.find((candidate) => candidate.index === index) : undefined;
    if (branch) return { kind: "resume", branch };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mover el cursor a la rama
// ---------------------------------------------------------------------------

export type ResumeOutcome =
  | { kind: "resumed"; nextState: IshikawaState; branch: UnreviewedBranch; prompt: BranchPromptKind }
  | { kind: "not_found" };

// Mueve el cursor a una rama sin revisar. No toca porqués ni campos del servidor: la rama sigue
// exactamente como quedó, incluido reformulateWhy.
export function resumeBranch(state: IshikawaState, path: RootPath): ResumeOutcome {
  const branch = listUnreviewedBranches(state).find((candidate) => samePath(candidate.path, path));
  if (!branch) return { kind: "not_found" };

  const nextState = cloneIshikawaState(state);
  nextState.cursor = { ...path };

  return {
    kind: "resumed",
    nextState,
    branch,
    prompt: branch.awaitingReformulation ? "reformulate" : branch.whys.length === 0 ? "ask_first_why" : "ask_why",
  };
}

// Rama activa (subcausa del cursor) con lo que se le pide al estudiante, o null si no hay.
export function activeBranchPrompt(
  state: IshikawaState
): { labels: BranchLabels; whys: string[]; path: RootPath; prompt: BranchPromptKind } | null {
  const active = findActiveNodes(state);
  if (!active?.sc) return null;

  const whys = whyTexts(active.sc.whys);
  return {
    labels: branchLabels(active.cat, active.mc, active.sc),
    whys,
    path: { categoryId: active.cat.id, mainCauseId: active.mc.id, subCauseId: active.sc.id },
    prompt: branchPromptKind(whys, active.sc.reformulateWhy),
  };
}
