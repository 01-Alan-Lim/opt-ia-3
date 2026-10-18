// src/lib/plan/ishikawaRoots.ts

// Causas raíz de un Ishikawa (E4): única derivación para ishikawa/validate (paso a
// Pareto), el cliente (oferta de cierre de etapa) y el mapa del asistente. Pura, sin I/O;
// acepta estados sin tipar (state_json de la BD o el estado del cliente).
//
// Con REQUIRE_REVIEWED_CLOSURE las raíces salen del registro (state.rootCauses): cada
// entrada cuenta UNA vez aunque aparezca en varias ramas, y solo con ramas revisadas que la
// apuntan (closure.rootId). Las ramas con raíz candidata que no cuentan quedan como
// pendientes de revisar. Sin la exigencia (modo anterior) cuenta cada texto distinto, con el
// mismo criterio de igualdad del registro (normalizeRootText).

import { REQUIRE_REVIEWED_CLOSURE } from "./rootCauseLimits";
import { isClosureReviewed, whyTexts, type IshikawaState } from "./ishikawaTree";
import { normalizeRootText, reconcileRootRegistry } from "./ishikawaRootRegistry";

export type RootBranch = {
  categoryId: string;
  mainCauseId: string;
  subCauseId: string;
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
  root: string;
  reviewed: boolean;
};

// Una causa raíz que cuenta para el mínimo, con las ramas donde apareció.
export type RootEntrySummary = {
  id: string;
  text: string; // canonicalText: como lo escribió el estudiante
  occurrences: number;
  branches: string[]; // "Categoría → Causa principal → Subcausa"
};

export type RootCauseSummary = {
  roots: string[]; // texto de cada causa raíz que cuenta, una vez cada una
  entries: RootEntrySummary[];
  branches: RootBranch[]; // todas las ramas con raíz candidata
  pendingBranches: RootBranch[]; // ramas con raíz candidata que no cuentan todavía
};

type LooseRecord = Record<string, unknown>;

function records(value: unknown): LooseRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is LooseRecord => typeof item === "object" && item !== null)
    : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPlaceholder(value: string): boolean {
  const t = value.toLowerCase();
  return !t || t === "causa" || t === "subcausa";
}

function isStateLike(value: unknown): value is IshikawaState {
  return typeof value === "object" && value !== null && "categories" in value && Array.isArray(value.categories);
}

function branchKey(path: { categoryId: string; mainCauseId: string; subCauseId: string }): string {
  return JSON.stringify([path.categoryId, path.mainCauseId, path.subCauseId]);
}

export function describeRootBranch(branch: RootBranch): string {
  return `${branch.categoryName} → ${branch.mainCauseName} → ${branch.subCauseName}`;
}

// Ramas con raíz candidata: último porqué o, sin porqués, el texto de la subcausa.
function collectBranches(state: unknown): RootBranch[] {
  const categories =
    typeof state === "object" && state !== null && "categories" in state
      ? records(state.categories)
      : [];

  const branches: RootBranch[] = [];

  for (const cat of categories) {
    const categoryName = textOf(cat.name) || "(Categoría)";

    for (const mc of records(cat.mainCauses)) {
      const mainRaw = textOf(mc.name) || textOf(mc.text);
      const mainCauseName = isPlaceholder(mainRaw) ? "(sin nombre de causa principal)" : mainRaw;

      for (const sc of records(mc.subCauses)) {
        const subRaw = textOf(sc.name) || textOf(sc.text);
        const subCauseName = isPlaceholder(subRaw) ? "(sin nombre de subcausa)" : subRaw;

        const whys = whyTexts(sc.whys);
        const root = whys.length > 0 ? whys[whys.length - 1] : textOf(sc.text) || textOf(sc.name);
        if (isPlaceholder(root)) continue;

        branches.push({
          categoryId: textOf(cat.id),
          mainCauseId: textOf(mc.id),
          subCauseId: textOf(sc.id),
          categoryName,
          mainCauseName,
          subCauseName,
          root,
          reviewed: isClosureReviewed(sc.closure),
        });
      }
    }
  }

  return branches;
}

export function deriveRootCauses(
  state: unknown,
  options: { requireReviewedClosure?: boolean } = {}
): RootCauseSummary {
  const requireReviewed = options.requireReviewedClosure ?? REQUIRE_REVIEWED_CLOSURE;
  const branches = collectBranches(state);

  if (!requireReviewed) {
    const groups = new Map<string, RootEntrySummary>();

    for (const branch of branches) {
      const key = normalizeRootText(branch.root);
      const group = groups.get(key);
      if (group) {
        group.occurrences += 1;
        group.branches.push(describeRootBranch(branch));
      } else {
        groups.set(key, { id: key, text: branch.root, occurrences: 1, branches: [describeRootBranch(branch)] });
      }
    }

    const entries = Array.from(groups.values());
    return { roots: entries.map((entry) => entry.text), entries, branches, pendingBranches: [] };
  }

  const registry = isStateLike(state) ? (reconcileRootRegistry(state).rootCauses ?? []) : [];
  const byKey = new Map(branches.map((branch) => [branchKey(branch), branch]));
  const counted = new Set<string>();

  const entries: RootEntrySummary[] = registry.map((entry) => ({
    id: entry.id,
    text: entry.canonicalText,
    occurrences: entry.occurrences.length,
    branches: entry.occurrences.map((occurrence) => {
      const key = branchKey(occurrence);
      counted.add(key);
      const branch = byKey.get(key);
      return branch ? describeRootBranch(branch) : occurrence.text;
    }),
  }));

  return {
    roots: entries.map((entry) => entry.text),
    entries,
    branches,
    pendingBranches: branches.filter((branch) => !counted.has(branchKey(branch))),
  };
}
