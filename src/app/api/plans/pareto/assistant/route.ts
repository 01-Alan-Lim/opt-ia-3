// src/app/api/plans/pareto/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import {
  classifyConversationIntent,
  type ConversationIntentResult,
} from "@/lib/plan/conversationIntent";
import {
  applyCriterionEntriesToCriteria,
  applyWeightsToCriteria,
  isClearCriticalRootsMessage,
  isLikelyParetoCauseOrProblemList,
  mergeParetoCriteriaMonotonic,
  mergeParetoStringListMonotonic,
  parseCriticalRootsFromParetoMessage,
  parseParetoCriterionEntries,
} from "@/lib/plan/paretoParsing";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";


export const runtime = "nodejs";

const STAGE = 5;
const LEGACY_ARTIFACT_TYPE = "pareto_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

const PARETO_STEP_VALUES = [
  "select_roots",
  "define_criteria",
  "set_weights",
  "excel_work",
  "collect_critical",
  "done",
] as const;

type ParetoStep = (typeof PARETO_STEP_VALUES)[number];

type ParetoAssistantAction =
  | "init"
  | "select_roots"
  | "define_criteria"
  | "set_weights"
  | "instruct_excel"
  | "collect_critical"
  | "ask_clarify"
  | "redirect"
  | "done";

const CriterionSchema = z.object({
  id: z.string(),
  name: z.string().trim(),
  weight: z.number().optional(),
});

const ParetoStateSchema = z.object({
  roots: z.array(z.string()),
  selectedRoots: z.array(z.string()),
  criteria: z.array(CriterionSchema),
  criticalRoots: z.array(z.string()),
  minSelected: z.number(),
  maxSelected: z.number(),
  step: z.enum(PARETO_STEP_VALUES),
});

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  studentMessage: z.string().trim().min(1).max(4000),
  paretoState: z.unknown(),
  caseContext: z.record(z.string(), z.unknown()).nullable().optional(),
  recentHistory: z.string().max(12000).optional(),
});

type ParetoState = z.infer<typeof ParetoStateSchema>;

function extractJsonSafe(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeText(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[-*•\d.)\s]+/g, "")
    .replace(/[.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ceil20Percent(n: number) {
  return Math.max(1, Math.ceil(n * 0.2));
}

type ParetoIntent =
  | "ASK_SHOW_ROOTS"
  | "ASK_SHOW_CRITERIA_WEIGHTS"
  | "ASK_METHOD"
  | "DELIVER_CRITICAL_ROOTS"
  | "ANALYTICAL_QUESTION"
  | "CONFIRM"
  | "OTHER";

async function classifyStudentIntent(message: string): Promise<ParetoIntent> {
  const text = message.trim();
  if (!text) return "OTHER";

  const normalized = normalizeText(text);

  if (
    isOkConfirm(text) ||
    normalized.includes("son esas") ||
    normalized.includes("esas son") ||
    normalized.includes("correcto son esas") ||
    normalized.includes("si son esas") ||
    normalized.includes("sí son esas") ||
    normalized.includes("pasamos a la otra etapa") ||
    normalized.includes("pasamos a otra etapa") ||
    normalized.includes("pasamos de etapa") ||
    normalized.includes("continuemos")
  ) {
    return "CONFIRM";
  }

  try {
    const model = getGeminiModel();

    const prompt = `
Clasifica la intención del siguiente mensaje de un estudiante dentro de la etapa Pareto de una asesoría académica.

Devuelve SOLO una de estas etiquetas exactas:

ASK_SHOW_ROOTS
ASK_SHOW_CRITERIA_WEIGHTS
ASK_METHOD
DELIVER_CRITICAL_ROOTS
ANALYTICAL_QUESTION
CONFIRM
OTHER

Reglas:
- ASK_SHOW_ROOTS: pide que le recuerden, muestren o digan sus causas raíz actuales.
- ASK_SHOW_CRITERIA_WEIGHTS: pide que le recuerden, muestren o expliquen sus criterios o sus pesos actuales.
- ASK_METHOD: pregunta cómo hacer Pareto o qué debe hacer en esta etapa.
- DELIVER_CRITICAL_ROOTS: está entregando o pegando causas críticas resultantes de su análisis.
- ANALYTICAL_QUESTION: hace una pregunta analítica sobre sus causas, cuál impacta más, cómo justificar, etc.
- CONFIRM: solo confirma brevemente, por ejemplo "ok", "sí", "listo", "continuemos", "sí, son esas", "correcto, esas son", "ok, pasamos".
- OTHER: ambiguo o no clasifica claramente.

Mensaje:
"""${text}"""
`;

    const res = await model.generateContent(prompt);
    const raw = res.response.text().trim().toUpperCase();

    const allowed: ParetoIntent[] = [
      "ASK_SHOW_ROOTS",
      "ASK_SHOW_CRITERIA_WEIGHTS",
      "ASK_METHOD",
      "DELIVER_CRITICAL_ROOTS",
      "ANALYTICAL_QUESTION",
      "CONFIRM",
      "OTHER",
    ];

    const exact = allowed.find((item) => raw === item);
    if (exact) return exact;

    const contained = allowed.find((item) => raw.includes(item));
    if (contained) return contained;

    return "OTHER";
  } catch {
    return "OTHER";
  }
}


function isOkConfirm(msg: string) {
  const t = normalizeText(msg);
  return ["ok", "okay", "dale", "listo", "de acuerdo", "si", "sí"].includes(t);
}

function isParetoCloseConfirmation(msg: string) {
  const t = normalizeText(msg);
  return (
    isOkConfirm(msg) ||
    t.includes("siguiente etapa") ||
    t.includes("pasar a la siguiente") ||
    t.includes("pasemos a la siguiente") ||
    t.includes("cerrar pareto") ||
    t.includes("continuar con objetivos")
  );
}

function isAskingForCriticalRoots(msg: string) {
  const t = normalizeText(msg);

  return (
    t.includes("cuales son mis causas") ||
    t.includes("cuales son las causas") ||
    t.includes("cuales serian mis causas") ||
    t.includes("me dices cuales son") ||
    t.includes("dime cuales son mis causas") ||
    t.includes("dime cuales son las causas") ||
    t.includes("dime mis causas") ||
    t.includes("dime mis causas raices") ||
    t.includes("dime mis causas raiz") ||
    t.includes("dime las causas") ||
    t.includes("cuales son mis causas raices") ||
    t.includes("cuales son mis causas criticas") ||
    t.includes("que causas salieron") ||
    t.includes("que causas criticas salieron") ||
    t.includes("recuerdame las causas") ||
    t.includes("muestrame las causas") ||
    t.includes("muestrame mis causas") ||
    t.includes("dame mis causas") ||
    t.includes("dame mis causas raices") ||
    t.includes("dame mis causas raíces") ||
    t.includes("dame las causas") ||
    t.includes("cuales tenemos") ||
    t.includes("que causas tenemos") ||
    t.includes("cuáles tenemos") ||
    t.includes("mostrar mis causas") ||
    t.includes("mostrar causas") ||
    t.includes("lista de causas") ||
    t.includes("mis causas raiz") ||
    t.includes("mis causas raíz") ||
    t.includes("causas actuales") ||
    t.includes("causas que tenemos") ||
    t.includes("causas que tengo")
  );
}

function isAskingHowToDoPareto(msg: string) {
  const t = normalizeText(msg);

  return (
    t.includes("como priorizo") ||
    t.includes("como hago el pareto") ||
    t.includes("como hacerlo") ||
    t.includes("como se hace") ||
    t.includes("que hago ahora") ||
    t.includes("que sigue") ||
    t.includes("como identifico") ||
    t.includes("que son las causas criticas") ||
    t.includes("como saco el top 20") ||
    t.includes("como elijo las causas criticas") ||
    t.includes("ayudame con pareto")
  );
}

function isAskingForCriteriaWeights(msg: string) {
  const t = normalizeText(msg);

  return (
    t.includes("cuales son mis criterios") ||
    t.includes("cuáles son mis criterios") ||
    t.includes("cuales son los criterios") ||
    t.includes("cuáles son los criterios") ||
    t.includes("cuales son mis pesos") ||
    t.includes("cuáles son mis pesos") ||
    t.includes("cuales son los pesos") ||
    t.includes("cuáles son los pesos") ||
    t.includes("cuales tengo de criterio") ||
    t.includes("que criterios tengo") ||
    t.includes("qué criterios tengo") ||
    t.includes("que pesos tengo") ||
    t.includes("qué pesos tengo") ||
    t.includes("recuerdame mis criterios") ||
    t.includes("recuérdame mis criterios") ||
    t.includes("recuerdame mis pesos") ||
    t.includes("recuérdame mis pesos") ||
    t.includes("muestrame mis criterios") ||
    t.includes("muéstrame mis criterios") ||
    t.includes("muestrame mis pesos") ||
    t.includes("muéstrame mis pesos") ||
    t.includes("criterios y pesos") ||
    t.includes("criterio y peso")
  );
}

function hasThreeCriteria(state: ParetoState) {
  return (
    Array.isArray(state.criteria) &&
    state.criteria.length >= 3 &&
    state.criteria.every((c) => c.name.trim().length > 3)
  );
}

function hasWeights(state: ParetoState) {
  if (!Array.isArray(state.criteria) || state.criteria.length !== 3) return false;

  return state.criteria.every((c) => {
    const w = Number(c.weight);
    return Number.isFinite(w) && w >= 1 && w <= 10;
  });
}

function resolveParetoStepFromState(state: ParetoState): ParetoStep {
  const selectedCount = Array.isArray(state.selectedRoots) ? state.selectedRoots.length : 0;
  const minSelected =
    Number.isFinite(state.minSelected) && state.minSelected > 0 ? state.minSelected : 10;
  const maxSelected =
    Number.isFinite(state.maxSelected) && state.maxSelected >= minSelected
      ? state.maxSelected
      : 15;

  if (selectedCount < minSelected || selectedCount > maxSelected) {
    return "select_roots";
  }

  if (!hasThreeCriteria(state)) {
    return "define_criteria";
  }

  if (!hasWeights(state)) {
    return "set_weights";
  }

  const criticalCount = Array.isArray(state.criticalRoots) ? state.criticalRoots.length : 0;
  if (criticalCount > 0) {
    return state.step === "done" ? "done" : "collect_critical";
  }

  if (state.step === "collect_critical" || state.step === "done") {
    return "excel_work";
  }

  return state.step === "excel_work" ? "excel_work" : "set_weights";
}

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function normalizeWeight(input: unknown): number | undefined {
  const n = Number(input);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1 || n > 10) return undefined;
  return n;
}

const LEGACY_AUTO_CRITERIA_KEYS = [
  "impacto",
  "frecuencia",
  "controlabilidad",
] as const;

function isLegacyAutoCriteria(
  criteria: Array<{ id: string; name: string; weight?: number }>
) {
  if (criteria.length !== 3) return false;

  const names = criteria.map((item) => normalizeText(item.name)).sort();
  const expected = [...LEGACY_AUTO_CRITERIA_KEYS].sort();

  const sameNames = names.every((value, index) => value === expected[index]);

  const hasAnyWeight = criteria.some((item) => {
    const weight = Number(item.weight);
    return Number.isFinite(weight) && weight >= 1 && weight <= 10;
  });

  return sameNames && !hasAnyWeight;
}

function normalizeCriteria(input: unknown) {
  const raw = Array.isArray(input) ? input : [];

  const criteria = raw
    .map((item) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};

      const name = String(record.name ?? "").trim();
      const id = String(record.id ?? "").trim() || crypto.randomUUID();
      const weight = normalizeWeight(record.weight);

      if (!name) return null;

      return {
        id,
        name,
        ...(weight !== undefined ? { weight } : {}),
      };
    })
    .filter((item): item is { id: string; name: string; weight?: number } => Boolean(item))
    .slice(0, 3);

  return isLegacyAutoCriteria(criteria) ? [] : criteria;
}

