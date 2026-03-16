// src/app/api/plans/pareto/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

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
- CONFIRM: solo confirma brevemente, por ejemplo "ok", "sí", "listo", "continuemos".
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
    state.criteria.length === 3 &&
    state.criteria.every((c) => c.name.trim().length > 0)
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

function defaultCriterionName(index: number): string {
  if (index === 0) return "Impacto";
  if (index === 1) return "Frecuencia";
  return "Controlabilidad";
}

function normalizeCriteria(input: unknown) {
  const raw = Array.isArray(input) ? input : [];

  const cleaned = raw
    .map((item, index) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};

      const name = String(record.name ?? "").trim();
      const id = String(record.id ?? "").trim() || crypto.randomUUID();
      const weight = normalizeWeight(record.weight);

      return {
        id,
        name: name || defaultCriterionName(index),
        ...(weight !== undefined ? { weight } : {}),
      };
    })
    .filter((item) => item.name.length > 0)
    .slice(0, 3);

  while (cleaned.length < 3) {
    const index = cleaned.length;
    cleaned.push({
      id: crypto.randomUUID(),
      name: defaultCriterionName(index),
    });
  }

  return cleaned;
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

  const merged = normalizeParetoState({
    roots: persisted.roots.length > 0 ? persisted.roots : incoming.roots,
    selectedRoots:
      persisted.selectedRoots.length > 0 ? persisted.selectedRoots : incoming.selectedRoots,
    criteria:
      Array.isArray(persisted.criteria) && persisted.criteria.length > 0
        ? persisted.criteria
        : incoming.criteria,
    criticalRoots:
      persisted.criticalRoots.length > 0 ? persisted.criticalRoots : incoming.criticalRoots,
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
      "👉 Primero debemos definir exactamente 3 criterios de priorización, por ejemplo:\n" +
      "- Impacto\n- Frecuencia\n- Controlabilidad"
    );
  }

  const lines = criteria.map((criterion, index) => {
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
      "\n\nSi quieres, ahora puedo ayudarte a interpretar cómo usar estos pesos para priorizar tus causas."
    );
  }

  return (
    "Claro. Estos son tus criterios actuales en Pareto:\n\n" +
    lines.join("\n") +
    "\n\nTodavía faltan algunos pesos por completar. Cada criterio debe tener un peso entre 1 y 10."
  );
}

