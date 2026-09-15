// src/lib/plan/ishikawaRootRegistry.ts

// Registro de causas raíz de Ishikawa (E4): identidad de cada raíz, en qué ramas apareció y
// qué pares declaró distintos el estudiante (state.rootCauses). Lógica pura, sin I/O ni red:
// la comparación con IA se inyecta (RootMatcher) y los ids también (newId). Es campo de
// autoridad del servidor: solo lo escribe ishikawa/assistant.
//
// Al cerrar una rama (después de que el gate la valida), su raíz se resuelve así:
// 1. Coincidencia normalizada exacta → misma raíz: suma la rama sin preguntar y se informa.
// 2. Si no, parecido determinista (rootTextSimilarity) contra el registro. Sin candidatas →
//    raíz nueva, sin IA.
// 3. Con candidatas (máx. 3, sin los pares ya declarados distintos) → una sola consulta a la
//    IA. Si falla o no propone una candidata válida → raíz nueva. Nunca bloquea el cierre.
// 4. Si la IA propone una → la raíz queda como nueva (provisoria) y se PREGUNTA al estudiante.
//    Sí → se une a la existente (el conteo no sube). No → quedan distintas y el par se anota
//    en distinctFrom de ambas para no volver a preguntar.
//
// Criterio de igualdad: normalizedText (minúsculas + espacios normalizados). Es igual o más
// fuerte que el de Pareto (pareto/state/route.ts: solo minúsculas): si dos textos coinciden
// en minúsculas, también coinciden normalizados. Por eso dos entradas del registro nunca se
// funden en E5: si E4 cierra con N raíces, E5 recibe N.

import { z } from "zod";

import { normalizeIntentText } from "./ishikawaWhyInterpreter";
import {
  cloneIshikawaState,
  parseBranchClosure,
  parsePendingRootMatch,
  parseRootRegistry,
  whyTexts,
  type IshikawaCategory,
  type IshikawaMainCause,
  type IshikawaState,
  type IshikawaSubCause,
  type RootCauseEntry,
  type RootOccurrence,
} from "./ishikawaTree";
import { parseJsonLoose, ROOT_SIMILARITY_JACCARD_THRESHOLD, rootTextSimilarity } from "./whyQuality";

export const MAX_ROOT_MATCH_CANDIDATES = 3;

export type RootPath = { categoryId: string; mainCauseId: string; subCauseId: string };

export function normalizeRootText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function samePath(a: RootPath, b: RootPath): boolean {
  return (
    a.categoryId === b.categoryId && a.mainCauseId === b.mainCauseId && a.subCauseId === b.subCauseId
  );
}

type BranchNodes = { cat: IshikawaCategory; mc: IshikawaMainCause; sc: IshikawaSubCause };

function locate(state: IshikawaState, path: RootPath): BranchNodes | null {
  const cat = (state.categories ?? []).find((c) => c?.id === path.categoryId);
  const mc = (cat?.mainCauses ?? []).find((m) => m?.id === path.mainCauseId);
  const sc = (mc?.subCauses ?? []).find((s) => s?.id === path.subCauseId);
  return cat && mc && sc ? { cat, mc, sc } : null;
}

// Raíz de una rama: su último porqué o, sin porqués, el texto de la subcausa.
export function branchRootText(sc: IshikawaSubCause): string {
  const whys = whyTexts(sc.whys);
  if (whys.length > 0) return whys[whys.length - 1];
  return (sc.text ?? "").trim() || (sc.name ?? "").trim();
}