function normalizeStep(input: unknown): ParetoStep {
  const raw = String(input ?? "").trim();

  if ((PARETO_STEP_VALUES as readonly string[]).includes(raw)) {
    return raw as ParetoStep;
  }

  const legacyMap: Record<string, ParetoStep> = {
    init: "select_roots",
    start: "select_roots",
    roots: "select_roots",
    select: "select_roots",
    criteria: "define_criteria",
    define: "define_criteria",
    weights: "set_weights",
    weight: "set_weights",
    excel: "excel_work",
    critical: "collect_critical",
    critical_roots: "collect_critical",
    review: "collect_critical",
    finished: "done",
    final: "done",
  };

  return legacyMap[raw] ?? "select_roots";
}

function normalizePositiveInt(input: unknown, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : fallback;
}

function normalizeParetoState(input: unknown): ParetoState {
  const source =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const roots = dedupeStrings(asStringArray(source.roots));
  const minSelected = normalizePositiveInt(source.minSelected, 10);
  const maxSelectedRaw = normalizePositiveInt(source.maxSelected, 15);
  const maxSelected = Math.max(minSelected, maxSelectedRaw);

  const selectedRootsRaw = asStringArray(source.selectedRoots);
  const selectedRootsBase =
    selectedRootsRaw.length > 0 ? selectedRootsRaw : roots.slice(0, maxSelected);

  const rootsSet = new Set(roots.map((item) => normalizeText(item)));
  const selectedRoots = dedupeStrings(
    selectedRootsBase.filter((item) => rootsSet.size === 0 || rootsSet.has(normalizeText(item)))
  ).slice(0, maxSelected);

  const selectedSet = new Set(selectedRoots.map((item) => normalizeText(item)));
  const criticalRoots = dedupeStrings(asStringArray(source.criticalRoots)).filter((item) =>
    selectedSet.size === 0 ? true : selectedSet.has(normalizeText(item))
  );

  return {
    roots,
    selectedRoots,
    criteria: normalizeCriteria(source.criteria),
    criticalRoots,
    minSelected,
    maxSelected,
    step: normalizeStep(source.step),
  };
}

const ROOT_MATCH_STOPWORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "en",
  "por",
  "para",
  "con",
  "sin",
  "un",
  "una",
  "unos",
  "unas",
  "que",
  "se",
  "al",
  "y",
  "e",
  "existe",
  "existen",
  "hay",
]);

async function loadOfficialIshikawaRoots(
  userId: string,
  preferredChatId: string | null
) {
  const result = await loadLatestValidatedArtifact({
    userId,
    preferredChatId,
    stage: 4,
    artifactType: "ishikawa_final",
    periodKey: PERIOD_KEY,
  });

  if (!result.ok) {
    throw new Error("No se pudo leer Ishikawa final para sanear Pareto.");
  }

  const rawRoots = Array.isArray(result.row?.payload?.roots)
    ? result.row?.payload?.roots
    : [];

  return dedupeStrings(
    rawRoots.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
  );
}

function sanitizeParetoStateWithOfficialRoots(
  state: ParetoState,
  officialRoots: string[]
): ParetoState {
  if (officialRoots.length === 0) return state;

  const officialSet = new Set(officialRoots.map((item) => normalizeText(item)));

  const selectedRoots = dedupeStrings(
    state.selectedRoots.filter((item) => officialSet.has(normalizeText(item)))
  ).slice(0, state.maxSelected);

  const selectedSet = new Set(selectedRoots.map((item) => normalizeText(item)));

  const criticalRoots = dedupeStrings(
    state.criticalRoots.filter((item) => selectedSet.has(normalizeText(item)))
  );

  return {
    ...state,
    roots: officialRoots,
    selectedRoots,
    criticalRoots,
    step: resolveParetoStepFromState({
      ...state,
      roots: officialRoots,
      selectedRoots,
      criticalRoots,
    }),
  };
}


function tokenizeRootForMatch(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ROOT_MATCH_STOPWORDS.has(token));
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let common = 0;
  for (const token of setA) {
    if (setB.has(token)) common += 1;
  }

  return common / Math.max(setA.size, setB.size, 1);
}

function parseCriticalRootsFromMessage(studentMessage: string): string[] {
  return parseCriticalRootsFromParetoMessage(studentMessage).roots;

  const cleanedMessage = String(studentMessage ?? "")
    .replace(/^ok[,:\s]*/i, "")
    .replace(/^bien[,:\s]*/i, "")
    .replace(/^listo[,:\s]*/i, "")
    .replace(/^ya[,:\s]*/i, "")
    .trim();

  const baseParts = cleanedMessage
    .split(/\n|;/g)
    .flatMap((line) => line.split(","))
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/^las\s+causas?\s+cr[ií]ticas?\s+son\s*:?/i, "")
        .replace(/^mis\s+causas?\s+cr[ií]ticas?\s+son\s*:?/i, "")
        .replace(/^causas?\s+cr[ií]ticas?\s*:?/i, "")
        .replace(/^top\s*20%?\s*:?/i, "")
        .replace(/^ok[,:\s]*/i, "")
        .replace(/^son\s+las\s+siguientes\s*:?/i, "")
        .replace(/^te\s+dije\s+que\s+las\s+causas?\s+cr[ií]ticas?\s+son\s*:?/i, "")
        .replace(/^las\s+siguientes\s*:?/i, "")
        .trim()
    )
    .filter(Boolean)
    .filter((line) => {
      const normalized = normalizeText(line);
      if (!normalized) return false;

      if (
        normalized === "son" ||
        normalized === "siguientes" ||
        normalized === "causas criticas" ||
        normalized === "mis causas criticas"
      ) {
        return false;
      }

      return true;
    });

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const item of baseParts) {
    const normalized = normalizeText(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(item.trim());
  }

  return unique;
}

function looksLikeCriticalRootsDelivery(studentMessage: string, parsedCritical: string[]): boolean {
  const parsed = parseCriticalRootsFromParetoMessage(studentMessage);
  return parsed.isDelivery && parsedCritical.length > 0;

  const text = String(studentMessage ?? "");
  const normalized = normalizeText(text);

  if (parsedCritical.length >= 2) return true;

  if (parsedCritical.length === 1) {
    return (
      normalized.includes("causas criticas") ||
      normalized.includes("causas críticas") ||
      normalized.includes("top 20") ||
      normalized.includes("top20") ||
      text.includes("\n-") ||
      text.includes("\n•")
    );
  }

  return false;
}

function matchAgainstSelectedRoots(
  candidates: string[],
  selectedRoots: string[]
): { matched: string[]; invalid: string[] } {
  const normalizedOfficial = selectedRoots.map((root) => ({
    original: root,
    normalized: normalizeText(root),
    tokens: tokenizeRootForMatch(root),
  }));

  const matched: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const item of candidates) {
    const candidateKey = normalizeText(item);
    const candidateTokens = tokenizeRootForMatch(item);

    let best:
      | {
          original: string;
          normalized: string;
          tokens: string[];
          score: number;
        }
      | null = null;

    for (const root of normalizedOfficial) {
      let score = 0;

      if (root.normalized === candidateKey) {
        score = 1;
      } else if (
        root.normalized.includes(candidateKey) ||
        candidateKey.includes(root.normalized)
      ) {
        score = 0.95;
      } else {
        score = overlapScore(candidateTokens, root.tokens);
      }

      if (!best || score > best.score) {
        best = { ...root, score };
      }
    }

    if (!best || best.score < 0.6) {
      invalid.push(item);
      continue;
    }

    if (seen.has(best.normalized)) continue;
    seen.add(best.normalized);
    matched.push(best.original);
  }

  return { matched, invalid };
}

