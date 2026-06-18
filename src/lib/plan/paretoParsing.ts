export type ParetoCriterionLike = {
  id: string;
  name: string;
  weight?: number;
};

export type ParsedCriterionEntry = {
  name: string;
  weight?: number;
};

export type CriticalRootsParse = {
  roots: string[];
  isDelivery: boolean;
};

type MergeOptions = {
  maxCriteria?: number;
  createId?: () => string;
};

const MAX_CRITERIA_MVP = 3;

const CRITICAL_ROOT_SIGNALS = [
  "causas criticas",
  "causa critica",
  "parametros criticos",
  "parametro critico",
  "grupo critico",
  "top 20",
  "top20",
] as const;

const CRITERION_BLOCKED_NAMES = new Set([
  "criterio",
  "criterios",
  "mis criterios",
  "los criterios",
  "peso",
  "pesos",
  "ponderacion",
  "ponderaciones",
]);

const CRITERION_SIGNALS = [
  "criterio",
  "criterios",
  "priorizar",
  "priorizacion",
  "evaluar",
  "evaluare",
  "voy a evaluar",
  "para evaluar",
  "para priorizar",
  "usare",
  "voy a usar",
  "peso",
] as const;

const CAUSE_PROBLEM_SIGNALS = [
  "causa",
  "causas",
  "causa raiz",
  "causas raiz",
  "causas raices",
  "problema",
  "problemas",
  "parametro critico",
  "parametros criticos",
  "grupo critico",
] as const;

const CRITERION_TERMS = [
  "impacto",
  "frecuencia",
  "costo",
  "costos",
  "facilidad",
  "implementacion",
  "severidad",
  "tiempo",
  "calidad",
  "productividad",
  "metodo",
  "trabajo",
  "trazabilidad",
  "riesgo",
  "urgencia",
  "controlabilidad",
] as const;

const CAUSE_PROBLEM_TERMS = [
  "falta",
  "ausencia",
  "deficiencia",
  "deficiente",
  "defecto",
  "defectuoso",
  "defectuosos",
  "generacion",
  "variabilidad",
  "bajo",
  "baja",
  "perdida",
  "perdido",
  "demora",
  "demoras",
  "retraso",
  "retrasos",
  "error",
  "errores",
  "falla",
  "fallas",
  "incumplimiento",
  "desperdicio",
  "reproceso",
  "produccion",
  "producto",
  "productos",
] as const;

