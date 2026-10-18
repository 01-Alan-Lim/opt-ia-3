// src/lib/plan/ishikawaReadiness.ts

// ¿Se puede cerrar la Etapa 4 (Ishikawa)? Lógica pura, sin I/O. Son las reglas de
// ishikawa/validate, que es la autoridad para cerrar la etapa: el mapa, la respuesta a
// "pasemos a Pareto", el cliente y el arnés de simulación usan esta misma función para no
// contradecirla.

import { MIN_ROOT_CAUSES } from "./rootCauseLimits";
import { deriveRootCauses } from "./ishikawaRoots";
import { parsePendingRootMatch, whyTexts } from "./ishikawaTree";

type LooseRecord = Record<string, unknown>;

// Valores de ishikawa/validate cuando el estado no los trae (el guardado los fija con
// STAGE4_RULES).
const DEFAULT_MIN_CATEGORIES = 3;
const DEFAULT_MIN_MAIN_CAUSES = 2;
const DEFAULT_MIN_SUB_CAUSES = 1;

export type CategoryProgress = { name: string; completeMainCauses: number };

export type IshikawaReadiness = {
  ready: boolean;
  hasProblem: boolean;
  pendingRootQuestion: boolean;
  requiredCategories: number;
  requiredMainCausesPerCategory: number;
  requiredSubCausesPerMain: number;
  categories: CategoryProgress[];
  completeCategories: number;
  rootCount: number;
  requiredRoots: number;
};

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null;
}

function records(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isPlaceholder(value: string): boolean {
  const t = value.toLowerCase();
  return !t || t === "causa" || t === "subcausa";
}

// Subcausa válida: nombre útil o al menos un porqué (misma regla que ishikawa/validate).
function isSubCauseValid(sc: LooseRecord): boolean {
  const label = sc.name ?? sc.text;
  const name = label === undefined || label === null ? "" : String(label).trim();
  if (name && !isPlaceholder(name)) return true;
  return whyTexts(sc.whys).length > 0;
}

function problemText(state: LooseRecord): string {
  const problem = state.problem;
  if (typeof problem === "string") return problem;
  if (isRecord(problem) && typeof problem.text === "string") return problem.text;
  return "";
}

export function evaluateIshikawaReadiness(state: unknown): IshikawaReadiness {
  const s: LooseRecord = isRecord(state) ? state : {};

  const requiredCategories = numberOr(s.minCategories, DEFAULT_MIN_CATEGORIES);
  const requiredMainCausesPerCategory = numberOr(s.minMainCausesPerCategory, DEFAULT_MIN_MAIN_CAUSES);
  const requiredSubCausesPerMain = numberOr(s.minSubCausesPerMain, DEFAULT_MIN_SUB_CAUSES);

  const categories: CategoryProgress[] = records(s.categories).map((cat) => ({
    name: typeof cat.name === "string" && cat.name ? cat.name : "Categoría",
    completeMainCauses: records(cat.mainCauses).filter(
      (mc) => records(mc.subCauses).filter(isSubCauseValid).length >= requiredSubCausesPerMain
    ).length,
  }));

  const completeCategories = categories.filter(
    (category) => category.completeMainCauses >= requiredMainCausesPerCategory
  ).length;

  const hasProblem = problemText(s).trim().length > 0;
  const pendingRootQuestion = parsePendingRootMatch(s.pendingRootMatch) !== null;
  const rootCount = deriveRootCauses(state).roots.length;

  return {
    ready:
      hasProblem &&
      !pendingRootQuestion &&
      completeCategories >= requiredCategories &&
      rootCount >= MIN_ROOT_CAUSES,
    hasProblem,
    pendingRootQuestion,
    requiredCategories,
    requiredMainCausesPerCategory,
    requiredSubCausesPerMain,
    categories,
    completeCategories,
    rootCount,
    requiredRoots: MIN_ROOT_CAUSES,
  };
}

// Lo que falta para cerrar la etapa, una línea por punto (vacío si está lista).
export function describeStageCloseGaps(readiness: IshikawaReadiness): string[] {
  const gaps: string[] = [];

  if (!readiness.hasProblem) {
    gaps.push("Registrar el problema principal (la cabeza del Ishikawa).");
  }

  if (readiness.pendingRootQuestion) {
    gaps.push("Responder si las dos causas raíz que te mostré son la misma (sí o no).");
  }

  if (readiness.completeCategories < readiness.requiredCategories) {
    const missing = readiness.requiredCategories - readiness.completeCategories;
    gaps.push(
      `Completar ${missing} ${missing === 1 ? "categoría" : "categorías"} más: cada una con al menos ` +
        `${readiness.requiredMainCausesPerCategory} causas principales que tengan una subcausa ` +
        `(van ${readiness.completeCategories} de ${readiness.requiredCategories}).`
    );
  }

  if (readiness.rootCount < readiness.requiredRoots) {
    const missing = readiness.requiredRoots - readiness.rootCount;
    gaps.push(
      `Cerrar ${missing} ${missing === 1 ? "causa raíz" : "causas raíz"} más (van ${readiness.rootCount} de ` +
        `${readiness.requiredRoots}). Una rama cuenta cuando la cerramos y su último porqué es algo que la ` +
        `empresa puede cambiar.`
    );
  }

  return gaps;
}