// "Categoría → Causa principal → Subcausa" de una rama, para citarla al estudiante.
export function describeRootOccurrence(state: IshikawaState, path: RootPath): string {
  const nodes = locate(state, path);
  if (!nodes) return "otra rama";

  const main = nodes.mc.name ?? nodes.mc.text ?? "Sin causa principal";
  const sub = nodes.sc.name ?? nodes.sc.text ?? "Sin subcausa";
  return `${nodes.cat.name ?? "Sin categoría"} → ${main} → ${sub}`;
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// Coherencia del registro
// ---------------------------------------------------------------------------

// Una rama reabierta suelta su causa raíz; si la raíz se queda sin ramas, sale del registro
// (y de los distinctFrom). Modifica solo state.rootCauses y state.pendingRootMatch.
export function releaseRootOccurrenceInPlace(state: IshikawaState, path: RootPath): void {
  const removedIds = new Set<string>();
  const kept: RootCauseEntry[] = [];

  for (const entry of parseRootRegistry(state.rootCauses)) {
    const occurrences = entry.occurrences.filter((occurrence) => !samePath(occurrence, path));
    if (occurrences.length === 0) removedIds.add(entry.id);
    else kept.push({ ...entry, occurrences });
  }

  state.rootCauses = kept.map((entry) => ({
    ...entry,
    distinctFrom: entry.distinctFrom.filter((id) => !removedIds.has(id)),
  }));

  const pending = parsePendingRootMatch(state.pendingRootMatch);
  const pendingBroken =
    pending !== null &&
    (samePath(pending, path) || removedIds.has(pending.rootId) || removedIds.has(pending.candidateId));
  state.pendingRootMatch = pending && !pendingBroken ? pending : null;
}

export function releaseRootOccurrence(state: IshikawaState, path: RootPath): IshikawaState {
  const nextState = cloneIshikawaState(state);
  releaseRootOccurrenceInPlace(nextState, path);
  return nextState;
}

// Deja el registro coherente con el árbol: una rama cuenta para una raíz solo si existe,
// está revisada y su closure.rootId apunta a esa entrada. Las entradas sin ramas salen, y la
// pregunta pendiente se descarta si ya no apunta a algo válido.
export function reconcileRootRegistry(state: IshikawaState): IshikawaState {
  const nextState = cloneIshikawaState(state);
  const kept: RootCauseEntry[] = [];

  for (const entry of parseRootRegistry(nextState.rootCauses)) {
    const occurrences = entry.occurrences.filter((occurrence) => {
      const closure = parseBranchClosure(locate(nextState, occurrence)?.sc.closure);
      return closure?.reviewed === true && closure.rootId === entry.id;
    });

    if (occurrences.length > 0) kept.push({ ...entry, occurrences });
  }

  const existing = new Set(kept.map((entry) => entry.id));
  nextState.rootCauses = kept.map((entry) => ({
    ...entry,
    distinctFrom: entry.distinctFrom.filter((id) => existing.has(id)),
  }));

  const pending = parsePendingRootMatch(nextState.pendingRootMatch);
  const pendingValid =
    pending !== null &&
    locate(nextState, pending) !== null &&
    existing.has(pending.rootId) &&
    existing.has(pending.candidateId);
  nextState.pendingRootMatch = pendingValid ? pending : null;

  return nextState;
}

// ---------------------------------------------------------------------------
// Resolución de la raíz de una rama cerrada
// ---------------------------------------------------------------------------

export type RootCandidate = { entry: RootCauseEntry; similarity: number };

// Pasos 2 y 5: raíces del registro parecidas a `text`, sin `entryId` ni las que el
// estudiante ya declaró distintas de ella; de más a menos parecidas.
export function findRootCandidates(
  registry: readonly RootCauseEntry[],
  text: string,
  entryId: string
): RootCandidate[] {
  const self = registry.find((entry) => entry.id === entryId);
  const declaredDistinct = new Set(self?.distinctFrom ?? []);

  return registry
    .filter(
      (entry) =>
        entry.id !== entryId &&
        !declaredDistinct.has(entry.id) &&
        !entry.distinctFrom.includes(entryId)
    )
    .map((entry) => ({ entry, similarity: rootTextSimilarity(text, entry.canonicalText) }))
    .filter((candidate) => candidate.similarity >= ROOT_SIMILARITY_JACCARD_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_ROOT_MATCH_CANDIDATES);
}

export type RootMatchCandidateInput = { id: string; text: string };
export type RootMatchVerdict = { sameAs: string | null; reason: string };

// Comparación de una raíz nueva contra candidatas (IA). null = la consulta falló.
export type RootMatcher = (input: {
  newRoot: string;
  candidates: RootMatchCandidateInput[];
}) => Promise<RootMatchVerdict | null>;

export type RootResolution =
  | { kind: "unchanged"; nextState: IshikawaState }
  | { kind: "new"; nextState: IshikawaState; entryId: string }
  | {
      kind: "repeated";
      nextState: IshikawaState;
      entryId: string;
      occurrences: number;
      previous: RootOccurrence[];
    }
  | {
      kind: "question";
      nextState: IshikawaState;
      entryId: string;
      candidate: RootCauseEntry;
      reason: string;
    };

// Resuelve la raíz de una rama recién cerrada (closure revisado) contra el registro y
// escribe closure.rootId. Consulta a la IA a lo sumo una vez y solo con candidatas.
export async function resolveBranchRoot(
  input: { state: IshikawaState; path: RootPath; now: string; newId: () => string },
  matcher: RootMatcher
): Promise<RootResolution> {
  const nextState = cloneIshikawaState(input.state);
  const nodes = locate(nextState, input.path);
  const closure = parseBranchClosure(nodes?.sc.closure);
  if (!nodes || !closure?.reviewed) return { kind: "unchanged", nextState };

  const text = branchRootText(nodes.sc);
  const normalizedText = normalizeRootText(text);
  if (!normalizedText) return { kind: "unchanged", nextState };

  // La rama ya estaba registrada con el mismo texto (se volvió a confirmar el cierre).
  const current = parseRootRegistry(nextState.rootCauses).find((entry) =>
    entry.occurrences.some((occurrence) => samePath(occurrence, input.path))
  );
  if (current && current.normalizedText === normalizedText) {
    nodes.sc.closure = { ...closure, rootId: current.id };
    return { kind: "unchanged", nextState };
  }

  // Si la rama apuntaba a otra raíz, primero la suelta.
  releaseRootOccurrenceInPlace(nextState, input.path);

  const registry = parseRootRegistry(nextState.rootCauses);
  const occurrence: RootOccurrence = { ...input.path, text };

  // 1) Misma raíz: se suma la rama, sin preguntar.
  const exact = registry.find((entry) => entry.normalizedText === normalizedText);
  if (exact) {
    const previous = exact.occurrences;
    exact.occurrences = [...previous, occurrence];
    nextState.rootCauses = registry;
    nodes.sc.closure = { ...closure, rootId: exact.id };

    return {
      kind: "repeated",
      nextState,
      entryId: exact.id,
      occurrences: exact.occurrences.length,
      previous,
    };
  }

  // Raíz nueva; queda provisoria si hay que preguntar.
  const entry: RootCauseEntry = {
    id: input.newId(),
    canonicalText: text,
    normalizedText,
    occurrences: [occurrence],
    distinctFrom: [],
  };
  registry.push(entry);
  nextState.rootCauses = registry;
  nodes.sc.closure = { ...closure, rootId: entry.id };

  // 2) Parecido determinista. Sin candidatas, sin IA.
  const candidates = findRootCandidates(registry, text, entry.id);
  if (candidates.length === 0) return { kind: "new", nextState, entryId: entry.id };

  // 3) Una sola consulta; su fallo nunca bloquea el cierre.
  let verdict: RootMatchVerdict | null = null;
  try {
    verdict = await matcher({
      newRoot: text,
      candidates: candidates.map(({ entry: candidate }) => ({
        id: candidate.id,
        text: candidate.canonicalText,
      })),
    });
  } catch {
    verdict = null;
  }

  const proposed = candidates.find(({ entry: candidate }) => candidate.id === verdict?.sameAs)?.entry;
  if (!verdict || !proposed) return { kind: "new", nextState, entryId: entry.id };

  // 4) La IA propone una coincidencia: se pregunta al estudiante; no se fusiona.
  nextState.pendingRootMatch = {
    ...input.path,
    rootId: entry.id,
    candidateId: proposed.id,
    reason: verdict.reason,
    askedAt: input.now,
  };

  return { kind: "question", nextState, entryId: entry.id, candidate: proposed, reason: verdict.reason };
}

// ---------------------------------------------------------------------------
// Respuesta del estudiante a la pregunta pendiente
// ---------------------------------------------------------------------------

export type PendingRootAnswer =
  | { kind: "no_pending"; nextState: IshikawaState }
  | { kind: "merged"; nextState: IshikawaState; entry: RootCauseEntry }
  | { kind: "kept_distinct"; nextState: IshikawaState; entry: RootCauseEntry; other: RootCauseEntry };

export function answerPendingRootMatch(state: IshikawaState, answer: "yes" | "no"): PendingRootAnswer {
  const nextState = cloneIshikawaState(state);
  const pending = parsePendingRootMatch(nextState.pendingRootMatch);
  const registry = parseRootRegistry(nextState.rootCauses);
  const provisional = registry.find((entry) => entry.id === pending?.rootId);
  const candidate = registry.find((entry) => entry.id === pending?.candidateId);

  nextState.pendingRootMatch = null;
  nextState.rootCauses = registry;
  if (!pending || !provisional || !candidate) return { kind: "no_pending", nextState };

  if (answer === "yes") {
    // Misma raíz: las ramas de la provisoria pasan a la existente; el conteo no sube.
    for (const occurrence of provisional.occurrences) {
      if (!candidate.occurrences.some((known) => samePath(known, occurrence))) {
        candidate.occurrences.push(occurrence);
      }

      const nodes = locate(nextState, occurrence);
      const closure = parseBranchClosure(nodes?.sc.closure);
      if (nodes && closure) nodes.sc.closure = { ...closure, rootId: candidate.id };
    }

    nextState.rootCauses = registry
      .filter((entry) => entry.id !== provisional.id)
      .map((entry) => ({
        ...entry,
        distinctFrom: entry.distinctFrom.filter((id) => id !== provisional.id),
      }));

    return { kind: "merged", nextState, entry: candidate };
  }

  // Distintas: el par se recuerda para no volver a preguntar.
  provisional.distinctFrom = uniqueIds([...provisional.distinctFrom, candidate.id]);
  candidate.distinctFrom = uniqueIds([...candidate.distinctFrom, provisional.id]);
  return { kind: "kept_distinct", nextState, entry: provisional, other: candidate };
}

export type YesNoAnswer = "yes" | "no" | "unclear";

const UNSURE_MARKERS = [
  "no se",
  "no estoy seguro",
  "no estoy segura",
  "no sabria",
  "tal vez",
  "quizas",
  "puede ser",
  "depende",
];

const NO_PHRASES = [
  "no es la misma",
  "no son la misma",
  "no son iguales",
  "no es igual",
  "son distintas",
  "son diferentes",
  "es distinta",
  "es diferente",
  "es otra",
];

const YES_PHRASES = ["es la misma", "son la misma", "son iguales", "es igual", "misma causa"];

// Respuesta a "¿es la misma causa raíz?". Determinista; ante la duda, "unclear" (se vuelve a
// preguntar) en lugar de suponer.
export function interpretYesNo(text: string): YesNoAnswer {
  const normalized = normalizeIntentText(text);
  if (!normalized) return "unclear";

  const padded = ` ${normalized} `;
  const has = (phrase: string) => padded.includes(` ${phrase} `);

  if (UNSURE_MARKERS.some(has)) return "unclear";
  if (/^(no|nop|negativo)( |$)/.test(normalized) || NO_PHRASES.some(has)) return "no";

  const hasNegation = has("no");
  const startsYes = /^(si|sip|claro|correcto|exacto|afirmativo|asi es|de acuerdo|ok|okay|dale)( |$)/.test(
    normalized
  );
  if (!hasNegation && (startsYes || YES_PHRASES.some(has))) return "yes";

  return "unclear";
}

const RootMatchResponseSchema = z.object({
  sameAs: z.string().nullable(),
  reason: z.string(),
});

// Valida la respuesta de la IA. JSON inválido, otra forma o un id que no es candidato →
// null, que el llamador trata como "raíz nueva". Nunca lanza excepciones.
export function interpretRootMatchResponse(
  raw: unknown,
  candidateIds: readonly string[]
): RootMatchVerdict | null {
  const candidate = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const parsed = RootMatchResponseSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const { sameAs } = parsed.data;
  if (sameAs !== null && !candidateIds.includes(sameAs)) return null;

  return { sameAs, reason: parsed.data.reason.replace(/\s+/g, " ").trim().slice(0, 500) };
}
