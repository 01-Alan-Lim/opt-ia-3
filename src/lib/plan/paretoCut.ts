// src/lib/plan/paretoCut.ts

// Verificación del principio de Pareto (CLAUDE.md): el corte no es un 20% fijo.
// Un grupo minoritario de causas debe concentrar la mayor parte del problema,
// con un desbalance claro entre ambos porcentajes (10/90, 25/75, 30/70...).

export const PARETO_MIN_IMBALANCE_POINTS = 20;

export const PARETO_EFFECT_QUESTION =
  "¿Qué porcentaje del problema concentran esas causas según tu Excel, y por qué crees que son las críticas?";

export type ParetoCutFailureReason =
  | "no_critical"
  | "no_effect"
  | "not_minority"
  | "not_majority"
  | "weak_imbalance";

export type ParetoCutResult =
  | { ok: true; causesPercent: number; effectPercent: number }
  | {
      ok: false;
      reason: ParetoCutFailureReason;
      causesPercent: number;
      effectPercent: number | null;
    };

export type ParetoCriticalSelection = {
  criticalRoots: string[];
  criticalEffectPercent: number | null;
  criticalJustification: string | null;
};

type ParetoCutCounts = {
  criticalCount: number;
  selectedCount: number;
};

const MAX_JUSTIFICATION_LENGTH = 600;

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeEffectPercent(input: unknown): number | null {
  if (typeof input !== "number" && typeof input !== "string") return null;
  if (typeof input === "string" && !input.trim()) return null;

  const value = typeof input === "number" ? input : Number(input.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;

  return roundOneDecimal(value);
}

export function normalizeJustification(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.replace(/\s+/g, " ").trim();
  return value ? value.slice(0, MAX_JUSTIFICATION_LENGTH) : null;
}

export function evaluateParetoCut(input: {
  selectedCount: number;
  criticalCount: number;
  effectPercent: unknown;
}): ParetoCutResult {
  const rawCausesPercent =
    input.selectedCount > 0 ? (input.criticalCount * 100) / input.selectedCount : 0;
  const causesPercent = roundOneDecimal(rawCausesPercent);
  const effectPercent = normalizeEffectPercent(input.effectPercent);

  if (input.criticalCount <= 0) {
    return { ok: false, reason: "no_critical", causesPercent, effectPercent };
  }

  if (effectPercent === null) {
    return { ok: false, reason: "no_effect", causesPercent, effectPercent };
  }

  if (rawCausesPercent >= 50) {
    return { ok: false, reason: "not_minority", causesPercent, effectPercent };
  }

  if (effectPercent <= 50) {
    return { ok: false, reason: "not_majority", causesPercent, effectPercent };
  }

  // Cubre también el caso efecto <= causas (sin desbalance).
  if (effectPercent - rawCausesPercent < PARETO_MIN_IMBALANCE_POINTS) {
    return { ok: false, reason: "weak_imbalance", causesPercent, effectPercent };
  }

  return { ok: true, causesPercent, effectPercent };
}

export function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
}

export function describeParetoCut(
  cut: Extract<ParetoCutResult, { ok: true }>,
  counts: ParetoCutCounts
): string {
  const verb = counts.criticalCount === 1 ? "concentra" : "concentran";
  return `${counts.criticalCount} de tus ${counts.selectedCount} causas (${formatPercent(cut.causesPercent)}%) ${verb} el ${formatPercent(cut.effectPercent)}% del problema.`;
}

export function describeParetoCutProblem(
  cut: Extract<ParetoCutResult, { ok: false }>,
  counts: ParetoCutCounts
): string {
  const share = `${counts.criticalCount} de ${counts.selectedCount} causas (${formatPercent(cut.causesPercent)}%)`;
  const effect = cut.effectPercent === null ? "" : formatPercent(cut.effectPercent);

  switch (cut.reason) {
    case "no_critical":
      return "Aún falta tu grupo crítico: las causas que, según tu Excel, concentran la mayor parte del problema. Envíamelas una por línea o en viñetas.";
    case "no_effect":
      return `Ya tengo tu grupo crítico, pero falta el porcentaje del problema que concentra. ${PARETO_EFFECT_QUESTION}`;
    case "not_minority":
      return `Tu grupo crítico tiene ${share}. En Pareto el grupo crítico debe ser una minoría de las causas. Revisa en tu Excel cuáles son las pocas causas que concentran la mayor parte del problema y envíame solo esa lista.`;
    case "not_majority":
      return `Con ${share} concentras el ${effect}% del problema. Para que se vea el efecto Pareto, el grupo crítico debe concentrar más de la mitad del problema. Revisa tu acumulado en el Excel: ¿hasta qué causa llegas al superar el 50%?`;
    case "weak_imbalance": {
      const gap = formatPercent(roundOneDecimal((cut.effectPercent ?? 0) - cut.causesPercent));
      return `Con ${share} concentras el ${effect}% del problema: la diferencia es de solo ${gap} puntos. Para evidenciar el principio de Pareto, el grupo crítico debe concentrar al menos ${PARETO_MIN_IMBALANCE_POINTS} puntos más del problema de lo que representa en número de causas. Revisa tu acumulado: ¿hay un grupo más pequeño que concentre casi lo mismo?`;
    }
  }
}

function selectionKey(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameRootSet(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const keys = new Set(first.map(selectionKey));
  return second.every((item) => keys.has(selectionKey(item)));
}

// Una entrega nueva del grupo crítico REEMPLAZA la anterior (no se une): así el
// estudiante puede achicarlo al corregir. Una lista vacía no borra lo guardado.
export function mergeCriticalSelection(
  base: ParetoCriticalSelection,
  incoming: ParetoCriticalSelection
): ParetoCriticalSelection {
  if (incoming.criticalRoots.length === 0) {
    return {
      criticalRoots: base.criticalRoots,
      criticalEffectPercent: base.criticalEffectPercent,
      criticalJustification: base.criticalJustification,
    };
  }

  const sameList = sameRootSet(base.criticalRoots, incoming.criticalRoots);

  return {
    criticalRoots: incoming.criticalRoots,
    criticalEffectPercent:
      incoming.criticalEffectPercent ?? (sameList ? base.criticalEffectPercent : null),
    criticalJustification:
      incoming.criticalJustification ?? (sameList ? base.criticalJustification : null),
  };
}