function parseWeightsFromMessage(
  studentMessage: string,
  currentCriteria: ParetoState["criteria"]
): ParetoState["criteria"] | null {
  const text = String(studentMessage ?? "").trim();
  if (!text) return null;

  const lines = text
    .split(/\n|;/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const parsed = currentCriteria.map((criterion) => ({ ...criterion }));
  let updates = 0;

  for (const criterion of parsed) {
    const criterionKey = normalizeText(criterion.name);

    const matchedLine = lines.find((line) => {
      const normalizedLine = normalizeText(line);
      return normalizedLine.includes(criterionKey);
    });

    if (!matchedLine) continue;

    const match = matchedLine.match(/(\d{1,2})(?:\s*$|\b)/);
    if (!match) continue;

    const weight = Number(match[1]);
    if (!Number.isFinite(weight) || weight < 1 || weight > 10) continue;

    criterion.weight = weight;
    updates += 1;
  }

  return updates > 0 ? parsed : null;
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

  if (askedForRoots) {
    return (
      "Claro, te recuerdo tus causas raíz; pero antes necesitamos completar correctamente los pesos del Pareto para que la priorización quede bien hecha.\n\n" +
      "Tus criterios actuales son:\n" +
      `${criteriaText}\n\n` +
      "👉 Envíame los pesos así, uno por criterio:\n" +
      "- Impacto: 8\n- Frecuencia: 6\n- Controlabilidad: 9"
    );
  }

  if (askedForCriteria) {
    return (
      "Claro. Estos son tus criterios actuales de Pareto:\n\n" +
      `${criteriaText}\n\n` +
      "Todavía faltan pesos válidos. Asigna un valor entre 1 y 10 a cada criterio."
    );
  }

  return (
    "Todavía no están completos tus pesos de Pareto.\n\n" +
    "Tus criterios actuales son:\n" +
    `${criteriaText}\n\n` +
    "👉 Asigna un peso entre 1 y 10 a cada criterio. Por ejemplo:\n" +
    "- Impacto: 8\n- Frecuencia: 6\n- Controlabilidad: 9"
  );
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


export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
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
          message: parsed.error.issues[0]?.message ?? "Payload inválido.",
        },
        { status: 400 }
      );
    }

    const paretoStateNormalized = normalizeParetoState(parsed.data.paretoState);
    const stateParsed = ParetoStateSchema.safeParse(paretoStateNormalized);

    if (!stateParsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Estado de Pareto inválido después de normalizar.",
          detail: stateParsed.error.flatten(),
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

    const persistedParetoState = await loadPersistedParetoState(user.userId, chatId);
    const mergedParetoState = mergeAssistantParetoState(persistedParetoState, stateParsed.data);

    const paretoState: ParetoState = {
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

        const parsedCriteriaFromMessage = parseWeightsFromMessage(
      studentMessage,
      paretoState.criteria
    );

    const paretoStateWithParsedWeights: ParetoState = parsedCriteriaFromMessage
      ? {
          ...paretoState,
          criteria: parsedCriteriaFromMessage,
        }
      : paretoState;

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
      return assistantResponse(
        "Aún no has definido correctamente tus 3 criterios de Pareto.\n\n" +
          "👉 Antes de continuar, escribe exactamente 3 criterios de priorización, por ejemplo:\n" +
          "- Impacto\n- Frecuencia\n- Controlabilidad",
        {
          ...effectiveParetoState,
          step: "define_criteria",
          criticalRoots: [],
        },
        "define_criteria"
      );
    }

    if (!hasWeights(paretoStateWithParsedWeights)) {
      return assistantResponse(
        buildMissingWeightsTeacherMessage(paretoStateWithParsedWeights, studentMessage),
        {
          ...paretoStateWithParsedWeights,
          step: "set_weights",
          criticalRoots: [],
        },
        "set_weights"
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
          "Perfecto ✅ La lista de causas está lista.\n\n" +
            "Ahora define **exactamente 3 criterios** para priorizar (por ejemplo: Impacto, Frecuencia y Controlabilidad).\n" +
            "Escríbelos así:\n" +
            "- Criterio 1: ...\n" +
            "- Criterio 2: ...\n" +
            "- Criterio 3: ...",
          { ...effectiveParetoState, step: "define_criteria" },
          "define_criteria"
        );
      }

      if (
        effectiveParetoState.step === "define_criteria" &&
        hasThreeCriteria(effectiveParetoState)
      ) {
        return assistantResponse(
          "Perfecto ✅ Ahora asigna **pesos (1–10)** a cada criterio.\n\n" +
            "Escríbelos así:\n" +
            "- Criterio 1: 8\n" +
            "- Criterio 2: 6\n" +
            "- Criterio 3: 9",
          { ...effectiveParetoState, step: "set_weights" },
          "set_weights"
        );
      }

      if (
        effectiveParetoState.step === "set_weights" &&
        hasWeights(effectiveParetoState)
      ) {
        return assistantResponse(
          "Listo ✅ Ahora haz el **Pareto en Excel (80/20)** con tus causas.\n\n" +
            "👉 Cuando termines, vuelve y envíame la lista de **causas críticas (Top 20%)**.",
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
        return assistantResponse(
          "Te guío. En esta etapa debes priorizar tus causas raíz con el criterio de Pareto.\n\n" +
            "Haz esto:\n" +
            "1. Toma la lista de causas que ya tienes.\n" +
            "2. Asígnales un valor en tu Excel según frecuencia, impacto o el criterio que te hayan pedido.\n" +
            "3. Ordena de mayor a menor.\n" +
            "4. Calcula el acumulado.\n" +
            "5. Identifica cuáles entran en el top 20% o en el grupo crítico.\n\n" +
            "Cuando termines, pégame solo las causas críticas exactamente como aparecen en tu lista y yo te ayudo a cerrar la etapa.",
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
      return NextResponse.json(
        { ok: false, code: "INVALID_LLM_JSON", message: "LLM no devolvió JSON válido", detail: text },
        { status: 500 }
      );
    }

    const nextStateNormalized = normalizeParetoState(json.updates.nextState);
    const nextStateParsed = ParetoStateSchema.safeParse(nextStateNormalized);

    if (!nextStateParsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_NEXT_STATE",
          message: "nextState inválido devuelto por el assistant.",
          detail: nextStateParsed.error.flatten(),
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        assistantMessage: String(json.assistantMessage),
        updates: {
          nextState: nextStateParsed.data,
          action: ["init","select_roots","define_criteria","set_weights","instruct_excel","collect_critical","ask_clarify","redirect","done"].includes(json?.updates?.action)
          ? json.updates.action
          : "redirect",
                },
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error en Pareto assistant";
    return NextResponse.json({ ok: false, code: "INTERNAL", message }, { status: 500 });
  }
}