export function normalizeParetoKey(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForSignal(input: string): string {
  return normalizeParetoKey(input)
    .replace(/[.,;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isClearCriticalRootsMessage(message: string): boolean {
  const normalized = normalizeForSignal(message);
  return CRITICAL_ROOT_SIGNALS.some((signal) => normalized.includes(signal));
}

function hasExplicitCriterionSignal(message: string): boolean {
  const normalized = normalizeForSignal(message);
  return (
    CRITERION_SIGNALS.some((signal) => normalized.includes(signal)) ||
    /\(\s*(?:peso\s*)?\d{1,2}(?:\s*\/\s*10)?\s*\)/i.test(message) ||
    /\b\d{1,2}\s*\/\s*10\b/i.test(message)
  );
}

function hasExplicitCauseProblemSignal(message: string): boolean {
  const normalized = normalizeForSignal(message);
  return CAUSE_PROBLEM_SIGNALS.some((signal) => normalized.includes(signal));
}

function containsAnyTerm(value: string, terms: readonly string[]) {
  const normalized = normalizeForSignal(value);
  return terms.some((term) => normalized.includes(term));
}

function isWeightsOnlyMessage(message: string): boolean {
  const normalized = normalizeForSignal(message);
  const hasWeightSignal =
    normalized.includes("pesos son") ||
    normalized.includes("ponderaciones son") ||
    normalized.includes("primero") ||
    normalized.includes("segundo") ||
    normalized.includes("tercero") ||
    normalized.includes("al primero") ||
    normalized.includes("al segundo") ||
    normalized.includes("al tercero");

  return hasWeightSignal && !normalized.includes("criterio");
}

function isValidWeight(value: number): value is number {
  return Number.isFinite(value) && value >= 1 && value <= 10;
}

function readWeight(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return isValidWeight(value) ? value : undefined;
}

function extractWeightFromSegment(segment: string): number | undefined {
  const parenthetical = segment.match(/\(\s*(?:peso\s*)?(\d{1,2})(?:\s*\/\s*10)?\s*\)/i);
  if (parenthetical) return readWeight(parenthetical[1]);

  const explicitWeight = segment.match(/\bpeso\s*(?:de\s*)?(\d{1,2})(?:\s*\/\s*10)?\b/i);
  if (explicitWeight) return readWeight(explicitWeight[1]);

  const ratio = segment.match(/\b(\d{1,2})\s*\/\s*10\b/i);
  if (ratio) return readWeight(ratio[1]);

  const colon = segment.match(/[:=]\s*(\d{1,2})(?:\s*\/\s*10)?\s*$/i);
  if (colon) return readWeight(colon[1]);

  const verb = segment.match(/\b(?:es|vale|asigno|asignar|asignado|con)\s+(\d{1,2})(?:\s*\/\s*10)?\s*$/i);
  if (verb) return readWeight(verb[1]);

  const trailing = segment.match(/\s+(\d{1,2})\s*$/);
  if (trailing) return readWeight(trailing[1]);

  return undefined;
}

function splitCriterionSegments(message: string): string[] {
  let text = String(message ?? "").trim();
  if (!text) return [];

  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\)\s+y\s+/gi, ")|")
    .replace(/\b(\d{1,2}\s*\/\s*10)\s+y\s+/gi, "$1|");

  return text
    .split(/\n|;|\||,/g)
    .flatMap((part) => splitCriterionConjunction(part, message))
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitCriterionConjunction(part: string, message: string): string[] {
  if (!/\bcriterios?\b/i.test(message)) return [part];

  const explicitCapitalSplit = part.split(/\s+y\s+(?=[A-ZÁÉÍÓÚÑ])/g);
  if (explicitCapitalSplit.length > 1) return explicitCapitalSplit;

  const pieces = part.split(/\s+y\s+/i).map((item) => item.trim()).filter(Boolean);
  if (pieces.length !== 2) return [part];

  const right = cleanParetoCriterionName(pieces[1]);
  const rightWords = normalizeParetoKey(right).split(" ").filter(Boolean);

  if (rightWords.length >= 1 && rightWords.length <= 3 && containsAnyTerm(right, CRITERION_TERMS)) {
    return pieces;
  }

  return [part];
}

function stripCriterionPrefix(input: string): string {
  return input
    .replace(/^[-*•\s]+/, "")
    .replace(/^\d+\s*(?:er|ro|do|to)?\s*criterios?\s*[:.)-]?\s*/i, "")
    .replace(/^criterios?\s*\d*\s*[:.)-]?\s*/i, "")
    .replace(/^(?:los|mis|estos|estas|son|serian|serían)?\s*criterios?\s*(?:son|serian|serían)?\s*[:,]?\s*/i, "")
    .replace(/^(?:un|una)\s+criterio\s+(?:puede\s+ser|podria\s+ser|podría\s+ser|seria|sería|es)\s*[:,]?\s*/i, "")
    .replace(/^(?:el\s+)?(?:primer|segundo|tercer)\s+criterio\s+(?:seria|sería|podria\s+ser|podría\s+ser|puede\s+ser|es)\s*[:,]?\s*/i, "")
    .replace(/^(?:propongo|quiero\s+usar|usaria|usaría|definiria|definiría)\s*(?:como\s+criterio)?\s*[:,]?\s*/i, "")
    .trim();
}

export function cleanParetoCriterionName(input: string): string {
  let value = stripCriterionPrefix(String(input ?? "").trim());

  value = value
    .replace(/\s*\(\s*(?:peso\s*)?\d{1,2}(?:\s*\/\s*10)?\s*\)\s*/gi, " ")
    .replace(/\bpeso\s*(?:de\s*)?\d{1,2}(?:\s*\/\s*10)?\b/gi, " ")
    .replace(/\b\d{1,2}\s*\/\s*10\b/gi, " ")
    .replace(/\b(?:es|vale|asigno|asignar|asignado|con)\s+\d{1,2}\s*$/i, "")
    .replace(/[:=]\s*\d{1,2}\s*$/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  value = stripCriterionPrefix(value)
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return value;
}

function isUsefulCriterionName(name: string): boolean {
  const normalized = normalizeParetoKey(name);
  if (!normalized || CRITERION_BLOCKED_NAMES.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (CRITICAL_ROOT_SIGNALS.some((signal) => normalized.includes(signal))) return false;

  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;

  return name.length >= 3 && name.length <= 80;
}

export function isLikelyParetoCauseOrProblemList(message: string): boolean {
  if (hasExplicitCriterionSignal(message)) return false;
  if (isClearCriticalRootsMessage(message)) return true;
  if (hasExplicitCauseProblemSignal(message)) return true;

  const segments = splitCriterionSegments(message)
    .map((segment) => cleanParetoCriterionName(segment))
    .filter(Boolean);

  if (segments.length < 2) return false;

  let causeLike = 0;
  let criterionLike = 0;

  for (const segment of segments) {
    if (containsAnyTerm(segment, CAUSE_PROBLEM_TERMS)) causeLike += 1;
    if (containsAnyTerm(segment, CRITERION_TERMS)) criterionLike += 1;
  }

  return causeLike >= 2 && causeLike >= criterionLike;
}

export function parseParetoCriterionEntries(message: string): ParsedCriterionEntry[] {
  if (
    isClearCriticalRootsMessage(message) ||
    isWeightsOnlyMessage(message) ||
    hasExplicitCauseProblemSignal(message) ||
    isLikelyParetoCauseOrProblemList(message)
  ) {
    return [];
  }

  const entries: ParsedCriterionEntry[] = [];
  const seen = new Set<string>();

  for (const segment of splitCriterionSegments(message)) {
    const name = cleanParetoCriterionName(segment);
    if (!isUsefulCriterionName(name)) continue;

    const key = normalizeParetoKey(name);
    if (seen.has(key)) continue;

    const weight = extractWeightFromSegment(segment);
    seen.add(key);
    entries.push({
      name,
      ...(weight !== undefined ? { weight } : {}),
    });
  }

  return entries.slice(0, MAX_CRITERIA_MVP);
}

function cloneCriterion(criterion: ParetoCriterionLike): ParetoCriterionLike {
  return {
    id: criterion.id,
    name: criterion.name,
    ...(criterion.weight !== undefined ? { weight: criterion.weight } : {}),
  };
}

export function applyCriterionEntriesToCriteria(
  currentCriteria: ParetoCriterionLike[],
  entries: ParsedCriterionEntry[],
  options: MergeOptions = {}
): ParetoCriterionLike[] {
  const maxCriteria = Math.max(options.maxCriteria ?? MAX_CRITERIA_MVP, currentCriteria.length);
  const out = currentCriteria.map(cloneCriterion);
  const keys = new Map(out.map((criterion, index) => [normalizeParetoKey(criterion.name), index]));

  for (const entry of entries) {
    const key = normalizeParetoKey(entry.name);
    if (!key) continue;

    const existingIndex = keys.get(key);
    if (existingIndex !== undefined) {
      if (entry.weight !== undefined) {
        out[existingIndex] = { ...out[existingIndex], weight: entry.weight };
      }
      continue;
    }

    if (out.length >= maxCriteria) continue;

    const next: ParetoCriterionLike = {
      id: options.createId?.() ?? "",
      name: entry.name,
      ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
    };

    keys.set(key, out.length);
    out.push(next);
  }

  return out;
}

function criterionMatchScore(candidate: string, criterion: string): number {
  const a = normalizeParetoKey(candidate);
  const b = normalizeParetoKey(criterion);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const aTokens = new Set(a.split(" ").filter((token) => token.length >= 3));
  const bTokens = new Set(b.split(" ").filter((token) => token.length >= 3));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let common = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) common += 1;
  }

  return common / Math.max(aTokens.size, bTokens.size);
}

function findCriterionIndex(criteria: ParetoCriterionLike[], name: string): number {
  let bestIndex = -1;
  let bestScore = 0;

  criteria.forEach((criterion, index) => {
    const score = criterionMatchScore(name, criterion.name);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= 0.65 ? bestIndex : -1;
}

function extractWeightCorrections(message: string): ParsedCriterionEntry[] {
  const text = String(message ?? "");
  const patterns = [
    /\b(?:cambia|cambiar|corrige|corregir|ajusta|ajustar)\s+el\s+peso\s+de\s+(.+?)\s+a\s+(\d{1,2})(?:\s*\/\s*10)?\b/gi,
    /\bpeso\s+de\s+(.+?)\s+a\s+(\d{1,2})(?:\s*\/\s*10)?\b/gi,
  ];

  const out: ParsedCriterionEntry[] = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const weight = readWeight(match[2]);
      const name = cleanParetoCriterionName(match[1] ?? "");
      if (weight === undefined || !isUsefulCriterionName(name)) continue;
      out.push({ name, weight });
    }
  }

  return out;
}

function extractOrdinalWeights(message: string): number[] {
  const normalized = normalizeParetoKey(message);
  const positions = [
    /\b(?:al\s+)?(?:primero|primer)\D{0,20}?(\d{1,2})(?:\s*\/\s*10)?\b/,
    /\b(?:al\s+)?segundo\D{0,20}?(\d{1,2})(?:\s*\/\s*10)?\b/,
    /\b(?:al\s+)?tercero\D{0,20}?(\d{1,2})(?:\s*\/\s*10)?\b/,
  ];

  const weights = positions
    .map((pattern) => readWeight(normalized.match(pattern)?.[1]))
    .filter((value): value is number => value !== undefined);

  return weights.length > 0 ? weights : [];
}

function extractWeightsOnlyList(message: string): number[] {
  if (!isWeightsOnlyMessage(message)) return [];

  return Array.from(String(message).matchAll(/\b(\d{1,2})(?:\s*\/\s*10)?\b/g))
    .map((match) => readWeight(match[1]))
    .filter((value): value is number => value !== undefined);
}

export function applyWeightsToCriteria(
  currentCriteria: ParetoCriterionLike[],
  message: string
): ParetoCriterionLike[] {
  if (currentCriteria.length === 0) return currentCriteria;

  const out = currentCriteria.map(cloneCriterion);
  let updates = 0;

  const namedEntries = [
    ...parseParetoCriterionEntries(message),
    ...extractWeightCorrections(message),
  ].filter((entry) => entry.weight !== undefined);

  for (const entry of namedEntries) {
    const index = findCriterionIndex(out, entry.name);
    if (index < 0 || entry.weight === undefined) continue;

    out[index] = {
      ...out[index],
      weight: entry.weight,
    };
    updates += 1;
  }

  const ordinalWeights = extractOrdinalWeights(message);
  const listWeights =
    ordinalWeights.length > 0 ? ordinalWeights : extractWeightsOnlyList(message);

  if (listWeights.length === out.length) {
    listWeights.forEach((weight, index) => {
      out[index] = { ...out[index], weight };
      updates += 1;
    });
  }

  return updates > 0 ? out : currentCriteria;
}

function criterionCompletenessScore(criteria: ParetoCriterionLike[]): number {
  const validNames = criteria.filter((criterion) => normalizeParetoKey(criterion.name)).length;
  const weights = criteria.filter((criterion) => criterion.weight !== undefined).length;
  return validNames * 10 + weights;
}

export function mergeParetoCriteriaMonotonic(
  first: ParetoCriterionLike[],
  second: ParetoCriterionLike[],
  options: MergeOptions = {}
): ParetoCriterionLike[] {
  const maxCriteria = Math.max(
    options.maxCriteria ?? MAX_CRITERIA_MVP,
    first.length,
    second.length
  );

  const firstScore = criterionCompletenessScore(first);
  const secondScore = criterionCompletenessScore(second);

  const base = firstScore >= secondScore ? first : second;
  const additions = firstScore >= secondScore ? second : first;
  const entries = additions.map((criterion) => ({
    name: criterion.name,
    ...(criterion.weight !== undefined ? { weight: criterion.weight } : {}),
  }));

  const merged = applyCriterionEntriesToCriteria(base, entries, {
    maxCriteria,
    createId: options.createId,
  });

  return merged.map((criterion) => {
    const fallback = additions.find(
      (item) => normalizeParetoKey(item.name) === normalizeParetoKey(criterion.name)
    );

    return {
      ...criterion,
      id: criterion.id || fallback?.id || options.createId?.() || "",
    };
  });
}

export function mergeParetoStringListMonotonic(
  first: string[],
  second: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of [...first, ...second]) {
    const value = String(item ?? "").trim();
    const key = normalizeParetoKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function stripCriticalRootPrefix(input: string): string {
  return input
    .replace(/^[-*•\s]+/, "")
    .replace(/^\d+\s*[).:-]?\s*/, "")
    .replace(/^(?:las|mis)?\s*causas?\s+cr[ií]ticas?\s*(?:son|serian|serían)?\s*:?/i, "")
    .replace(/^los?\s+par[aá]metros?\s+cr[ií]ticos?\s*(?:son|serian|serían)?\s*:?/i, "")
    .replace(/^grupo\s+cr[ií]tico\s*(?:son|es)?\s*:?/i, "")
    .replace(/^top\s*20%?\s*:?/i, "")
    .replace(/^son\s+las\s+siguientes\s*:?/i, "")
    .replace(/^las\s+siguientes\s*:?/i, "")
    .trim();
}

function cleanCriticalRoot(input: string): string {
  return stripCriticalRootPrefix(input)
    .replace(/\s*\(\s*(?:puntaje|score|peso|porcentaje)?\s*\d+(?:[.,]\d+)?\s*%?\s*\)\s*$/i, "")
    .replace(/\s+(?:puntaje|score|porcentaje)\s*[:=]?\s*\d+(?:[.,]\d+)?\s*%?\s*$/i, "")
    .replace(/\s+\d+(?:[.,]\d+)?\s*%\s*$/i, "")
    .replace(/\s+-\s+\d+(?:[.,]\d+)?\s*%?.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
}

export function parseCriticalRootsFromParetoMessage(message: string): CriticalRootsParse {
  const text = String(message ?? "")
    .replace(/^ok[,:\s]*/i, "")
    .replace(/^bien[,:\s]*/i, "")
    .replace(/^listo[,:\s]*/i, "")
    .replace(/^ya[,:\s]*/i, "")
    .trim();

  const roots: string[] = [];
  const seen = new Set<string>();

  for (const part of text.split(/\n|;|,/g)) {
    const root = cleanCriticalRoot(part);
    const key = normalizeParetoKey(root);
    if (!key) continue;
    if (
      key === "son" ||
      key === "siguientes" ||
      key === "causas criticas" ||
      key === "mis causas criticas" ||
      key === "parametros criticos"
    ) {
      continue;
    }
    if (seen.has(key)) continue;

    seen.add(key);
    roots.push(root);
  }

  const isDelivery =
    isClearCriticalRootsMessage(message) ||
    roots.length >= 2 ||
    (roots.length === 1 && /[\n•*-]/.test(message));

  return {
    roots,
    isDelivery,
  };
}