function actionFromParetoStep(step: ParetoStep): ParetoAssistantAction {
  switch (step) {
    case "select_roots":
      return "select_roots";
    case "define_criteria":
      return "define_criteria";
    case "set_weights":
      return "set_weights";
    case "excel_work":
      return "instruct_excel";
    case "collect_critical":
      return "collect_critical";
    case "done":
      return "done";
    default:
      return "ask_clarify";
  }
}

function assistantResponse(
  assistantMessage: string,
  nextState: ParetoState,
  action: ParetoAssistantAction
) {
  return NextResponse.json({
    ok: true,
    data: {
      assistantMessage,
      updates: { nextState, action },
    },
  });
}

async function assertChatOwner(userId: string, chatId: string) {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (chatErr || !chatRow) {
    return { ok: false as const, status: 404, message: "Chat no encontrado." };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false as const, status: 403, message: "No tienes acceso a este chat." };
  }

  return { ok: true as const };
}

async function loadPersistedParetoState(userId: string, chatId: string | null) {
  if (!chatId) return null;

  const direct = await supabaseServer
    .from("plan_stage_states")
    .select("state_json")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", STAGE)
    .maybeSingle();

  if (direct.error) {
    throw new Error("No se pudo leer el estado guardado de Pareto.");
  }

  if (direct.data?.state_json) {
    return normalizeParetoState(direct.data.state_json);
  }

  const legacy = await supabaseServer
    .from("plan_stage_artifacts")
    .select("payload")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", STAGE)
    .eq("artifact_type", LEGACY_ARTIFACT_TYPE)
    .eq("period_key", PERIOD_KEY)
    .maybeSingle();

  if (legacy.error) {
    throw new Error("No se pudo leer el estado legacy de Pareto.");
  }

  if (legacy.data?.payload) {
    return normalizeParetoState(legacy.data.payload);
  }

  return null;
}

function mergeAssistantParetoState(
  persisted: ParetoState | null,
  incoming: ParetoState
): ParetoState {
  if (!persisted) return incoming;

  const criteria = mergeParetoCriteriaMonotonic(persisted.criteria, incoming.criteria, {
    createId: () => crypto.randomUUID(),
  });

  const roots = mergeParetoStringListMonotonic(persisted.roots, incoming.roots);
  const selectedRoots = mergeParetoStringListMonotonic(
    persisted.selectedRoots,
    incoming.selectedRoots
  );
  const criticalRoots = mergeParetoStringListMonotonic(
    persisted.criticalRoots,
    incoming.criticalRoots
  );

  const merged = normalizeParetoState({
    roots,
    selectedRoots,
    criteria,
    criticalRoots,
    minSelected: persisted.minSelected ?? incoming.minSelected,
    maxSelected: persisted.maxSelected ?? incoming.maxSelected,
    step:
      persisted.step && persisted.step !== "select_roots"
        ? persisted.step
        : incoming.step,
  });

  return merged;
}

function buildCurrentRootsListMessage(state: ParetoState) {
  const list = state.selectedRoots.length
    ? state.selectedRoots
    : state.roots;

  if (list.length === 0) {
    return (
      "Todavía no tengo una lista recuperable de causas raíz para esta etapa.\n\n" +
      "Reenvíame la lista actual de causas que estás trabajando y la reconstruimos."
    );
  }

  const formatted = list.map((item) => `- ${item}`).join("\n");

  if (state.selectedRoots.length > 0) {
    return (
      "Claro. Estas son las causas raíz que tienes actualmente seleccionadas para trabajar en Pareto:\n\n" +
      `${formatted}\n\n` +
      "Cuando quieras, también puedo ayudarte a identificar cuáles serían las causas críticas que debes reportar."
    );
  }

  return (
    "Claro. Estas son las causas raíz que tengo disponibles actualmente desde tu avance:\n\n" +
    `${formatted}\n\n` +
    "Si ya definiste tu selección para Pareto, puedo ayudarte a revisar cuáles estás usando."
  );
}

function buildCurrentCriteriaWeightsMessage(state: ParetoState) {
  const criteria = Array.isArray(state.criteria) ? state.criteria : [];

  if (criteria.length === 0) {
    return (
      "Aún no tienes criterios registrados en Pareto.\n\n" +
      "En esta etapa vamos a construir 3 criterios cortos y útiles para tu caso. " +
      "La idea es que te sirvan para comparar tus causas raíz, no poner criterios genéricos por cumplir."
    );
  }

  const lines = criteria.map((criterion) => {
    const weight =
      typeof criterion.weight === "number" && Number.isFinite(criterion.weight)
        ? criterion.weight
        : null;

    return weight !== null
      ? `- ${criterion.name}: ${weight}`
      : `- ${criterion.name}: (sin peso asignado todavía)`;
  });

  const allHaveWeights =
    criteria.length === 3 &&
    criteria.every(
      (criterion) =>
        typeof criterion.weight === "number" &&
        Number.isFinite(criterion.weight) &&
        criterion.weight >= 1 &&
        criterion.weight <= 10
    );

  if (allHaveWeights) {
    return (
      "Claro. Estos son tus criterios y pesos actuales en Pareto:\n\n" +
      lines.join("\n") +
      "\n\nSi quieres, ahora te explico cómo usarlos en tu Excel o planilla para identificar el grupo crítico."
    );
  }

  return (
    "Claro. Estos son tus criterios actuales en Pareto:\n\n" +
    lines.join("\n") +
    "\n\nTodavía faltan pesos por completar. Recuerda: un peso más alto significa que ese criterio tendrá más influencia en la priorización."
  );
}

function hasParetoCorrectionDetails(message: string) {
  const normalized = normalizeText(message);
  const mentionsParetoField =
    normalized.includes("peso") ||
    normalized.includes("criterio") ||
    normalized.includes("causa");
  const hasReplacementSignal =
    normalized.includes(" por ") ||
    normalized.includes("reemplazo");
  const hasAssignmentSignal =
    normalized.includes(" a ") ||
    normalized.includes(":") ||
    /\b\d{1,2}\b/.test(normalized);

  return mentionsParetoField && (hasReplacementSignal || hasAssignmentSignal);
}

function getCaseHint(caseContext: Record<string, unknown> | null) {
  if (!caseContext) return "tu caso";

  const serialized = JSON.stringify(caseContext)
    .replace(/[{}\[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!serialized) return "tu caso";

  return serialized.length > 140 ? `${serialized.slice(0, 140).trim()}...` : serialized;
}

function buildSuggestedCriteria(state: ParetoState, caseContext: Record<string, unknown> | null) {
  const text = normalizeText(
    [
      getCaseHint(caseContext),
      ...state.selectedRoots,
      ...state.roots.slice(0, 5),
    ].join(" ")
  );

  const suggestions: string[] = [];

  if (text.includes("tiempo") || text.includes("demora") || text.includes("espera")) {
    suggestions.push("Tiempo perdido");
  }
  if (text.includes("costo") || text.includes("gasto") || text.includes("merma")) {
    suggestions.push("Costo generado");
  }
  if (text.includes("calidad") || text.includes("defecto") || text.includes("reproceso")) {
    suggestions.push("Impacto en calidad");
  }
  if (text.includes("cliente") || text.includes("entrega") || text.includes("servicio")) {
    suggestions.push("Impacto en servicio");
  }

  for (const fallback of ["Impacto operativo", "Frecuencia", "Controlabilidad"]) {
    if (suggestions.length >= 3) break;
    if (!suggestions.includes(fallback)) suggestions.push(fallback);
  }

  return suggestions.slice(0, 3);
}

function buildParetoSupportMessage(input: {
  intentResult: ConversationIntentResult;
  state: ParetoState;
  caseContext: Record<string, unknown> | null;
}) {
  const { intentResult, state, caseContext } = input;
  const criteria = buildSuggestedCriteria(state, caseContext);
  const criteriaText = criteria.map((item) => `- ${item}`).join("\n");
  const currentStep = state.step;
  const rootExample = state.selectedRoots[0] ?? state.roots[0] ?? "una causa raiz relevante";
  const caseHint = getCaseHint(caseContext);

  if (intentResult.intent === "example_request") {
    return (
      `Ejemplo aplicado a ${caseHint}: si una causa raiz es "${rootExample}", podrias compararla con criterios como:\n\n` +
      `${criteriaText}\n\n` +
      "Luego asignas pesos de 1 a 10 segun importancia y calificas tus causas en Excel o en tu planilla. No necesito calcularte toda la matriz aqui; trae tus criterios, pesos o causas criticas y los revisamos."
    );
  }

  if (intentResult.intent === "unknown") {
    return (
      "No pasa nada. Para destrabar Pareto, elige criterios que te ayuden a comparar tus causas raiz, no criterios genericos por cumplir.\n\n" +
      `Para tu caso podrias partir con 2 o 3 de estos y adaptarlos:\n${criteriaText}\n\n` +
      "Escoge uno o ajustalo con tus palabras y lo revisamos."
    );
  }

  if (intentResult.intent === "help_request") {
    if (currentStep === "select_roots") {
      return "El siguiente micro-paso es quedarte con la lista de causas raiz que vas a priorizar en Pareto. Usa las causas del Ishikawa, elimina duplicadas y envia la lista final que quieres comparar.";
    }

    if (currentStep === "define_criteria") {
      return (
        "El siguiente micro-paso es definir 3 criterios cortos para comparar causas. Deben ayudarte a decidir que causa pesa mas en tu caso.\n\n" +
        `Puedes empezar con uno de estos y adaptarlo:\n${criteriaText}`
      );
    }

    if (currentStep === "set_weights") {
      return "Ahora asigna peso de 1 a 10 a cada criterio. Un peso alto significa que ese criterio influye mas en la priorizacion. Puedes escribir: Impacto operativo: 9, Frecuencia: 7, Controlabilidad: 6.";
    }

    return "Ahora usa tus criterios y pesos en Excel o en tu planilla: califica cada causa, ordenala de mayor a menor y vuelve con el grupo de causas criticas que te salio.";
  }

  if (intentResult.intent === "conceptual_question") {
    if (intentResult.normalizedMessage.includes("80/20") || intentResult.normalizedMessage.includes("top 20")) {
      return "En Pareto, la logica 80/20 sirve para identificar el grupo pequeno de causas que concentra la mayor parte del efecto. En OPT-IA no necesitas que la app haga todo el calculo: puedes hacerlo en Excel y traer aqui las causas criticas para revisarlas.";
    }

    if (intentResult.normalizedMessage.includes("peso") || intentResult.normalizedMessage.includes("ponder")) {
      return "El peso indica cuanta importancia tiene cada criterio al comparar causas. Usa 1 a 10: un 10 pesa mucho en la decision y un 1 pesa poco. Lo importante es que puedas justificar por que un criterio pesa mas que otro en tu caso.";
    }

    return "En esta etapa Pareto sirve para priorizar causas raiz. Primero defines criterios utiles, luego pesos, despues calificas en Excel o planilla y finalmente vuelves con las causas criticas para revisar coherencia.";
  }

  if (intentResult.intent === "meta_process") {
    return "La etapa Pareto no busca que la app haga obligatoriamente toda la matriz. Busca que tengas criterios, pesos y una seleccion final de causas criticas coherente con Ishikawa y 5 Porques. Si quieres validar avance, dime que parte ya tienes lista.";
  }

  if (intentResult.intent === "context_change") {
    return "Cambiar el contexto, la empresa, el problema o el enfoque puede afectar etapas anteriores como FODA, Ishikawa y Pareto. Si realmente necesitas hacerlo, confirmalo explicitamente y retomamos desde el punto que corresponda; no lo cambiare automaticamente desde este mensaje.";
  }

  if (intentResult.intent === "correction") {
    return "Podemos corregirlo, pero necesito que indiques exactamente que campo cambia: criterio, peso o causa critica. Por ejemplo: 'cambio el peso de Impacto operativo a 9' o 'reemplazo Frecuencia por Tiempo perdido'.";
  }

  return "Ese mensaje no parece conectado con Pareto. Volvamos al avance: dime tus criterios, pesos, dudas sobre el calculo en Excel o tus causas criticas.";
}

function buildParetoChecklistMessage(
  state: ParetoState,
  options: { savedCriticalRoots?: boolean } = {}
) {
  const criteriaOk = hasThreeCriteria(state);
  const weightsOk = hasWeights(state);
  const rootsForCritical = state.selectedRoots.length > 0 ? state.selectedRoots : state.roots;
  const minCritical = ceil20Percent(rootsForCritical.length);
  const criticalOk = state.criticalRoots.length >= minCritical;

  const criteriaLine = criteriaOk ? "OK criterios" : "FALTA criterios";
  const weightsLine = weightsOk ? "OK pesos" : "FALTA pesos";
  const criticalLine = criticalOk ? "OK causas criticas" : "FALTA causas criticas";

  const savedPrefix = options.savedCriticalRoots
    ? "Ya guarde las causas criticas que pude reconocer.\n\n"
    : "";

  if (!criteriaOk) {
    return (
      savedPrefix +
      "Para cerrar Pareto necesito:\n" +
      `${criteriaLine}\n${weightsLine}\n${criticalLine}\n\n` +
      "Ahora faltan 3 criterios de priorizacion. Enviame criterios como: Metodo de trabajo, Impacto operativo, Facilidad de implementacion."
    );
  }

  if (!weightsOk) {
    const criteriaText = state.criteria
      .map((criterion, index) => `${index + 1}. ${criterion.name}`)
      .join("\n");

    return (
      savedPrefix +
      "Para cerrar Pareto necesito:\n" +
      `${criteriaLine}\n${weightsLine}\n${criticalLine}\n\n` +
      "Ya tengo tus criterios. Faltan pesos de 1 a 10:\n" +
      `${criteriaText}\n\n` +
      "Puedes enviarlos como: los pesos son 7, 9 y 10."
    );
  }

  if (!criticalOk) {
    return (
      savedPrefix +
      "Para cerrar Pareto necesito:\n" +
      `${criteriaLine}\n${weightsLine}\n${criticalLine}\n\n` +
      "Califica tus causas raiz en tu matriz o Excel y enviame las causas criticas resultantes, por ejemplo:\n\n" +
      "1. Falta de mantenimiento preventivo\n2. Ausencia de estandarizacion\n3. Capacitacion insuficiente"
    );
  }

  return (
    savedPrefix +
    "Para cerrar Pareto necesito:\n" +
    `${criteriaLine}\n${weightsLine}\n${criticalLine}\n\n` +
    "Ya tengo lo necesario. Confirma con \"si\" y cierro Pareto para avanzar."
  );
}

function buildCauseProblemInsteadOfCriteriaMessage() {
  return (
    "Eso parece una lista de causas o problemas, no criterios de priorizacion.\n\n" +
    "Para Pareto necesito criterios que sirvan para comparar esas causas. Puedes usar, por ejemplo: impacto, frecuencia, costo, facilidad de implementacion o tiempo perdido. Enviame tus 3 criterios."
  );
}

function buildConfirmationWithoutPendingMessage(state: ParetoState) {
  return buildParetoChecklistMessage(state);

  if (state.step === "excel_work" || state.step === "collect_critical") {
    return "Antes de confirmar, necesito que me pegues las causas criticas que te salieron en tu Excel o planilla. Con solo un 'ok' no tengo una propuesta nueva para consolidar.";
  }

  if (state.step === "define_criteria") {
    return "Antes de confirmar, necesito que propongas o ajustes los 3 criterios. Si quieres, dime uno y lo reviso contigo.";
  }

  if (state.step === "set_weights") {
    return "Antes de confirmar, faltan pesos claros para los criterios. Escribelos de 1 a 10 para poder consolidarlos.";
  }

  return "Necesito una propuesta concreta antes de confirmar. Enviame la lista, criterio, peso o causa critica que quieres dejar registrada.";
}

function parseWeightsFromMessage(
  studentMessage: string,
  currentCriteria: ParetoState["criteria"]
): ParetoState["criteria"] | null {
  const parsed = applyWeightsToCriteria(currentCriteria, studentMessage);
  return parsed === currentCriteria ? null : parsed;
}

function hasExplicitCriterionProposalSignal(studentMessage: string) {
  const normalized = normalizeText(studentMessage);

  return (
    normalized.includes("criterio") ||
    normalized.includes("seria") ||
    normalized.includes("podria ser") ||
    normalized.includes("defini") ||
    normalized.includes("propongo") ||
    normalized.includes("otro factor") ||
    normalized.includes("otro aspecto")
  );
}

function shouldTreatMessageAsCriteriaProposal(studentMessage: string) {
  const raw = String(studentMessage ?? "").trim();
  if (!raw) return false;

  const normalized = normalizeText(raw);
  const compact = raw.replace(/[¿?]/g, "").trim();
  const wordCount = compact.split(/\s+/).filter(Boolean).length;
  const explicitProposal = hasExplicitCriterionProposalSignal(raw);

  if (isClearCriticalRootsMessage(raw)) return false;
  if (isOkConfirm(raw)) return false;
  if (isAskingForCriticalRoots(raw)) return false;
  if (isAskingForCriteriaWeights(raw)) return false;
  if (isAskingHowToDoPareto(raw)) return false;

  const looksLikeQuestionOrHelp =
    raw.includes("?") ||
    raw.includes("¿") ||
    normalized.includes("que es") ||
    normalized.includes("que significa") ||
    normalized.includes("para que") ||
    normalized.includes("por que") ||
    normalized.includes("como hago") ||
    normalized.includes("como seria") ||
    normalized.includes("como deberia") ||
    normalized.includes("no se") ||
    normalized.includes("ayudame") ||
    normalized.includes("ayuda");

  if (looksLikeQuestionOrHelp && !explicitProposal && wordCount > 3) {
    return false;
  }

  return parseParetoCriterionEntries(raw).length > 0;
}

function cleanCriterionCandidateText(input: string) {
  let value = String(input ?? "")
    .trim()
    .replace(/[.?!]+$/g, "")
    .replace(/^[-*•\d.)\s]+/, "")
    .trim();

  value = value
    .replace(/^(si|sí)\s*,?\s*/i, "")
    .replace(/^(un|una)\s+criterio\s+podr[ií]a\s+ser\s*,?\s*/i, "")
    .replace(/^criterio\s*\d*\s*:\s*/i, "")
    .replace(/^(podr[ií]a\s+ser|ser[ií]a)\s*,?\s*/i, "")
    .replace(/^uno\s+ser[ií]a\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) return "";

  const normalized = normalizeText(value);
  const blocked = new Set([
    "si",
    "sí",
    "criterio",
    "un criterio",
    "una criterio",
    "podria ser",
    "seria",
    "un criterio podria ser",
    "una criterio podria ser",
  ]);

  if (blocked.has(normalized)) return "";

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return "";

  return value;
}

function extractCriterionFromExplicitProposal(studentMessage: string) {
  const text = String(studentMessage ?? "").trim();
  if (!text) return "";

  const patterns = [
    /(?:el\s+otro\s+criterio|otro\s+criterio|el\s+primer\s+criterio|primer\s+criterio|el\s+segundo\s+criterio|segundo\s+criterio|el\s+tercer\s+criterio|tercer\s+criterio|un\s+criterio|criterio)\s+(?:que\s+defin[ií]|ser[ií]a|es|podr[ií]a\s+ser)\s*[:,]?\s*([^\n?.!]+)/i,
    /^(?:ser[ií]a|podr[ií]a\s+ser)\s*[:,]?\s*([^\n?.!]+)/i,
    /^(?:propongo|propongo\s+como\s+criterio)\s*[:,]?\s*([^\n?.!]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const candidate = cleanCriterionCandidateText(match[1]);
    if (candidate) return candidate;
  }

  return "";
}

async function extractCriteriaCandidatesWithAI(input: {
  studentMessage: string;
  currentCriteria: ParetoState["criteria"];
  caseContext: Record<string, unknown> | null;
  recentHistory: string;
  selectedRoots: string[];
}) {
  try {
    const model = getGeminiModel();

    const prompt = `
Eres un docente asesor de Ingeniería de Métodos.
Tu tarea NO es responder al estudiante, sino identificar si su mensaje realmente propone uno o más criterios de Pareto.

CONTEXTO:
- Etapa: Pareto
- Los criterios deben servir para comparar causas raíz.
- Deben ser cortos: ideal 1 o 2 palabras, máximo 4.
- NO debes capturar frases envoltorio como: "sí", "un criterio podría ser", "podría ser", "sería".
- NO debes capturar preguntas, explicaciones largas, dudas genéricas ni frases de cortesía.
- Si el mensaje NO propone claramente un criterio, devuelve shouldCapture=false.
- Si sí propone, devuelve solo el criterio limpio.
- Máximo 3 criterios.

CAUSAS RAÍZ SELECCIONADAS:
${JSON.stringify(input.selectedRoots, null, 2)}

CRITERIOS ACTUALES:
${JSON.stringify(input.currentCriteria, null, 2)}

CONTEXTO DEL CASO:
${JSON.stringify(input.caseContext ?? {}, null, 2)}

HISTORIAL RECIENTE:
${input.recentHistory}

MENSAJE DEL ESTUDIANTE:
"""${input.studentMessage}"""

DEVUELVE SOLO JSON:
{
  "shouldCapture": true,
  "criteria": ["Método de trabajo"]
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    const shouldCapture = Boolean(json?.shouldCapture);
    const rawCriteria: unknown[] = Array.isArray(json?.criteria)
      ? (json.criteria as unknown[])
      : [];

    const criteria = rawCriteria
      .map((item: unknown) => cleanCriterionCandidateText(String(item ?? "")))
      .filter((item): item is string => item.length > 0)
      .slice(0, 3);

    return {
      shouldCapture: shouldCapture && criteria.length > 0,
      criteria,
    };
  } catch {
    return {
      shouldCapture: false,
      criteria: [] as string[],
    };
  }
}

async function parseCriteriaFromMessage(input: {
  studentMessage: string;
  currentCriteria: ParetoState["criteria"];
  caseContext: Record<string, unknown> | null;
  recentHistory: string;
  selectedRoots: string[];
}): Promise<ParetoState["criteria"] | null> {
  const text = String(input.studentMessage ?? "").trim();
  if (!text) return null;
  if (!shouldTreatMessageAsCriteriaProposal(text)) return null;

  const existing = Array.isArray(input.currentCriteria)
    ? [...input.currentCriteria]
    : [];

  const parsedEntries = parseParetoCriterionEntries(text);
  if (parsedEntries.length > 0) {
    const parsed = applyCriterionEntriesToCriteria(existing, parsedEntries, {
      createId: () => crypto.randomUUID(),
    });

    const changed =
      parsed.length !== existing.length ||
      parsed.some((criterion, index) => criterion.weight !== existing[index]?.weight);

    return changed ? parsed : null;
  }

  const existingKeys = new Set(existing.map((c) => normalizeText(c.name)));

  let candidates: string[] = [];

  const explicitCandidate = extractCriterionFromExplicitProposal(text);
  if (explicitCandidate) {
    candidates = [explicitCandidate];
  }

  if (candidates.length === 0) {
    const aiResult = await extractCriteriaCandidatesWithAI({
      studentMessage: text,
      currentCriteria: existing,
      caseContext: input.caseContext,
      recentHistory: input.recentHistory,
      selectedRoots: input.selectedRoots,
    });

    candidates = aiResult.shouldCapture ? aiResult.criteria : [];
  }

  if (candidates.length === 0) {
    const fallback = cleanCriterionCandidateText(text);
    const fallbackWords = fallback.split(/\s+/).filter(Boolean);

    if (
      fallback &&
      !text.includes("?") &&
      !text.includes("¿") &&
      fallbackWords.length >= 1 &&
      fallbackWords.length <= 4 &&
      normalizeText(fallback) !== "si"
    ) {
      candidates = [fallback];
    }
  }

  if (candidates.length === 0) return null;

  const out = [...existing];

  for (const candidate of candidates) {
    const key = normalizeText(candidate);
    if (!key) continue;
    if (existingKeys.has(key)) continue;

    out.push({
      id: crypto.randomUUID(),
      name: candidate,
    });
    existingKeys.add(key);

    if (out.length >= 3) break;
  }

  return out.length !== existing.length ? out.slice(0, 3) : null;
}


function buildMissingWeightsTeacherMessage(state: ParetoState, studentMessage: string) {
  const askedForRoots = isAskingForCriticalRoots(studentMessage);
  const askedForCriteria = isAskingForCriteriaWeights(studentMessage);

  const criteriaText = state.criteria
    .map((criterion, index) => {
      const currentWeight =
        typeof criterion.weight === "number" && Number.isFinite(criterion.weight)
          ? ` (peso actual: ${criterion.weight})`
          : " (sin peso asignado)";
      return `- ${criterion.name || `Criterio ${index + 1}`}${currentWeight}`;
    })
    .join("\n");

  const exampleText = state.criteria
    .map((criterion, index) => `- ${criterion.name}: ${Math.max(8 - index * 2, 1)}`)
    .join("\n");

  if (askedForRoots) {
    return (
      "Puedo recordarte tus causas, pero antes conviene cerrar bien los pesos del Pareto para que la priorización tenga fundamento.\n\n" +
      "Tus criterios actuales son:\n" +
      `${criteriaText}\n\n` +
      "Ahora asígnales un peso entre 1 y 10. Un peso más alto significa mayor importancia al comparar causas. Puedes escribírmelos con este formato:\n" +
      `${exampleText}`
    );
  }

  if (askedForCriteria) {
    return (
      "Claro. Estos son tus criterios actuales de Pareto:\n\n" +
      `${criteriaText}\n\n` +
      "Ahora falta asignarles peso. Usa un valor entre 1 y 10 según la importancia que tendrá cada criterio en tu priorización."
    );
  }

  return (
    "Ya tenemos tus criterios. Ahora falta ponderarlos.\n\n" +
    `${criteriaText}\n\n` +
    "Pon un peso entre 1 y 10 a cada criterio. Un peso más alto significa mayor influencia en la priorización. Puedes escribírmelos con este formato:\n" +
    `${exampleText}`
  );
}

function buildCriteriaGuidanceFallback(input: {
  previousCriteria: ParetoState["criteria"];
  currentState: ParetoState;
}) {
  const previousCount = input.previousCriteria.length;
  const currentCount = input.currentState.criteria.length;
  const names = input.currentState.criteria
    .map((item) => item.name.trim())
    .filter(Boolean);

  const addedCriterion =
    currentCount > previousCount
      ? input.currentState.criteria[currentCount - 1]?.name?.trim() ?? ""
      : "";

  if (currentCount === 0) {
    return "Antes de poner pesos, primero definamos tus 3 criterios de priorización para este caso. Propón el primero y yo te ayudo a ver si realmente sirve para comparar tus causas raíz.";
  }

  if (currentCount < 3) {
    if (addedCriterion) {
      return currentCount === 1
        ? `Sí, **${addedCriterion}** puede funcionar como criterio si te ayuda a comparar tus causas raíz en este caso. Ahora pensemos el segundo criterio.`
        : `Sí, **${addedCriterion}** puede ser un criterio válido si aporta una mirada distinta para priorizar tus causas. Hasta ahora tienes **${names.join("** y **")}**. Propón el tercer criterio y lo revisamos.`;
    }

    if (currentCount === 1) {
      return `Bien, ya tienes 1 criterio: **${names[0]}**. Ahora propón el segundo y revisamos si complementa bien tu análisis.`;
    }

    return `Ya tienes 2 criterios: **${names.join("** y **")}**. Propón el tercero y revisamos si el conjunto queda sólido para tu Pareto.`;
  }

  if (!hasWeights(input.currentState)) {
    if (addedCriterion) {
      return `Sí, **${addedCriterion}** puede servir como criterio porque aporta otra dimensión para priorizar causas. Con **${names.join("**, **")}** ya tienes tus 3 criterios base. Ahora asígnales un peso entre 1 y 10 según su importancia.`;
    }

    return `Ya tienes tus 3 criterios: **${names.join("**, **")}**. Ahora asígnales un peso entre 1 y 10 según la importancia que tendrá cada uno en la priorización.`;
  }

  return `Ya tienes criterios y pesos definidos. Ahora pasa a tu Excel o planilla de Pareto, califica las causas, ordénalas y vuelve con el grupo crítico.`;
}

async function buildTeacherParetoReply(input: {
  studentMessage: string;
  paretoState: ParetoState;
  caseContext: Record<string, unknown> | null;
  recentHistory: string;
}) {
  const model = getGeminiModel();

  const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos.
Estás guiando al estudiante en la ETAPA 5: PARETO de su Plan de Mejora.

OBJETIVO DE TU RESPUESTA:
- Responder como docente real, no como chatbot rígido.
- Ser claro, breve y útil.
- Ayudar a interpretar el avance del estudiante.
- Si el estudiante pregunta por causas críticas, justificar con razonamiento académico.
- Si todavía no entregó una lista válida, guiarlo sin bloquear la conversación.
- NO inventes datos fuera del estado recibido.
- NO cierres oficialmente la etapa aquí.
- NO digas "etapa terminada" ni "ya pasaste".
- NO menciones JSON, sistema, backend, flujo interno ni validaciones técnicas.

TONO:
- Académico
- Claro
- Directo
- Como un docente asesor de prácticas empresariales

REGLAS:
- Si el estudiante pregunta cuáles serían sus causas críticas, usa únicamente las causas del estado.
- Si el estudiante pide ayuda para justificar, explica por qué una causa podría ser más prioritaria que otra según impacto, frecuencia o controlabilidad.
- Si el estudiante ya pegó causas críticas válidas, responde reconociendo el avance y pídele confirmación breve o indícale que ya quedó lista la revisión para validar.
- Si el mensaje es ambiguo, pide una aclaración corta.
- Máximo 2 párrafos.
- No uses listas largas salvo que sea realmente necesario.

CONTEXTO DEL CASO:
${JSON.stringify(input.caseContext ?? {}, null, 2)}

ESTADO PARETO:
${JSON.stringify(input.paretoState, null, 2)}

HISTORIAL RECIENTE:
${input.recentHistory}

MENSAJE DEL ESTUDIANTE:
"""${input.studentMessage}"""

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string"
}
`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const json = extractJsonSafe(text);

  const assistantMessage =
    typeof json?.assistantMessage === "string" && json.assistantMessage.trim()
      ? json.assistantMessage.trim()
      : null;

  if (!assistantMessage) {
    return null;
  }

  return assistantMessage;
}

async function buildTeacherCriteriaReply(input: {
  studentMessage: string;
  paretoState: ParetoState;
  caseContext: Record<string, unknown> | null;
  recentHistory: string;
}) {
  const model = getGeminiModel();

  const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos guiando la ETAPA 5: PARETO de un Plan de Mejora.

TU PAPEL:
Acompañar al estudiante de manera conversacional, breve y útil, como en una asesoría real.
No respondas como robot, checklist rígido ni manual largo.

CÓMO DEBES ACTUAR EN ESTA ETAPA:
- Primero ayudan a definir 3 criterios de priorización alineados al caso.
- Los criterios deben ser cortos: idealmente 1 o 2 palabras; máximo 4 palabras.
- No impongas criterios genéricos como lista fija.
- Si el estudiante no sabe qué poner, propone solo 2 opciones contextualizadas y pregúntale con cuál se queda o cómo lo adaptaría.
- Si el estudiante propone un criterio, evalúa rápidamente si sirve para comparar causas raíz y, si hace falta, ayúdale a reformularlo en una versión más corta y clara.
- Ignora frases envoltorio como "sí", "un criterio podría ser", "podría ser" o "sería"; solo considera el concepto real que el estudiante propone.
- Si ya tiene 1 o 2 criterios, enfócate solo en completar el siguiente. No expliques de más.
- Si ya tiene 3 criterios pero faltan pesos, deja de proponer criterios nuevos. Explica brevemente que el peso va de 1 a 10 y que un peso mayor significa mayor importancia para priorizar.
- Si el estudiante pregunta qué sigue después de criterios y pesos, indícale de forma breve que debe llevar sus causas a Excel o a su planilla de Pareto, calificarlas con esos criterios, ordenarlas y volver con el grupo crítico.
- Si pregunta por el 80/20, explica en una sola frase que se busca identificar el pequeño grupo de causas que concentra la mayor parte del efecto.
- Si el mensaje es ambiguo, haz una sola pregunta corta para destrabar el avance.
- No inventes datos fuera del estado recibido.
- No cierres la etapa aquí.
- Máximo 2 párrafos cortos.
- Evita listas salvo que el estudiante pida opciones; en ese caso usa máximo 2 viñetas.
- Termina con una sola pregunta o una sola acción concreta.

CONTEXTO DEL CASO:
${JSON.stringify(input.caseContext ?? {}, null, 2)}

ESTADO PARETO:
${JSON.stringify(input.paretoState, null, 2)}

HISTORIAL RECIENTE:
${input.recentHistory}

MENSAJE DEL ESTUDIANTE:
"""${input.studentMessage}"""

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string"
}
`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const json = extractJsonSafe(text);

  const assistantMessage =
    typeof json?.assistantMessage === "string" && json.assistantMessage.trim()
      ? json.assistantMessage.trim()
      : null;

  return assistantMessage;
}


export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "No se pudo leer el perfil del estudiante." },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: gate.reason,
          message: gate.message,
        },
        { status: 403 }
      );
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Payload inválido.",
        },
        { status: 400 }
      );
    }

    const paretoStateNormalized = normalizeParetoState(parsed.data.paretoState);
    const stateParsed = ParetoStateSchema.safeParse(paretoStateNormalized);

    if (!stateParsed.success) {
      console.error("[plans] pareto/assistant: estado zod inválido", stateParsed.error.flatten());
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Estado de Pareto inválido después de normalizar.",
          detail: null,
        },
        { status: 400 }
      );
    }

    const {
      chatId = null,
      studentMessage,
      caseContext = null,
      recentHistory = "",
    } = parsed.data;

    if (chatId) {
      const access = await assertChatOwner(user.userId, chatId);
      if (!access.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: access.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
            message: access.message,
          },
          { status: access.status }
        );
      }
    }

    const officialRoots = await loadOfficialIshikawaRoots(user.userId, chatId);

    const persistedParetoState = await loadPersistedParetoState(user.userId, chatId);

    const mergedParetoState = sanitizeParetoStateWithOfficialRoots(
      mergeAssistantParetoState(persistedParetoState, stateParsed.data),
      officialRoots
    );

    let paretoState: ParetoState = {
      ...mergedParetoState,
      step: resolveParetoStepFromState(mergedParetoState),
    };

    const selectedRoots = paretoState.selectedRoots
    .map((x) => String(x).trim())
    .filter(Boolean);

    const roots = paretoState.roots
      .map((x) => String(x).trim())
      .filter(Boolean);

    const rootsForMatching = selectedRoots.length > 0 ? selectedRoots : roots;

    const conversationIntent = classifyConversationIntent({
      message: studentMessage,
      stage: STAGE,
      currentStep: paretoState.step,
      currentState: paretoState,
    });

    if (isAskingForCriteriaWeights(studentMessage)) {
      return assistantResponse(
        buildCurrentCriteriaWeightsMessage(paretoState),
        { ...paretoState },
        actionFromParetoStep(paretoState.step)
      );
    }

    if (isAskingForCriticalRoots(studentMessage)) {
      return assistantResponse(
        buildCurrentRootsListMessage(paretoState),
        { ...paretoState },
        actionFromParetoStep(paretoState.step)
      );
    }

    let savedCriticalRootsThisTurn = false;
    let completedCriteriaOrWeightsThisTurn = false;

    if (conversationIntent.shouldMutateStage && !isParetoCloseConfirmation(studentMessage)) {
      const parsedCriteriaFromTurn = await parseCriteriaFromMessage({
        studentMessage,
        currentCriteria: paretoState.criteria,
        caseContext,
        recentHistory,
        selectedRoots: paretoState.selectedRoots,
      });

      if (parsedCriteriaFromTurn) {
        completedCriteriaOrWeightsThisTurn = true;
        paretoState = {
          ...paretoState,
          criteria: parsedCriteriaFromTurn,
        };
      }

      const parsedWeightsFromTurn = parseWeightsFromMessage(
        studentMessage,
        paretoState.criteria
      );

      if (parsedWeightsFromTurn) {
        completedCriteriaOrWeightsThisTurn = true;
        paretoState = {
          ...paretoState,
          criteria: parsedWeightsFromTurn,
        };
      }

      const parsedCriticalFromTurn = parseCriticalRootsFromMessage(studentMessage);
      const hasCriticalDelivery = looksLikeCriticalRootsDelivery(
        studentMessage,
        parsedCriticalFromTurn
      );

      if (hasCriticalDelivery) {
        const { matched } = matchAgainstSelectedRoots(parsedCriticalFromTurn, rootsForMatching);
        const criticalRootsToStore = matched.length > 0 ? matched : parsedCriticalFromTurn;

        if (criticalRootsToStore.length > 0) {
          savedCriticalRootsThisTurn = true;
          paretoState = {
            ...paretoState,
            criticalRoots: mergeParetoStringListMonotonic(
              paretoState.criticalRoots,
              criticalRootsToStore
            ),
          };
        }
      }

      paretoState = {
        ...paretoState,
        step: resolveParetoStepFromState(paretoState),
      };
    }

    if (conversationIntent.intent === "confirmation" || isParetoCloseConfirmation(studentMessage)) {
      const currentMinSelected = Number.isFinite(paretoState.minSelected)
        ? paretoState.minSelected
        : 10;
      const currentMaxSelected = Number.isFinite(paretoState.maxSelected)
        ? Math.max(currentMinSelected, paretoState.maxSelected)
        : 15;

      if (paretoState.step === "select_roots") {
        if (
          selectedRoots.length >= currentMinSelected &&
          selectedRoots.length <= currentMaxSelected
        ) {
          return assistantResponse(
            "Perfecto. La lista de causas queda como base para Pareto. Ahora definamos 3 criterios utiles para priorizarlas.",
            { ...paretoState, step: "define_criteria" },
            "define_criteria"
          );
        }

        return assistantResponse(
          buildConfirmationWithoutPendingMessage(paretoState),
          { ...paretoState },
          "ask_clarify"
        );
      }

      if (paretoState.step === "define_criteria" && hasThreeCriteria(paretoState)) {
        return assistantResponse(
          "Perfecto. Ya hay 3 criterios definidos. Ahora asignales peso de 1 a 10 segun su importancia para priorizar tus causas.",
          { ...paretoState, step: "set_weights" },
          "set_weights"
        );
      }

      if (paretoState.step === "set_weights" && hasWeights(paretoState)) {
        return assistantResponse(
          "Listo. Ya quedaron criterios y pesos. Ahora usa esos criterios en Excel o en tu planilla, ordena tus causas y vuelve con el grupo critico.",
          { ...paretoState, step: "excel_work", criticalRoots: [] },
          "instruct_excel"
        );
      }

      if (paretoState.step === "collect_critical" || paretoState.step === "done") {
        const currentMatched = matchAgainstSelectedRoots(
          paretoState.criticalRoots,
          rootsForMatching
        ).matched;
        const minCritical = ceil20Percent(rootsForMatching.length);

        if (currentMatched.length >= minCritical) {
          return assistantResponse(
            "Perfecto. Confirmo esas causas como tu grupo critico del Pareto. Con esto la etapa queda lista para validarse.",
            {
              ...paretoState,
              criticalRoots: currentMatched,
              step: "done",
            },
            "done"
          );
        }
      }

      return assistantResponse(
        buildConfirmationWithoutPendingMessage(paretoState),
        { ...paretoState },
        "ask_clarify"
      );
    }

    if (
      conversationIntent.intent === "correction" &&
      !hasParetoCorrectionDetails(studentMessage)
    ) {
      return assistantResponse(
        buildParetoSupportMessage({
          intentResult: conversationIntent,
          state: paretoState,
          caseContext,
        }),
        { ...paretoState },
        "ask_clarify"
      );
    }

    if (!conversationIntent.shouldMutateStage) {
      return assistantResponse(
        buildParetoSupportMessage({
          intentResult: conversationIntent,
          state: paretoState,
          caseContext,
        }),
        { ...paretoState },
        actionFromParetoStep(paretoState.step)
      );
    }

    if (
      completedCriteriaOrWeightsThisTurn &&
      hasWeights(paretoState) &&
      paretoState.criticalRoots.length === 0
    ) {
      return assistantResponse(
        "Listo. Ya quedaron definidos tus criterios y pesos.\n\n" +
          "Ahora califica tus causas raiz en tu matriz o Excel, ordenalas por puntaje y vuelve con las causas criticas resultantes.",
        { ...paretoState, step: "excel_work" },
        "instruct_excel"
      );
    }

    const previousCriteriaBeforeParse = paretoState.criteria;

    const parsedCriteriaNames = await parseCriteriaFromMessage({
      studentMessage,
      currentCriteria: paretoState.criteria,
      caseContext,
      recentHistory,
      selectedRoots: paretoState.selectedRoots,
    });

    const paretoStateWithParsedCriteria: ParetoState = parsedCriteriaNames
      ? {
          ...paretoState,
          criteria: parsedCriteriaNames,
        }
      : paretoState;

    const parsedCriteriaFromMessage = parseWeightsFromMessage(
      studentMessage,
      paretoStateWithParsedCriteria.criteria
    );

    const paretoStateWithParsedWeights: ParetoState = parsedCriteriaFromMessage
      ? {
          ...paretoStateWithParsedCriteria,
          criteria: parsedCriteriaFromMessage,
        }
      : paretoStateWithParsedCriteria;

    const effectiveParetoState: ParetoState = {
      ...paretoStateWithParsedWeights,
      step: resolveParetoStepFromState(paretoStateWithParsedWeights),
    };

    const minSelected = Number.isFinite(effectiveParetoState.minSelected)
      ? effectiveParetoState.minSelected
      : 10;

    const maxSelected = Number.isFinite(effectiveParetoState.maxSelected)
      ? Math.max(minSelected, effectiveParetoState.maxSelected)
      : 15;

    if (!hasThreeCriteria(effectiveParetoState)) {
      if (!savedCriticalRootsThisTurn && isLikelyParetoCauseOrProblemList(studentMessage)) {
        return assistantResponse(
          buildCauseProblemInsteadOfCriteriaMessage(),
          {
            ...effectiveParetoState,
            step: "define_criteria",
          },
          "define_criteria"
        );
      }

      const teacherCriteriaReply = await buildTeacherCriteriaReply({
        studentMessage,
        paretoState: effectiveParetoState,
        caseContext,
        recentHistory,
      });

      return assistantResponse(
        savedCriticalRootsThisTurn
          ? buildParetoChecklistMessage(effectiveParetoState, { savedCriticalRoots: true })
          : teacherCriteriaReply ||
          buildCriteriaGuidanceFallback({
            previousCriteria: previousCriteriaBeforeParse,
            currentState: {
              ...effectiveParetoState,
              step: "define_criteria",
            },
          }),
        {
          ...effectiveParetoState,
          step: "define_criteria",
        },
        "define_criteria"
      );
    }

    if (!hasWeights(paretoStateWithParsedWeights)) {
      const teacherCriteriaReply = await buildTeacherCriteriaReply({
        studentMessage,
        paretoState: paretoStateWithParsedWeights,
        caseContext,
        recentHistory,
      });

      return assistantResponse(
        savedCriticalRootsThisTurn
          ? buildParetoChecklistMessage(paretoStateWithParsedWeights, { savedCriticalRoots: true })
          : teacherCriteriaReply ||
          buildMissingWeightsTeacherMessage(paretoStateWithParsedWeights, studentMessage),
        {
          ...paretoStateWithParsedWeights,
          step: "set_weights",
        },
        "set_weights"
      );
    }

    if (
      effectiveParetoState.step === "set_weights" &&
      hasWeights(effectiveParetoState) &&
      isAskingHowToDoPareto(studentMessage)
    ) {
      return assistantResponse(
        "Perfecto. Ya tienes tus 3 criterios con peso.\n\n" +
          "Ahora lleva tus causas raíz a tu Excel o planilla de Pareto: califica cada causa con esos criterios, obtén el puntaje total, ordénalas de mayor a menor y revisa el acumulado. La lógica 80/20 te ayuda a identificar el grupo pequeño de causas que concentra la mayor parte del problema. Cuando termines, vuelve con tus causas críticas.",
        {
          ...effectiveParetoState,
          step: "excel_work",
          criticalRoots: [],
        },
        "instruct_excel"
      );
    }

    
    if (isAskingForCriteriaWeights(studentMessage)) {
      return assistantResponse(
        buildCurrentCriteriaWeightsMessage(effectiveParetoState),
        { ...effectiveParetoState },
        actionFromParetoStep(effectiveParetoState.step)
      );
    }

    if (isAskingForCriticalRoots(studentMessage)) {
      return assistantResponse(
        buildCurrentRootsListMessage(effectiveParetoState),
        { ...effectiveParetoState },
        actionFromParetoStep(effectiveParetoState.step)
      );
    }

    if (isOkConfirm(studentMessage)) {
      if (effectiveParetoState.step === "select_roots") {
        if (selectedRoots.length < minSelected || selectedRoots.length > maxSelected) {
          return assistantResponse(
            `Aún no estamos en el rango. Selecciona entre **${minSelected} y ${maxSelected}** causas raíz.\n` +
              `Actualmente tienes **${selectedRoots.length}**.\n\n` +
              "👉 Responde con la lista final (puede ser en viñetas o separada por comas).",
            { ...effectiveParetoState },
            "ask_clarify"
          );
        }

        return assistantResponse(
          "Perfecto ✅ La lista de causas ya quedó lista.\n\n" +
            "Ahora vamos con los criterios de priorización. Aquí no quiero que pongamos criterios genéricos por poner, sino criterios que realmente te ayuden a decidir cuáles causas pesan más en tu caso.\n\n" +
            "Propón el primer criterio que consideres importante y yo te ayudo a afinarlo antes de pasar al siguiente.",
          { ...effectiveParetoState, step: "define_criteria" },
          "define_criteria"
        );
      }

      if (
        effectiveParetoState.step === "define_criteria" &&
        hasThreeCriteria(effectiveParetoState)
      ) {
        return assistantResponse(
          "Perfecto ✅ Ya tenemos los 3 criterios.\n\n" +
            "Ahora vamos a ponderarlos. Puedes hacerlo uno por uno si quieres, y yo te ayudo a justificar si conviene darle más o menos peso según el caso.\n\n" +
            "Empieza por el que consideres más importante y dime qué peso le pondrías entre 1 y 10.",
          { ...effectiveParetoState, step: "set_weights" },
          "set_weights"
        );
      }

      if (
        effectiveParetoState.step === "set_weights" &&
        hasWeights(effectiveParetoState)
      ) {
        return assistantResponse(
          "Listo ✅ Ya quedaron definidos tus criterios y pesos.\n\n" +
          "Ahora haz el Pareto en tu Excel o planilla: califica cada causa raíz, ordénalas de mayor a menor, revisa el acumulado y detecta el grupo crítico. La idea del 80/20 es quedarte con las pocas causas que más concentran el efecto. Cuando termines, vuelve y envíame tus causas críticas.",
          { ...effectiveParetoState, step: "excel_work" },
          "instruct_excel"
        );
      }

      if (effectiveParetoState.step === "excel_work") {
        return assistantResponse(
          "Genial. Ahora envíame tu lista de **causas críticas (Top 20%)** según tu Excel.\n" +
            "Puedes escribirlas en viñetas o separadas por comas.",
          { ...effectiveParetoState, step: "collect_critical" },
          "collect_critical"
        );
      }
    }

    if (
      effectiveParetoState.step === "excel_work" ||
      effectiveParetoState.step === "collect_critical"
    ) {

      if (isAskingHowToDoPareto(studentMessage)) {
        const criteriaNames = effectiveParetoState.criteria
            .map((criterion) => criterion.name.trim())
            .filter(Boolean);

          const criteriaText =
            criteriaNames.length > 0 ? criteriaNames.join(", ") : "tus criterios definidos";

          return assistantResponse(
            "Te guío. En esta etapa debes priorizar tus causas raíz en tu Excel o planilla usando " +
              `${criteriaText}` +
              ".\n\n" +
              "Califica cada causa, ordénalas de mayor a menor, calcula el acumulado y detecta el grupo crítico. La lógica del 80/20 busca identificar el pequeño grupo de causas que concentra la mayor parte del efecto. Cuando termines, pégame solo las causas críticas y yo te ayudo a revisarlas.",
            {
              ...effectiveParetoState,
              step: "collect_critical",
            },
            "collect_critical"
          );
      }

      const parsedCritical = parseCriticalRootsFromMessage(studentMessage);
      const shouldValidateCriticalRoots = looksLikeCriticalRootsDelivery(
        studentMessage,
        parsedCritical
      );

      if (shouldValidateCriticalRoots) {
        const { matched, invalid } = matchAgainstSelectedRoots(
          parsedCritical,
          rootsForMatching
        );

        const minCritical = ceil20Percent(rootsForMatching.length);
        const maxCritical = Math.max(minCritical, Math.ceil(rootsForMatching.length * 0.3));

        if (matched.length < minCritical) {
          return assistantResponse(
            `Todavía no alcanzo a recuperar todo tu top 20%. Para tu lista actual necesito al menos ${minCritical} causa(s) crítica(s).\n\nPégame nuevamente solo las causas críticas que te salieron en el Excel, una por línea o en viñetas.`,
            {
              ...effectiveParetoState,
              criticalRoots: matched,
              step: "collect_critical",
            },
            "ask_clarify"
          );
        }

        if (matched.length > maxCritical) {
          return assistantResponse(
            "Tu selección quedó más amplia de lo esperado para un Pareto. Revísala una vez más y quédate solo con el grupo crítico que realmente concentra el 20% aproximadamente.",
            {
              ...effectiveParetoState,
              criticalRoots: matched,
              step: "collect_critical",
            },
            "ask_clarify"
          );
        }

        if (invalid.length > 0) {
          const recoveredText = matched.map((item) => `- ${item}`).join("\n");

          return assistantResponse(
            "Entendí y recuperé como causas críticas estas:\n\n" +
              `${recoveredText}\n\n` +
              "Si son correctas, ya quedó lista esta parte del Pareto. Si quieres, puedes reenviármelas ajustando solo la redacción de las que faltaron reconocer.",
            {
              ...effectiveParetoState,
              criticalRoots: matched,
              step: "done",
            },
            "done"
          );
        }

        return assistantResponse(
          "Perfecto. Ya quedaron registradas tus causas críticas del Pareto y son consistentes con tu selección previa.\n\nCon esto ya puedo dejar lista la etapa para su validación y, si todo está correcto, continuaremos con la definición de objetivos de mejora.",
          {
            ...effectiveParetoState,
            criticalRoots: matched,
            step: "done",
          },
          "done"
        );
      }

      const intent = await classifyStudentIntent(studentMessage);

      if (intent === "CONFIRM") {
        const currentMatched = matchAgainstSelectedRoots(
          effectiveParetoState.criticalRoots,
          rootsForMatching
        ).matched;

        const minCritical = ceil20Percent(rootsForMatching.length);

        if (currentMatched.length >= minCritical) {
          return assistantResponse(
            "Perfecto. Entonces dejo confirmadas esas causas como tu grupo crítico del Pareto. Con esto la etapa queda lista para validarse y pasar a la definición de objetivos.",
            {
              ...effectiveParetoState,
              criticalRoots: currentMatched,
              step: "done",
            },
            "done"
          );
        }

        return assistantResponse(
          "Todavía no tengo registrada una lista crítica suficiente para cerrar el Pareto. Pégame nuevamente solo tus causas críticas (top 20%) y las revisamos.",
          {
            ...effectiveParetoState,
            step: "collect_critical",
          },
          "ask_clarify"
        );
      }

      if (intent === "ASK_SHOW_CRITERIA_WEIGHTS") {
        return assistantResponse(
          buildCurrentCriteriaWeightsMessage(effectiveParetoState),
          { ...effectiveParetoState },
          actionFromParetoStep(effectiveParetoState.step)
        );
      }

      if (intent === "ASK_METHOD") {
        return assistantResponse(
          "En esta etapa debes aplicar Pareto sobre las causas que ya seleccionaste: ordénalas en tu Excel según tus criterios, calcula el acumulado y detecta cuáles conforman el grupo crítico.\n\nCuando tengas ese resultado, compárteme aquí solo las causas críticas y yo te ayudo a validarlas.",
          {
            ...effectiveParetoState,
            step: "collect_critical",
          },
          "collect_critical"
        );
      }

      if (intent === "ANALYTICAL_QUESTION") {
        const teacherReply = await buildTeacherParetoReply({
          studentMessage,
          paretoState: effectiveParetoState,
          caseContext,
          recentHistory,
        });

        if (teacherReply) {
          return assistantResponse(
            teacherReply,
            {
              ...effectiveParetoState,
              step: "collect_critical",
            },
            "collect_critical"
          );
        }

        return assistantResponse(
          "Puedo ayudarte a interpretarlo. Compárteme cuáles causas te generan duda y te explico cuáles conviene reportar como críticas y por qué.",
          {
            ...effectiveParetoState,
            step: "collect_critical",
          },
          "collect_critical"
        );
      }

    }
  
    const model = getGeminiModel();

        const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos guiando la ETAPA 5: PARETO dentro de un Plan de Mejora académico.

OBJETIVO:
Responder como asesor académico real, con lenguaje claro, humano y útil, ayudando al estudiante a completar correctamente su análisis.

REGLAS IMPORTANTES:
- Responde en español.
- Sé breve pero inteligente.
- Prioriza claridad académica antes que formalismo.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No hables como sistema, asistente virtual o bot.
- No menciones JSON, estados internos, backend o validaciones técnicas.
- No inventes causas ni datos que no estén en el contexto o estado.
- No cierres oficialmente la etapa aquí.
- No digas "ya pasaste a la siguiente etapa".
- Si el estudiante aún no ha entregado causas críticas, oriéntalo para hacerlo.
- Si el estudiante hace una pregunta analítica, responde con razonamiento docente.
- Si el mensaje es ambiguo, pide una aclaración puntual.
- Máximo 2 párrafos.
- Evita listas largas salvo que sean necesarias.

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

ESTADO ACTUAL:
${JSON.stringify(effectiveParetoState, null, 2)}

HISTORIAL RECIENTE:
${recentHistory}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": <ParetoState>,
    "action": "init" | "select_roots" | "define_criteria" | "set_weights" | "instruct_excel" | "collect_critical" | "ask_clarify" | "redirect"
  }
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      console.error("[plans] pareto/assistant: LLM sin JSON válido", text);
      return NextResponse.json(
        { ok: false, code: "INVALID_LLM_JSON", message: "LLM no devolvió JSON válido", detail: null },
        { status: 500 }
      );
    }

    const nextStateNormalized = normalizeParetoState(json.updates.nextState);
    const nextStateParsed = ParetoStateSchema.safeParse(nextStateNormalized);

    if (!nextStateParsed.success) {
      console.error("[plans] pareto/assistant: nextState zod inválido", nextStateParsed.error.flatten());
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_NEXT_STATE",
          message: "nextState inválido devuelto por el assistant.",
          detail: null,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        assistantMessage: sanitizeStudentPlaceholder(
          String(json.assistantMessage),
          preferredFirstName
        ),
        updates: {
          nextState: nextStateParsed.data,
          action: ["init","select_roots","define_criteria","set_weights","instruct_excel","collect_critical","ask_clarify","redirect","done"].includes(json?.updates?.action)
          ? json.updates.action
          : "redirect",
                },
      },
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return NextResponse.json(
        { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." },
        { status: 401 }
      );
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN_DOMAIN", message: "Correo no permitido." },
        { status: 403 }
      );
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return NextResponse.json(
        {
          ok: false,
          code: "AUTH_UPSTREAM_TIMEOUT",
          message:
            "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        },
        { status: 503 }
      );
    }

    console.error("[plans] pareto/assistant: error interno", err);
    return NextResponse.json({ ok: false, code: "INTERNAL", message: "Error interno." }, { status: 500 });
  }
}
