//src/app/api/plans/ishikawa/assistant/route.ts

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, failResponse } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { assertChatOwner } from "@/lib/auth/chatOwner";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";
import {
  classifyWhyIntent,
  isNonCausalMessage,
  isProgressRequest,
  looksLikeSwitchCategoryIntent,
  normalizeIntentText,
  normalizeWhyText,
} from "@/lib/plan/ishikawaWhyInterpreter";
import {
  MAX_WHY_DEPTH,
  MIN_WHY_DEPTH,
  REJECTED_WHY_ATTEMPTS_LIMIT,
} from "@/lib/plan/rootCauseLimits";
import {
  HINT_REFORMULATE,
  interpretLlmActionabilityResponse,
  type LlmActionabilityVerdict,
} from "@/lib/plan/whyQuality";
import {
  buildIshikawaTurnUi,
  findActiveNodes,
  isClosureReviewed,
  IshikawaStateInputSchema,
  parsePendingRootMatch,
  parseRootRegistry,
  whyTexts,
  type IshikawaState,
  type PendingRootMatch,
  type RootCauseEntry,
} from "@/lib/plan/ishikawaTree";
import {
  compactIshikawaState,
  hydrateServerFields,
  mergeAssistantIshikawaState,
  serverFieldsFingerprint,
} from "@/lib/plan/ishikawaStateMerge";
import { loadStoredIshikawaState, writeIshikawaStateRow } from "@/lib/plan/ishikawaStateStore";
import {
  isCloseBranchConfirm,
  prepareLlmTurnState,
  resolveCloseConfirmation,
  resolveFastPathWhyTurn,
  resolveLlmCursorRelease,
  type BranchForJudge,
  type BranchLabels,
  type BranchNotReady,
  type ContextualBranchIntent,
  type DroppedLlmWhy,
  type EscalationReason,
  type FastPathWhyOutcome,
} from "@/lib/plan/ishikawaBranchFlow";
import { deriveRootCauses } from "@/lib/plan/ishikawaRoots";
import {
  answerPendingRootMatch,
  describeRootOccurrence,
  interpretRootMatchResponse,
  resolveBranchRoot,
  resolveDeferredRootQuestion,
  type PendingRootAnswer,
  type RootMatchCandidateInput,
  type RootMatcher,
  type RootPath,
  type RootResolution,
} from "@/lib/plan/ishikawaRootRegistry";
import { routeIshikawaTurn } from "@/lib/plan/ishikawaTurnRouter";
import {
  activeBranchPrompt,
  buildUnreviewedBranchesOffer,
  describeUnreviewedBranch,
  listUnreviewedBranches,
  resumeBranch,
  type BranchPromptKind,
  type ResumeRequest,
} from "@/lib/plan/ishikawaResume";
import { describeStageCloseGaps, evaluateIshikawaReadiness } from "@/lib/plan/ishikawaReadiness";
import {
  buildIshikawaPromptContext,
  formatCaseContextBlock,
  hasBrainstorm,
  hasFoda,
  NO_PROPER_NAMES_RULE,
  type IshikawaPromptContext,
} from "@/lib/plan/ishikawaPromptContext";
import { loadIshikawaContextSources } from "@/lib/plan/ishikawaContextStore";

export const runtime = "nodejs";

function makeRequestId() {
  return `ish_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const ISHIKAWA_DEBUG = process.env.ISHIKAWA_DEBUG === "true";

function logIshikawaDebug(event: string, payload: Record<string, unknown>) {
  if (!ISHIKAWA_DEBUG) return;

  console.log(
    `[ISHIKAWA_DEBUG] ${event}`,
    JSON.stringify(payload, null, 2)
  );
}

type RecentMessage = {
  role: "user" | "assistant";
  content: string;
};

type LooseObject = Record<string, unknown>;

const RecentMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

const BodySchema = z.object({
  studentMessage: z.string().trim().min(1).max(4000),
  // El chat se valida en el servidor (assertChatOwner) antes de leer o escribir su estado.
  chatId: z.string().uuid(),
  ishikawaState: IshikawaStateInputSchema.transform((value) => value as IshikawaState),
  caseContext: z.object({}).catchall(z.unknown()).nullable().optional(),
  stage1Summary: z.object({}).catchall(z.unknown()).nullable().optional(),
  // brainstormState ya no se recibe: la lluvia de ideas la lee el servidor (el cliente la borra
  // al entrar a E4). Si el cliente la manda, Zod la descarta.
  recentMessages: z.array(RecentMessageSchema).max(12).optional().default([]),
});

function getStringField(
  obj: LooseObject | null | undefined,
  ...keys: string[]
): string | null {
  if (!obj) return null;

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

function extractJsonSafe(raw: string) {
  if (!raw) return null;

  // 1) limpia fences tipo ```json ... ```
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // 2) intento directo
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 3) fallback: extraer el primer bloque { ... } del texto
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

function buildClarifyWhyMessage(studentMessage: string) {
  const raw = (studentMessage ?? "").trim();
  const t = raw.toLowerCase();

  const hint0 = normalizeWhyText(raw);
  const hint = hint0
    .replace(/\b(jeje+|jaja+|haha+|xd+|xD+)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const topic =
    /(pago|salari|sueldo|bono|incentiv|remuner|comisi|presup|fondos|dinero)/.test(t) ? "comp" :
    /(inter[eé]s|desmotiv|motiv|clima|cultura|actitud)/.test(t) ? "mot" :
    /(supervis|jefe|encargad|lider|control|seguim|disciplina)/.test(t) ? "lead" :
    /(manual|sop|proced|est[aá]ndar|instruct|checklist)/.test(t) ? "std" :
    /(capacit|inducci|entren|formaci)/.test(t) ? "trn" :
    /(manten|inspecci|lubric|desgaste|calibr|falla|aver[ií]a)/.test(t) ? "mnt" :
    /(recurso|tiempo|personal|apoyo)/.test(t) ? "res" :
    "gen";

  const followUpByTopic: Record<string, string> = {
    comp:
      "Cuando dices eso, ¿qué pasaba en la práctica: no se asignó presupuesto, se priorizó otra área o simplemente no se aprobó la compra? Dame el hecho más concreto que recuerdes.",
    mot:
      "Para aterrizarlo mejor, ¿eso se veía como desinterés del personal, poca disciplina o falta de compromiso sostenido? Cuéntame qué pasaba en la práctica.",
    lead:
      "Para bajarlo a algo más concreto, ¿el problema era que nadie hacía seguimiento, que no había responsable claro o que no se revisaba el cumplimiento? Dímelo con un ejemplo de lo que ocurría.",
    std:
      "Para precisarlo, ¿el problema era que no existía un procedimiento claro, que cada uno lo hacía distinto o que no se verificaba su cumplimiento? Dímelo con un caso concreto.",
    trn:
      "Para aterrizarlo, ¿faltaba capacitación inicial, práctica supervisada o refuerzo del método? Dime qué ocurría realmente en el puesto.",
    mnt:
      "Para concretarlo mejor, ¿había fallas recurrentes, falta de inspección o ausencia de mantenimiento preventivo? Dime qué pasaba realmente.",
    res:
      "Para volverlo más útil, dime si el problema real era falta de presupuesto, falta de tiempo, falta de personal o saturación de trabajo. ¿Qué ocurría en tu caso?",
    gen:
      "Ayúdame a aterrizarlo con algo observable: ¿qué pasaba exactamente en la empresa que hacía que eso ocurriera?"
  };

  const opener =
    hint
      ? `Entiendo tu idea (${hint}), pero todavía está un poco general.`
      : "Entiendo tu idea, pero todavía está un poco general.";

  return (
    `${opener}\n\n` +
    `Para que sí nos sirva como causa raíz, necesito bajarlo a algo que se pueda observar dentro de la empresa.\n\n` +
    `${followUpByTopic[topic] ?? followUpByTopic.gen}`
  );
}


async function llmText(prompt: string) {
  const model = getGeminiModel();
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function geminiText(args: { system: string; prompt: string; temperature?: number }) {
  const model = getGeminiModel();
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: `${args.system}\n\n${args.prompt}` }],
      },
    ],
    generationConfig: { temperature: args.temperature ?? 0.2 },
  });
  return result.response.text();
}

function buildRecentMessagesDigest(recentMessages: RecentMessage[]) {
  return recentMessages
    .slice(-6)
    .map((message) => {
      const speaker = message.role === "assistant" ? "Asistente" : "Estudiante";
      const content = String(message.content ?? "").trim().slice(0, 280);
      return content ? `${speaker}: ${content}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function hasCategorySwitchVerb(text: string) {
  const t = normalizeIntentText(text);

  return [
    "pasemos a",
    "vamos a",
    "vamos con",
    "sigamos con",
    "continuemos con",
    "continuemos ahora en",
    "sigamos ahora en",
    "ahora con",
    "trabajemos",
    "trabajar la categoria",
    "trabajar categoria",
    "podemos trabajar",
    "quiero trabajar",
    "quiero ir a",
    "mejor pasemos a",
    "cambiemos a",
    "cambiar de categoria",
    "cambiar de rama",
    "movernos a",
    "ir a la categoria",
  ].some((signal) => t.includes(signal));
}

function looksLikeCategoryNavigationMessage(
  text: string,
  state: IshikawaState
) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;

  const explicitCategoryId = detectExplicitCategoryId(state, text);
  if (!explicitCategoryId) return false;

  const plainCategoryNames = new Set([
    "material",
    "metodo",
    "maquina",
    "hombre",
    "mano de obra",
    "medicion",
    "medida",
    "entorno",
  ]);

  if (plainCategoryNames.has(normalized)) return true;
  if (normalized.includes("categoria") || normalized.includes("rama")) return true;
  if (hasCategorySwitchVerb(normalized)) return true;

  return false;
}

async function classifyContextualBranchIntent(args: {
  studentMessage: string;
  state: IshikawaState;
  recentMessages: RecentMessage[];
}): Promise<ContextualBranchIntent> {
  if (looksLikeCategoryNavigationMessage(args.studentMessage, args.state)) {
    return "SWITCH_CATEGORY";
  }

  const whyIntent = classifyWhyIntent(args.studentMessage);
  if (whyIntent === "meta_process") return "META_PROCESS";
  if (whyIntent === "ask_guidance" || whyIntent === "ask_example") {
    return "ASK_GUIDANCE";
  }

  if (looksLikeContinueSameCategoryIntent(args.studentMessage)) {
    return "CONTINUE_SAME_CATEGORY";
  }

  const active = findActiveNodes(args.state);
  if (!active?.cat) return "OTHER";

  const recentHistory = buildRecentMessagesDigest(args.recentMessages);
  const explicitCategoryId = detectExplicitCategoryId(
    args.state,
    args.studentMessage
  );
  const explicitCategoryName = explicitCategoryId
    ? args.state.categories.find((category) => category.id === explicitCategoryId)
        ?.name ?? null
    : null;

  const system =
    `Eres un clasificador de intención conversacional para una sesión Ishikawa.\n` +
    `Devuelve SOLO una etiqueta exacta de esta lista: SWITCH_CATEGORY, META_PROCESS, ASK_GUIDANCE, ANSWER_WHY, CONTINUE_SAME_CATEGORY, OTHER.\n` +
    `No expliques nada. No uses JSON.`;

  const prompt =
    `Rama activa actual:\n` +
    `- Categoría: ${active.cat.name ?? "Sin categoría"}\n` +
    `- Causa principal: ${active.mc?.name ?? active.mc?.text ?? "Sin causa principal"}\n` +
    `- Subcausa: ${active.sc?.name ?? active.sc?.text ?? "Sin subcausa"}\n\n` +
    `Categoría mencionada explícitamente por el estudiante: ${explicitCategoryName ?? "ninguna"}\n\n` +
    `Contexto conversacional reciente:\n${recentHistory || "(sin historial reciente)"}\n\n` +
    `Último mensaje del estudiante:\n"${args.studentMessage}"\n\n` +
    `Criterios:\n` +
    `- Si el estudiante está pidiendo moverse a otra categoría o rama, devuelve SWITCH_CATEGORY.\n` +
    `- Si está pidiendo avance, resumen, validación de cierre o ubicación dentro del proceso, devuelve META_PROCESS.\n` +
    `- Si pide ayuda para redactar, aterrizar o dar ideas, devuelve ASK_GUIDANCE.\n` +
    `- Si está aportando una causa real de la rama activa, devuelve ANSWER_WHY.\n` +
    `- Si quiere seguir en la misma categoría con otra causa principal, devuelve CONTINUE_SAME_CATEGORY.\n` +
    `- Si el mensaje solo navega el flujo, NO lo clasifiques como ANSWER_WHY.\n\n` +
    `Etiqueta:`;

  try {
    const raw = await geminiText({ system, prompt, temperature: 0 });
    const label = String(raw ?? "").trim().toUpperCase();

    if (
      label === "SWITCH_CATEGORY" ||
      label === "META_PROCESS" ||
      label === "ASK_GUIDANCE" ||
      label === "ANSWER_WHY" ||
      label === "CONTINUE_SAME_CATEGORY" ||
      label === "OTHER"
    ) {
      return label as ContextualBranchIntent;
    }
  } catch {
    return "OTHER";
  }

  return "OTHER";
}

function buildSwitchCategoryResponse(
  state: IshikawaState,
  requestedCategoryId?: string | null
) {
  const nextState = ensureDefaultCategoriesIfEmpty(safeClone(state));

  if (!requestedCategoryId) {
    const available = (nextState.categories ?? [])
      .map((category) => `- ${category.name}`)
      .join("\n");

    return {
      assistantMessage:
        "Claro. Podemos cambiar de categoría sin problema.\n\n" +
        "¿Cuál quieres trabajar ahora?\n" +
        `${available}\n\n` +
        "Dime una y seguimos desde ahí con otra causa principal.",
      nextState,
    };
  }

  const targetCategory = (nextState.categories ?? []).find(
    (category) => category.id === requestedCategoryId
  );

  if (!targetCategory) {
    return {
      assistantMessage:
        "Te sigo. Pero no pude identificar bien la categoría destino.\n\n" +
        "Dime si quieres ir a Hombre, Máquina, Método, Material, Medición o Entorno.",
      nextState,
    };
  }

  nextState.cursor = { categoryId: targetCategory.id };

  return {
    assistantMessage:
      `Perfecto. Pasemos a **${targetCategory.name}**.\n\n` +
      `Ahora dime una **causa principal concreta** dentro de esa categoría y yo te ayudo a bajarla con los porqués.`,
    nextState,
  };
}

function isAdvanceToStage4Message(text: string) {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return false;

  // frases típicas que escriben cuando aceptan pasar de etapa
  const patterns = [
    "pasemos",
    "pasar a la etapa",
    "etapa 4",
    "ishikawa",
    "si",
    "sí",
    "ok",
    "okay",
    "dale",
    "arranquemos",
    "vamos",
    "continuemos",
    "siguiente",
    "listo",
  ];

  // si el mensaje es corto o claramente confirmación
  if (t.length <= 12 && patterns.includes(t)) return true;

  // o si contiene frase de avanzar
  return patterns.some((p) => t.includes(p)) && (t.includes("etapa") || t.includes("ishikawa") || t.includes("pas"));
}

function ensureDefaultCategoriesIfEmpty(state: IshikawaState): IshikawaState {
  if (state.categories?.length) return state;

  const mkCat = (id: string, name: string) => ({ id, name, mainCauses: [] });

  return {
    ...state,
    categories: [
      mkCat("cat_hombre", "Hombre"),
      mkCat("cat_maquina", "Máquina"),
      mkCat("cat_metodo", "Método"),
      mkCat("cat_material", "Material"),
      mkCat("cat_medida", "Medida"),
      mkCat("cat_entorno", "Entorno"),
    ],
  };
}

function hasAnyMainCause(state: IshikawaState) {
  return Array.isArray(state.categories) && state.categories.some((c) => Array.isArray(c.mainCauses) && c.mainCauses.length > 0);
}

function hasAnyIshikawaWork(state: IshikawaState) {
  if (state.cursor?.categoryId) return true;

  return Array.isArray(state.categories) && state.categories.some((c) =>
    (c.mainCauses ?? []).some((mc) =>
      (mc.subCauses ?? []).some((sc) => (sc.whys?.length ?? 0) > 0 || (sc.name ?? sc.text))
    )
  );
}


function guessCategoryIdFromText(state: IshikawaState, text: string): string | null {
  const t = (text ?? "").toLowerCase();

  const matchByName = (includes: string[]) =>
    state.categories?.find(c => includes.some(k => (c.name ?? "").toLowerCase().includes(k)))?.id ?? null;

  // Entorno
  if (/(ilumin|luz|ruido|temper|calor|fr[ií]o|polvo|humedad|ventil|vibraci)/.test(t)) {
    return matchByName(["entorno", "medio ambiente", "ambiente"]);
  }

  // Método
  if (/(proced|est[aá]ndar|sop|m[eé]todo|instruct|checklist|cambio de formato|set.?up|setup|sm(e|é)d)/.test(t)) {
    return matchByName(["método", "metodo"]);
  }

  // Hombre
  if (/(operari|capacit|supervisi|disciplina|turno|fatiga|motiv|error humano)/.test(t)) {
    return matchByName(["hombre", "mano de obra"]);
  }

  // Máquina
  if (/(m[aá]quina|equipo|sensor|falla|calibr|desgaste|gu[ií]a|motor|rodillo|boquilla)/.test(t)) {
    return matchByName(["máquina", "maquina"]);
  }

  // Material
  if (/(insumo|envase|botella|materia prima|tapa|etiqueta|calidad de material)/.test(t)) {
    return matchByName(["material"]);
  }

  // Medición
  if (/(medici|indicador|oee|registro|control|inspecci|dato|kpi)/.test(t)) {
    return matchByName(["medici", "medición", "medicion"]);
  }

  return null;
}

function getCategoryDisplayName(state: IshikawaState, categoryId?: string | null) {
  if (!categoryId) return null;
  const cat = (state.categories ?? []).find((c) => c.id === categoryId);
  return cat?.name ?? null;
}

function detectExplicitCategoryId(state: IshikawaState, text: string): string | null {
  const t = (text ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const matchCategory = (keywords: string[]) =>
    (state.categories ?? []).find((c) => {
      const name = (c.name ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return keywords.some((kw) => name.includes(kw));
    })?.id ?? null;

  if (/\bhombre\b|\bmano de obra\b|\bpersonal\b/.test(t)) {
    return matchCategory(["hombre", "mano de obra"]);
  }

  if (/\bmaquina\b|\bmáquina\b|\bequipo\b/.test(t)) {
    return matchCategory(["maquina", "máquina"]);
  }

  if (/\bmetodo\b|\bmétodo\b|\bproceso\b|\bprocedimiento\b/.test(t)) {
    return matchCategory(["metodo", "método"]);
  }

  if (/\bmaterial\b|\binsumo\b|\bmateria prima\b/.test(t)) {
    return matchCategory(["material"]);
  }

  if (/\bmedicion\b|\bmedición\b|\bmedida\b|\bkpi\b|\bindicador\b/.test(t)) {
    return matchCategory(["medida", "medición", "medicion"]);
  }

  if (/\bentorno\b|\bmedio ambiente\b|\bambiente\b/.test(t)) {
    return matchCategory(["entorno", "medio ambiente", "ambiente"]);
  }

  return null;
}

function looksLikeContinueSameCategoryIntent(text: string) {
  const t = (text ?? "").toLowerCase().trim();

  if (!t) return false;

  return (
    t.includes("misma categoria") ||
    t.includes("misma categoría") ||
    t.includes("seguir con la categoria") ||
    t.includes("seguir con la categoría") ||
    t.includes("continuar con la categoria") ||
    t.includes("continuar con la categoría") ||
    t.includes("sigamos con la categoria") ||
    t.includes("sigamos con la categoría") ||
    t.includes("agregar otra causa") ||
    t.includes("agregaremos otra causa") ||
    t.includes("otra causa en esa categoria") ||
    t.includes("otra causa en esa categoría")
  );
}

function resolveContinuationCategoryId(state: IshikawaState, studentMessage: string): string | null {
  const explicitCategory = detectExplicitCategoryId(state, studentMessage);
  if (explicitCategory) return explicitCategory;

  const inferred = guessCategoryIdFromText(state, studentMessage);
  if (inferred) return inferred;

  // Si no menciona una categoría explícita, usar la categoría actual del cursor
  if (state.cursor?.categoryId) return state.cursor.categoryId;

  return null;
}

function extractMainCauseCandidateFromContinuationMessage(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  let text = raw;

  // Cortar introducciones típicas de continuación
  text = text.replace(
    /^(si|sí|ok|okay|dale|listo)\s*,?\s*/i,
    ""
  );

  text = text.replace(
    /^(continuemos|continuar|sigamos|seguimos)\s+(con\s+)?(la\s+categor[ií]a\s+)?[a-záéíóúñ\s]+,?\s*/i,
    ""
  );

  text = text.replace(
    /^(con\s+otra\s+causa\s+principal\s+(que\s+ser[ií]a|ser[ií]a)?[:,]?\s*)/i,
    ""
  );

  text = text.replace(
    /^(otra\s+causa\s+(principal\s+)?ser[ií]a\s*[:,-]?\s*)/i,
    ""
  );

  text = text.replace(
    /^(otra\s+causa\s+(principal\s+)?[:,-]?\s*)/i,
    ""
  );

  text = text.trim();

  // Si quedó muy corto o sigue siendo meta, no sirve
  if (!text || text.length < 8) return null;

  const lower = text.toLowerCase();

  if (
    lower.includes("continuemos") ||
    lower.includes("sigamos") ||
    lower.includes("categoría") ||
    lower.includes("categoria") ||
    lower.includes("otra causa") ||
    lower.includes("agregaremos")
  ) {
    return null;
  }

  // Capitalización simple
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function createMainCauseNode(text: string, prefix: string) {
  return {
    id: `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: text,
    subCauses: [],
  };
}

// Palabras de navegación que justifican consultar al clasificador por IA con una subcausa
// abierta. Si el mensaje ya es una respuesta reconocida, se exige una palabra de navegación
// clara ("vamos" y "ahora" son comunes dentro de las respuestas).
const CAPTURE_NAVIGATION_WORDS = /\b(?:categoria|rama|sigamos|continuemos|pasemos|trabajemos|cambiemos)\b/;
const BRANCH_NAVIGATION_WORDS =
  /\b(?:categoria|rama|sigamos|continuemos|pasemos|trabajemos|cambiemos|vamos|ahora)\b/;

function problemTextOf(state: IshikawaState): string {
  return typeof state.problem === "string" ? state.problem : state.problem?.text ?? "";
}

// Rechazos seguidos de la subcausa activa (campo del servidor).
function activeRejectedAttempts(state: IshikawaState): number {
  return findActiveNodes(state)?.sc?.rejectedWhyAttempts ?? 0;
}

function labelOr(value: string | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  const lower = text.toLowerCase();
  return !text || lower === "causa" || lower === "subcausa" ? fallback : text;
}

// Avance del Ishikawa: mínimos para pasar a Pareto (mismas reglas que ishikawa/validate),
// causas raíz del registro, pregunta pendiente, ramas sin terminar numeradas (con ese número se
// retoman) y el árbol completo.
function buildIshikawaMap(state: IshikawaState): string {
  const readiness = evaluateIshikawaReadiness(state);
  const { entries: rootEntries } = deriveRootCauses(state);
  const unreviewed = listUnreviewedBranches(state);
  const pending = parsePendingRootMatch(state.pendingRootMatch);
  const MAX = 15; // evita que el chat se haga infinito

  const lines: string[] = [];

  lines.push("📊 Progreso del Ishikawa");
  lines.push(`Categorías completas: ${readiness.completeCategories}/${readiness.requiredCategories}`);
  lines.push(`Causas raíz identificadas: ${readiness.rootCount}/${readiness.requiredRoots}`);
  lines.push("");

  // Cada causa raíz cuenta una vez; entre paréntesis, en cuántas ramas apareció (señal de peso
  // para Pareto).
  lines.push("🧾 Causas raíz identificadas (y en cuántas ramas aparece cada una)");
  if (rootEntries.length === 0) {
    lines.push("- (todavía ninguna: una rama cuenta cuando la cerramos)");
  } else {
    for (const entry of rootEntries.slice(0, MAX)) {
      lines.push(`- ${entry.text} (${entry.occurrences} ${entry.occurrences === 1 ? "rama" : "ramas"})`);
    }
    if (rootEntries.length > MAX) lines.push(`- ... (+${rootEntries.length - MAX} más)`);
  }
  if (pending) {
    lines.push("", `❓ ${buildRootQuestionReminder(state, pending, "inline")}`);
  }
  lines.push("");

  // Ramas sin cierre revisado: no cuentan como raíz. El número es el que se usa para retomarlas.
  if (unreviewed.length > 0) {
    lines.push(`🔎 Ramas sin terminar (${unreviewed.length}); no cuentan hasta cerrarlas:`);
    for (const branch of unreviewed.slice(0, MAX)) {
      lines.push(`${branch.index}) ${describeUnreviewedBranch(branch)}`);
    }
    if (unreviewed.length > MAX) lines.push(`... (+${unreviewed.length - MAX} más)`);
    lines.push(`Para retomar una, escribe **retomar ${unreviewed[0].index}** o el nombre de la subcausa.`);
    lines.push("");
  }

  const gaps = describeStageCloseGaps(readiness);
  if (gaps.length === 0) {
    lines.push("✅ Ya cumples los mínimos para pasar a Pareto.");
  } else {
    lines.push("🧩 Para poder pasar a Pareto te falta:");
    for (const gap of gaps) lines.push(`- ${gap}`);
  }

  lines.push("");
  lines.push("📌 Estado por categoría");
  for (const category of readiness.categories) {
    const complete = category.completeMainCauses >= readiness.requiredMainCausesPerCategory;
    lines.push(
      `${complete ? "✅" : "❌"} ${category.name} — causas completas: ` +
        `${category.completeMainCauses}/${readiness.requiredMainCausesPerCategory}`
    );
  }

  lines.push("");
  lines.push("🗺️ Mapa Ishikawa (✅ = rama cerrada)");
  lines.push("");

  // Indentación solo con espacios duros (NBSP) para que el chat no la colapse.
  const nbsp = String.fromCharCode(160);
  const i2 = nbsp.repeat(2);
  const i4 = nbsp.repeat(4);
  const i8 = nbsp.repeat(8);

  for (const cat of state.categories ?? []) {
    lines.push(`▶ ${cat.name || "Categoría"}`);

    for (const mc of cat.mainCauses ?? []) {
      lines.push(`${i2}◆ ${labelOr(mc.name ?? mc.text, "(sin nombre de causa principal)")}`);

      for (const sc of mc.subCauses ?? []) {
        const closed = isClosureReviewed(sc.closure) ? " ✅" : "";
        lines.push(`${i4}- ${labelOr(sc.name ?? sc.text, "(sin nombre de subcausa)")}${closed}`);
        whyTexts(sc.whys).forEach((why, index) => lines.push(`${i8}${index + 1}) ${why}`));
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function isShortFastPathCandidate(text: string) {
  const t = (text ?? "").trim();
  if (!t) return false;

  const lower = t.toLowerCase();

  // No fast-path si está pidiendo explicación o resumen
  if (
    lower.includes("explica") ||
    lower.includes("no entiendo") ||
    lower.includes("ayuda") ||
    lower.includes("resumen") ||
    lower.includes("mapa") ||
    lower.includes("situacion actual") ||
    lower.includes("situación actual")
  ) {
    return false;
  }

  // Si es pregunta o muy largo, mejor LLM
  if (t.includes("?")) return false;
  if (t.length > 100) return false;

  return true;
}

function safeClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}


function pick<T>(arr: T[], seed: string): T {
  // pseudo-random estable por mensaje (evita repetir siempre el primero)
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

function buildVariedFollowUp(studentMessage: string) {
  const raw = (studentMessage ?? "").trim();
  const t = raw.toLowerCase();

  const key = normalizeWhyText(raw);
  const keyShort = key.length > 70 ? key.slice(0, 70).trim() + "…" : key;

  const topic =
    /(pago|salari|sueldo|bono|incentiv|remuner)/.test(t) ? "comp" :
    /(inter[eé]s|desmotiv|motiv|clima|cultura|actitud)/.test(t) ? "mot" :
    /(supervis|jefe|encargad|lider|control|seguim)/.test(t) ? "lead" :
    /(manual|sop|proced|est[aá]ndar|instruct|checklist)/.test(t) ? "std" :
    /(manten|inspecci|lubric|desgaste|calibr|falla|aver[ií]a)/.test(t) ? "mnt" :
    /(recurso|presup|dinero|tiempo|personal|apoyo)/.test(t) ? "res" :
    /(capacit|inducci|entren|formaci)/.test(t) ? "trn" :
    "gen";

  const openersBase = [
    "Bien, eso apunta a una causa plausible.",
    "Perfecto, esa pista es relevante.",
    "Ok, vamos bien: esto puede explicar parte del problema.",
    "Entendido. Esto nos ayuda a aterrizar la causa.",
    "De acuerdo; ahora lo volvemos más accionable.",
  ];

  const analysisByTopic: Record<string, string[]> = {
    comp: [
      `Esto sugiere un tema de **incentivos/remuneración** que puede afectar compromiso y disciplina operativa.`,
      `Esto parece conectado con **remuneración o incentivos**: cuando no hay reconocimiento, suele caer el control y el orden.`,
      `Esto apunta a **motivación extrínseca** (pago/bonos) y puede traducirse en menos seguimiento y más variabilidad.`,
      `Esto puede ser una causa sistémica: si la retribución no está alineada, se deteriora el desempeño sostenido.`,
    ],
    mot: [
      `Esto apunta a **motivación/cultura**: cuando el equipo no está alineado, suben desorden y retrabajos.`,
      `Esto sugiere un tema de **clima/cultura** que termina afectando disciplina y tiempos de búsqueda.`,
      `Esto parece un problema de **comportamiento organizacional**: la disciplina cae si no hay reglas claras y seguimiento.`,
      `Esto podría ser más “gestión” que “técnico”: falta de hábitos y control operativo.`,
    ],
    lead: [
      `Esto sugiere un punto de **liderazgo y control operativo** (seguimiento, roles, consecuencias).`,
      `Esto apunta a un problema de **gestión del supervisor**: sin seguimiento, el estándar se diluye.`,
      `Esto puede ser una causa raíz típica: **roles/KPIs** poco claros y control inconsistente.`,
      `Esto indica una brecha de **supervisión** que se convierte en desorden y variabilidad.`,
    ],
    std: [
      `Esto sugiere falta de **estandarización (SOP/checklist)**, lo que genera variabilidad y paros.`,
      `Esto apunta a ausencia de **procedimiento definido**, por eso el resultado depende de “quién lo hace”.`,
      `Esto es típico de falta de estándar: sin SOP, aparecen errores y tiempos perdidos por improvisación.`,
      `Esto conecta con estandarización: sin reglas claras, el proceso se vuelve variable y sube el tiempo muerto.`,
    ],
    mnt: [
      `Esto sugiere un tema de **condición del equipo / mantenimiento**, que impacta directamente en paradas.`,
      `Esto apunta a **fallas por mantenimiento/ajustes**, y suele evidenciarse en arranques inestables.`,
      `Esto puede indicar falta de **inspección preventiva** o calibración; se traduce en paros repetitivos.`,
      `Esto parece técnico: si el equipo está fuera de condición, la línea pierde disponibilidad.`,
    ],
    res: [
      `Esto apunta a una restricción de **recursos/tiempo/personal** que termina afectando el control y la ejecución.`,
      `Esto sugiere saturación: sin recursos, se sacrifica orden, capacitación o mantenimiento.`,
      `Esto suele ser causa raíz: falta de capacidad para sostener disciplina operativa.`,
      `Esto conecta con la gestión diaria: cuando falta tiempo/personal, el estándar se deja de cumplir.`,
    ],
    trn: [
      `Esto sugiere una brecha de **capacitación/inducción**, que genera variabilidad en cómo se trabaja.`,
      `Esto apunta a falta de **formación operativa**, por eso hay diferencias entre operadores.`,
      `Esto suele generar errores y tiempos muertos: sin entrenamiento, el proceso no se ejecuta igual.`,
      `Esto conecta con estandarización + entrenamiento: si no se enseña el método, cada uno improvisa.`,
    ],
    gen: [
      `Esto ayuda a explicar parte del tiempo muerto y la baja de eficiencia.`,
      `Esto encaja como una causa plausible dentro del Ishikawa.`,
      `Esto puede estar contribuyendo al problema, pero necesitamos concretarlo.`,
      `Esto es una buena hipótesis; ahora hay que bajarla a un mecanismo concreto.`,
    ],
  };

  const questionsByTopic: Record<string, string[]> = {
    comp: [
      "¿Qué pasa en la práctica por el tema de pago: rotación, ausentismo, baja disciplina, menor seguimiento?",
      "¿Es un tema de salario base, bonos por rendimiento, o pagos atrasados? ¿Cuál ocurre aquí?",
      "¿Cómo se refleja esto en el proceso (más retrabajo, menos orden, más tiempos de búsqueda)?",
      "¿Qué evidencia tienes (quejas, rotación, faltas, baja productividad) y desde cuándo ocurre?",
      "Si se corrigiera el incentivo/pago, ¿qué comportamiento esperas que cambie primero?",
    ],
    mot: [
      "¿Qué comportamiento observas exactamente (incumplimiento, desorden, retrabajo, falta de cuidado)?",
      "¿Hay reglas claras y consecuencias, o cada turno trabaja distinto?",
      "¿Qué indicador te muestra el impacto (tiempos de búsqueda, paros menores, retrabajo)?",
      "¿Esto ocurre en todos los turnos o solo en uno? ¿Qué cambia entre turnos?",
      "¿Qué acción concreta falta (5S, auditoría, líder de turno, rutina de control)?",
    ],
    lead: [
      "¿Qué parte del control falla: asignación de roles, seguimiento, retroalimentación, disciplina?",
      "¿Qué debería controlar el supervisor (checklist, rondas, KPI) y hoy no se controla?",
      "¿Por qué no se hace seguimiento: falta de tiempo, falta de método, falta de autoridad, falta de KPI?",
      "¿Qué evidencia lo muestra (no hay reuniones de 5 min, no hay checklist, no hay registro)?",
      "¿Quién es el dueño del área y qué rutina de control debería existir?",
    ],
    std: [
      "¿Qué parte del procedimiento no está definido (orden, limpieza, set-up, arranque, control de calidad)?",
      "¿Existe SOP y no se cumple, o directamente no existe? ¿Cuál es tu caso?",
      "¿Qué paso se hace distinto entre operadores/turnos?",
      "¿Qué evidencia hay (no hay instructivo visible, nadie sabe el estándar, no hay checklist)?",
      "Si tuvieras que escribir el checklist, ¿cuáles serían 3 puntos críticos?",
    ],
    mnt: [
      "¿Qué falla exactamente (sensor, motor, guías, ajuste, lubricación) y con qué frecuencia?",
      "¿Qué ocurre en el arranque vs. en operación continua? (solo al encender / durante el turno)",
      "¿Hay mantenimiento preventivo planificado o es solo correctivo?",
      "¿Qué evidencia tienes (paros repetidos, historial de fallas, piezas desgastadas)?",
      "¿Qué condición del equipo se deja de revisar antes de iniciar turno?",
    ],
    res: [
      "¿Qué recurso falta exactamente (tiempo, personal, herramientas, presupuesto) y en qué actividad impacta?",
      "¿Qué se está dejando de hacer por falta de tiempo (orden, capacitación, inspección, control)?",
      "¿Qué tarea se queda sin dueño cuando hay urgencias?",
      "¿Esto es constante o por picos de demanda? ¿Cuándo empeora?",
      "Si tuvieras 1 recurso adicional, ¿qué priorizarías para bajar el tiempo muerto?",
    ],
    trn: [
      "¿Qué parte de la capacitación falta (operación, arranque, ajustes, calidad, seguridad)?",
      "¿Hay inducción formal o es aprendizaje ‘por mirar’?",
      "¿Quién debería capacitar y qué material falta (SOP, guía, checklist, entrenamiento práctico)?",
      "¿En qué operación se ve más el efecto (set-up, limpieza, arranque, cambio de formato)?",
      "¿Esto afecta a nuevos ingresos o también a personal antiguo?",
    ],
    gen: [
      "¿Cuál es la razón más concreta por la que eso ocurre en tu caso?",
      "¿Qué pasa justo antes de que ocurra ese problema?",
      "¿Qué evidencia lo muestra (tiempos, registros, observación directa)?",
      "¿Ocurre siempre o en ciertos turnos/condiciones?",
      "Si tuvieras que resumirlo en una causa accionable, ¿cómo lo dirías?",
    ],
  };

  const opener = pick(openersBase, raw + "|op");
  const analysis = pick(analysisByTopic[topic] ?? analysisByTopic.gen, raw + "|a|" + topic);
  const q = pick(questionsByTopic[topic] ?? questionsByTopic.gen, raw + "|q|" + topic);

  // Respuesta corta, docente, variada, sin eco literal del mensaje
  return `${opener} ${analysis}\n${q}`;
}

function numberedWhys(whys: readonly string[]): string {
  return whys.length > 0 ? whys.map((why, index) => `${index + 1}. ${why}`).join("\n") : "(ninguno todavía)";
}

// Siguiente paso dentro de una rama (el mensaje que más ve el estudiante). Recibe el problema y
// los datos del caso (rubro, productos, áreas), la cadena guardada de la rama sin filtrar y
// cuántos rechazos seguidos lleva el estudiante en ella.
async function buildGuidedWhyStep(args: {
  studentMessage: string;
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
  whys: string[];
  maxWhyDepth: number;
  rejectedAttempts: number;
  context: IshikawaPromptContext;
  hint?: string;
}) {
  const depth = args.whys.length;
  const lastWhy = depth > 0 ? args.whys[depth - 1] : null;
  const hintBlock = args.hint
    ? `\nOrientación que debes transmitir al estudiante con tus palabras (sin copiarla literal):\n${args.hint}\n`
    : "";

  const prompt = `
Eres un asesor académico guiando un análisis Ishikawa + 5 porqués.

Estás trabajando una sola rama del árbol. Tu tarea es decidir cómo continuar la conversación
de forma natural y útil, SIN responder como robot.

Contexto del caso (úsalo para que tus preguntas y ejemplos sean de ESTE caso; no inventes datos que no estén aquí):
${formatCaseContextBlock(args.context)}

Rama actual:
- Categoría: ${args.categoryName}
- Causa principal: ${args.mainCauseName}
- Subcausa: ${args.subCauseName}
- Porqués registrados: ${depth} (mínimo ${MIN_WHY_DEPTH} antes de cerrar, máximo ${args.maxWhyDepth})
- Último porqué registrado: ${lastWhy ?? "(ninguno)"}
- Respuestas rechazadas seguidas en esta rama: ${args.rejectedAttempts}

Porqués de esta rama, del primero al último:
${numberedWhys(args.whys)}

Mensaje más reciente del estudiante:
"${args.studentMessage}"
${hintBlock}
Reglas:
- Si el último porqué todavía no es una causa raíz accionable, pregunta un nuevo “¿por qué?” centrado en ESA rama.
- Si el estudiante quedó a medio formular, ayúdalo a aterrizar la causa con 2 o 3 formulaciones plausibles y una sola pregunta final.
- Si ya lleva respuestas rechazadas en esta rama, sé más concreto: propón 2 formulaciones posibles apoyadas en el contexto del caso y pide que elija o corrija una.
- No propongas cerrar la rama ni declares que ya es la causa raíz: ese cierre lo decide una revisión de calidad aparte.
- No preguntes cosas genéricas que no tengan relación con la rama.
- No uses frases rígidas tipo “esto puede estar contribuyendo...” si no aportan.
- ${NO_PROPER_NAMES_RULE}
- Responde breve, natural y docente.
- Máximo 2 párrafos.
- No uses JSON.

Devuelve solo el mensaje final.
`;

  const text = await llmText(prompt);
  return String(text ?? "").trim();
}

// Ayuda con hipótesis dentro de la rama activa: 2-3 formulaciones plausibles para que el
// estudiante elija. La usan la ayuda pedida dentro de la rama y la escalada tras varios
// intentos fallidos seguidos. Recibe el contexto del caso, con el FODA y la lluvia de ideas
// si existen.
function buildBranchHypothesesPrompt(args: {
  situation: "asked_help" | "repeated_rejections";
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
  whys: string[];
  studentMessage: string;
  rejectedAttempts: number;
  context: IshikawaPromptContext;
}) {
  const situationLine =
    args.situation === "asked_help"
      ? "El estudiante está dentro de una rama activa y pidió ayuda para formular mejor la causa raíz."
      : `El estudiante está dentro de una rama activa y lleva ${args.rejectedAttempts} intentos seguidos sin lograr una causa concreta y accionable para el siguiente porqué.`;

  const earlierStages =
    hasFoda(args.context) || hasBrainstorm(args.context)
      ? "- si alguna debilidad del FODA o idea de la lluvia de ideas encaja con esta rama, apóyate en ella (no la copies si no encaja),\n"
      : "";

  const lastWhy = args.whys.length > 0 ? args.whys[args.whys.length - 1] : null;

  return `
Eres un asesor académico guiando un análisis Ishikawa + 5 porqués.

${situationLine}
NO debes sacarlo del flujo ni preguntarle si quiere cambiar de categoría.
Debes ayudarlo a aterrizar la MISMA rama actual.

Contexto del caso (no inventes datos que no estén aquí):
${formatCaseContextBlock(args.context, { foda: true, brainstorm: true })}

Rama:
- Categoría: ${args.categoryName}
- Causa principal: ${args.mainCauseName}
- Subcausa: ${args.subCauseName}
- Último porqué registrado: ${lastWhy ?? "(ninguno)"}

Porqués de esta rama, del primero al último:
${numberedWhys(args.whys)}

Mensaje del estudiante:
"${args.studentMessage}"

Tu objetivo:
- interpretar qué quiso decir,
- ayudarle a aterrizar la causa,
- proponer 2 o 3 formulaciones plausibles y accionables (algo que la empresa pueda cambiar: un proceso, un control, una capacitación o un responsable),
${earlierStages}- mantener la conversación natural,
- terminar con una sola pregunta concreta para que el estudiante elija o precise.

${NO_PROPER_NAMES_RULE}
Responde SOLO en texto, no JSON.
`;
}

// Juicio de accionabilidad de la cadena de porqués: una llamada, temperatura baja.
// Cualquier fallo o respuesta inválida devuelve null, que nunca cierra la rama.
async function judgeWhyActionability(args: {
  problem: string;
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
  whys: string[];
}): Promise<LlmActionabilityVerdict | null> {
  const system = `
Eres un docente de Ingeniería Industrial que revisa un análisis Ishikawa + porqués.
Decide si el ÚLTIMO porqué de la cadena ya es una causa raíz accionable.

"Accionable" significa que la empresa puede modificarlo con una acción de mejora: un
proceso, un control, una capacitación o un responsable. NO es accionable si es un síntoma,
si repite lo anterior o si depende de algo fuera del control de la empresa.

Responde EXCLUSIVAMENTE con JSON válido, sin markdown ni texto adicional:
{"actionable": boolean, "reason": string}

"reason": en segunda persona, dirigido al estudiante, máximo 2 frases, concreto y sin
jerga. Si no es accionable, dile qué le falta para serlo.
`;

  const prompt = `
Problema: ${args.problem || "(sin problema registrado)"}
Categoría: ${args.categoryName}
Causa principal: ${args.mainCauseName}
Subcausa: ${args.subCauseName}
Cadena de porqués (del primero al último):
${args.whys.map((why, index) => `${index + 1}. ${why}`).join("\n")}
`;

  try {
    const raw = await geminiText({ system, prompt, temperature: 0.1 });
    return interpretLlmActionabilityResponse(raw);
  } catch {
    return null;
  }
}

// Comparación de una causa raíz nueva contra las candidatas del registro. Solo recibe los
// textos de las raíces (sin problema ni contexto del caso).
const ROOT_MATCH_SYSTEM = `
Eres un docente de Ingeniería Industrial que revisa un diagrama de Ishikawa.
Decide si la causa raíz NUEVA expresa la MISMA falla de la empresa que alguna de las
candidatas, aunque esté redactada con otras palabras. Si solo comparten palabras pero
describen fallas distintas, no es la misma.

Responde EXCLUSIVAMENTE con JSON válido, sin markdown ni texto adicional:
{"sameAs": "<id de la candidata>" | null, "reason": string}

"reason": una frase en segunda persona, dirigida al estudiante, que explique por qué te
parecen la misma causa. Si no hay coincidencia, déjala vacía.
`;

function buildRootMatchPrompt(newRoot: string, candidates: RootMatchCandidateInput[]) {
  return (
    `Causa raíz nueva: "${newRoot}"\n\n` +
    `Candidatas:\n${candidates.map((candidate) => `- id: ${candidate.id} | "${candidate.text}"`).join("\n")}`
  );
}

const BLOCKED_WHY_INTROS: Record<EscalationReason, string> = {
  tautology: "Te entiendo, pero con eso seguimos en el mismo punto de la rama.",
  external_only:
    "Tiene sentido que eso influya, aunque así la causa queda fuera de lo que la empresa puede cambiar.",
  too_generic: "Vas por buen camino, pero así queda demasiado general para trabajarla.",
  not_actionable: "Todavía no es algo que la empresa pueda cambiar directamente.",
};

function buildBlockedWhyMessage(reason: EscalationReason, hint: string) {
  return `${BLOCKED_WHY_INTROS[reason]}\n\n${hint}`;
}

// Aviso de raíz repetida (coincidencia exacta con otra rama): se informa, no se pregunta.
function buildRepeatedRootNote(root: Extract<RootResolution, { kind: "repeated" }>) {
  const where = root.previous[0] ? describeRootOccurrence(root.nextState, root.previous[0]) : "otra rama";
  return (
    `Esta causa ya te había aparecido en **${where}**; queda registrada como repetida: ` +
    `ahora aparece en ${root.occurrences} ramas y cuenta una sola vez para el mínimo. ` +
    `En tu Pareto, que se repita es una señal de peso.`
  );
}

// Pregunta cuando la IA propone que la raíz nueva es la misma que otra ya registrada. Decide
// el estudiante, ahora o más adelante; mientras tanto quedan como distintas.
function buildRootQuestion(
  state: IshikawaState,
  newRoot: string,
  candidate: RootCauseEntry,
  reason: string
) {
  const where = candidate.occurrences[0]
    ? describeRootOccurrence(state, candidate.occurrences[0])
    : "otra rama";
  return (
    `Una pregunta sobre esta causa: se parece a otra que ya registraste en **${where}**: ` +
    `**"${candidate.canonicalText}"**.` +
    (reason ? ` ${reason}` : "") +
    `\n\n¿**"${newRoot}"** es la misma causa raíz? Responde **sí** o **no**, ahora o cuando quieras. ` +
    `Si es la misma, cuenta una sola vez; si no, quedan como dos causas distintas.`
  );
}

// Respuesta a la pregunta de causa raíz repetida. Si mientras tanto quedaron raíces por comparar
// y la IA propone otra coincidencia, se pregunta a continuación.
function buildRootAnswerMessage(
  answer: Exclude<PendingRootAnswer, { kind: "no_pending" }>,
  extra: { followUpQuestion: string | null; offer: string | null }
) {
  const head =
    answer.kind === "merged"
      ? `Listo: la registré como la misma causa raíz que **"${answer.entry.canonicalText}"**. ` +
        `Ahora aparece en ${answer.entry.occurrences.length} ramas y cuenta una sola vez para el mínimo; ` +
        `en tu Pareto, que se repita es una señal de peso.`
      : `Entendido: **"${answer.entry.canonicalText}"** y **"${answer.other.canonicalText}"** quedan como ` +
        `dos causas raíz distintas, y no te volveré a preguntar por este par.`;

  if (extra.followUpQuestion) return `${head}\n\n${extra.followUpQuestion}`;

  return [head, extra.offer, "Sigamos: puedes profundizar otra subcausa o pasar a otra categoría del Ishikawa."]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

// La pregunta pendiente en tres formas: sola (el estudiante escribió sobre ella sin un sí o un
// no claro), al final de otra respuesta (no traba la conversación) o dentro del mapa.
function buildRootQuestionReminder(
  state: IshikawaState,
  pending: PendingRootMatch,
  mode: "only" | "appended" | "inline"
) {
  const registry = parseRootRegistry(state.rootCauses);
  const provisional = registry.find((entry) => entry.id === pending.rootId);
  const candidate = registry.find((entry) => entry.id === pending.candidateId);

  const where = candidate?.occurrences[0] ? describeRootOccurrence(state, candidate.occurrences[0]) : "otra rama";
  const question =
    provisional && candidate
      ? `¿**"${provisional.canonicalText}"** es la misma causa raíz que **"${candidate.canonicalText}"** (en ${where})?`
      : "¿Las dos causas raíz que te mostré son la misma?";

  if (mode === "inline") return `Pregunta pendiente: ${question} Responde **sí** o **no**.`;

  if (mode === "appended") {
    return (
      `📌 Pregunta pendiente: ${question} Respóndeme **sí** o **no** cuando quieras; ` +
      `mientras tanto cuentan como dos causas distintas y no podemos cerrar la etapa.`
    );
  }

  return (
    `Sobre la pregunta pendiente: ${question}\n\n` +
    `Responde **sí** (es la misma y cuenta una sola vez) o **no** (son distintas).`
  );
}

// Mensaje de cierre de rama. El cliente no lee este texto: la respuesta lleva
// ui.branchJustClosed para no ofrecer el paso a Pareto en el mismo turno. Si la raíz se
// repite, se informa; si la IA la ve parecida a otra, se pregunta en lugar de las opciones.
// Si quedan ramas sin terminar, se ofrecen para retomarlas.
function buildBranchClosedMessage(args: {
  rootCause: string;
  mainCauseName: string;
  reason: string;
  root: RootResolution;
  offer: string | null;
}) {
  const head =
    `Bien, con esto cerramos esta subcausa: **"${args.rootCause}"** queda como causa raíz candidata dentro de **"${args.mainCauseName}"**.` +
    (args.reason ? ` ${args.reason}` : "");

  if (args.root.kind === "question") {
    return `${head}\n\n${buildRootQuestion(args.root.nextState, args.rootCause, args.root.candidate, args.root.reason)}`;
  }

  const repeated = args.root.kind === "repeated" ? `\n\n${buildRepeatedRootNote(args.root)}` : "";
  const offer = args.offer ? `\n\n${args.offer}` : "";

  return (
    head +
    repeated +
    offer +
    `\n\nAhora podemos hacer una de estas cosas:\n` +
    `• profundizar otra subcausa en esta misma causa principal\n` +
    `• pasar a otra categoría del Ishikawa\n` +
    (args.offer ? `• retomar una rama sin terminar\n` : "") +
    `• o, si ya lo ves suficiente, revisar si estamos listos para pasar a Pareto\n\n` +
    `Dime cómo quieres continuar y te guío.`
  );
}

function buildReformulateWhyMessage(hint: string, lastWhy: string) {
  return (
    `${hint}\n\n` +
    `Escribe de nuevo esta última causa con esa idea: **"${lastWhy}"**. La reemplazo por tu nueva versión; no agregamos otro porqué.`
  );
}

// Se pidió cerrar una rama (el estudiante o el LLM) y el gate no lo permitió: la rama
// sigue abierta y el mensaje explica qué falta.
function buildCloseNotReadyMessage(args: BranchNotReady) {
  const intro = "Todavía no podemos cerrar esta subcausa.";

  if (!args.lastWhy) {
    return (
      `${intro} Aún no tiene ningún porqué.\n\n` +
      `¿Por qué ocurre **"${args.labels.subCauseName}"** en tu caso? Dime qué pasa, dónde o cuándo.`
    );
  }

  if (args.decision === "reformulate") {
    return `${intro}\n\n${buildReformulateWhyMessage(args.hint ?? HINT_REFORMULATE, args.lastWhy)}`;
  }

  const reason =
    args.depth < MIN_WHY_DEPTH
      ? ` Lleva ${args.depth} de al menos ${MIN_WHY_DEPTH} porqués.`
      : args.judgeFailed
        ? " No pude comprobar ahora si el último porqué ya es algo que la empresa pueda cambiar."
        : "";

  return [`${intro}${reason}`, args.hint ?? "", `¿Por qué ocurre **"${args.lastWhy}"**?`]
    .filter(Boolean)
    .join("\n\n");
}

// Qué se le pide en una rama abierta: al retomarla o cuando solo acusa recibo ("ok"). Si la
// rama quedó en el tope esperando una reformulación, se pide reformular el último porqué, no
// un porqué más.
function buildBranchPromptMessage(args: {
  intro: string;
  labels: BranchLabels;
  whys: string[];
  prompt: BranchPromptKind;
}): string {
  const where = `**${args.labels.categoryName} → ${args.labels.mainCauseName} → ${args.labels.subCauseName}**`;
  const depth = args.whys.length;
  const lastWhy = depth > 0 ? args.whys[depth - 1] : null;

  if (args.prompt === "reformulate" && lastWhy) {
    return (
      `${args.intro} ${where}.\n\n` +
      `Esta rama llegó al tope de ${MAX_WHY_DEPTH} porqués y está esperando que reformules el último: **"${lastWhy}"**.\n\n` +
      `${HINT_REFORMULATE}\n\n` +
      `Escríbelo de nuevo con esa idea: reemplazo ese porqué, no agregamos un sexto.`
    );
  }

  if (!lastWhy) {
    return (
      `${args.intro} ${where}. Todavía no tiene porqués.\n\n` +
      `¿Por qué ocurre **"${args.labels.subCauseName}"** en tu caso? Dime qué pasa, dónde o cuándo.`
    );
  }

  const closeHint =
    depth >= MIN_WHY_DEPTH
      ? "\n\nSi te parece que ese último porqué ya es algo que la empresa puede cambiar, escribe **cerremos** y lo reviso."
      : "";

  return (
    `${args.intro} ${where}. Lleva ${depth} ${depth === 1 ? "porqué" : "porqués"}; el último es **"${lastWhy}"**.\n\n` +
    `¿Por qué ocurre eso?${closeHint}`
  );
}

// Un acuse ("ok", "gracias") con una subcausa abierta: se vuelve a mostrar lo pendiente.
function buildActiveBranchReprompt(state: IshikawaState): string {
  const active = activeBranchPrompt(state);
  if (!active) return buildUnknownIntentMessage(state).assistantMessage;

  return buildBranchPromptMessage({
    intro: "Sigamos con",
    labels: active.labels,
    whys: active.whys,
    prompt: active.prompt,
  });
}

// Ramas sin terminar para ofrecer retomarlas (sin la rama activa), o null si no hay.
function unreviewedOffer(state: IshikawaState): string | null {
  return buildUnreviewedBranchesOffer(listUnreviewedBranches(state), {
    activePath: activeBranchPrompt(state)?.path ?? null,
  });
}

// Pedido de retomar una rama: mueve el cursor (sin IA) y pide lo que corresponda, o muestra las
// opciones si no quedó claro cuál.
function buildResumeResponse(
  state: IshikawaState,
  request: ResumeRequest
): { assistantMessage: string; updates: { nextState: IshikawaState } } {
  if (request.kind === "nothing_pending") {
    return {
      assistantMessage:
        "No te quedan ramas sin terminar: las que tienen porqués ya están cerradas.\n\n" +
        "Puedes agregar una causa nueva o, si ya llegaste al mínimo, pedirme pasar a Pareto.",
      updates: { nextState: state },
    };
  }

  if (request.kind === "resume") {
    const outcome = resumeBranch(state, request.branch.path);
    if (outcome.kind === "resumed") {
      return {
        assistantMessage: buildBranchPromptMessage({
          intro: "Retomemos",
          labels: outcome.branch.labels,
          whys: outcome.branch.whys,
          prompt: outcome.prompt,
        }),
        updates: { nextState: outcome.nextState },
      };
    }
  }

  const options = request.kind === "choose" ? request.options : listUnreviewedBranches(state);
  const intro =
    request.kind === "choose" && request.reason === "ambiguous"
      ? "Hay más de una rama con ese nombre. ¿Cuál quieres retomar?"
      : request.kind === "choose" && request.reason === "no_reference"
        ? "¿Qué rama quieres retomar? Estas están sin terminar:"
        : "No encontré esa rama entre las que están sin terminar. Estas son:";

  const lines = options.slice(0, 10).map((branch) => `${branch.index}) ${describeUnreviewedBranch(branch)}`);
  const example = options[0]?.index ?? 1;

  return {
    assistantMessage:
      `${intro}\n${lines.join("\n")}\n\n` +
      `Escribe **retomar** y el número (por ejemplo, **retomar ${example}**) o el nombre de la subcausa.`,
    updates: { nextState: state },
  };
}

// "Pasemos a Pareto": qué falta, con las mismas reglas que ishikawa/validate, o la confirmación
// de que ya se puede validar (el cliente ofrece el paso con ui.offerStageClose).
function buildStageAdvanceMessage(state: IshikawaState): string {
  const readiness = evaluateIshikawaReadiness(state);
  const gaps = describeStageCloseGaps(readiness);

  if (gaps.length === 0) {
    return (
      `✅ Ya cumples los mínimos del Ishikawa: ${readiness.rootCount} causas raíz y ` +
      `${readiness.completeCategories} categorías completas.\n\n` +
      `Si quieres pasar a la Etapa 5 (Pareto), confírmamelo y lo valido.`
    );
  }

  return [
    "Todavía no podemos pasar a Pareto. Te falta:",
    gaps.map((gap) => `- ${gap}`).join("\n"),
    unreviewedOffer(state),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

// Avance ("muéstrame el avance", "¿qué me falta?"): el mapa y cómo seguir.
function buildMapResponse(state: IshikawaState): {
  assistantMessage: string;
  updates: { nextState: IshikawaState };
} {
  const nextState = ensureDefaultCategoriesIfEmpty(state);
  const active = activeBranchPrompt(nextState);
  const currentCategoryName = getCategoryDisplayName(nextState, nextState.cursor?.categoryId);

  const followUp = active
    ? `\n\n👉 Seguimos en **${active.labels.subCauseName}** cuando quieras: responde el porqué pendiente, o escribe **retomar** y el número de otra rama.`
    : currentCategoryName
      ? `\n\n👉 Si quieres, podemos continuar ahora mismo en **${currentCategoryName}** agregando otra causa principal.`
      : "";

  return { assistantMessage: buildIshikawaMap(nextState) + followUp, updates: { nextState } };
}

// Porqués que el LLM quiso agregar en una rama que ya existía y no pasaron el filtro de calidad:
// se le dice al estudiante con la pista, igual que en la ruta rápida.
function buildDroppedWhysNote(dropped: readonly DroppedLlmWhy[]): string | null {
  const shown = dropped.filter((item) => item.existingBranch);
  if (shown.length === 0) return null;

  return shown.map((item) => `No registré **"${item.text}"** como porqué: ${item.hint}`).join("\n\n");
}

// whysReplace solo vale para el guardado del turno en que se reemplazó un porqué. El
// cliente puede reenviarlo en turnos siguientes, así que se descarta al entrar.
function clearWhysReplaceFlags(state: IshikawaState): IshikawaState {
  const cloned = safeClone(state);

  for (const cat of cloned.categories ?? []) {
    for (const mc of cat.mainCauses ?? []) {
      for (const sc of mc.subCauses ?? []) {
        delete sc.whysReplace;
      }
    }
  }

  return cloned;
}

type IshikawaIntent =
  | "SHOW_MAP"
  | "HELP"
  | "ADVANCE_STAGE"
  | "CLOSE_BRANCH"
  | "NON_CAUSAL"
  | "CAUSE_OR_WHY"
  | "UNKNOWN";

type IshikawaTurnAction =
  | "show_map"
  | "resume_branch"
  | "switch_category"
  | "continue_same_category"
  | "ask_help_inside_branch"
  | "ask_meta_inside_branch"
  | "capture_why_answer"
  | "capture_new_main_cause"
  | "capture_problem"
  | "advance_stage_intro"
  | "close_branch"
  | "fallback_llm";

function classifyIntentRules(msgLower: string): IshikawaIntent {
  if (!msgLower.trim()) return "UNKNOWN";

  // Confirmación explícita de cierre de rama.
  if (isCloseBranchConfirm(msgLower)) return "CLOSE_BRANCH";

  // Avance, mapa o "¿qué me falta?" (sin confundirlo con una causa que menciona un mapa o un
  // resumen).
  if (isProgressRequest(msgLower)) return "SHOW_MAP";

  const whyIntent = classifyWhyIntent(msgLower);

  if (whyIntent === "ask_guidance" || whyIntent === "ask_example") return "HELP";
  if (whyIntent === "switch_context" || whyIntent === "meta_process") return "NON_CAUSAL";

  // AVANZAR/EMPEZAR ETAPA 4 (solo pesa antes de empezar el Ishikawa)
  if (isAdvanceToStage4Message(msgLower)) return "ADVANCE_STAGE";

  // El intérprete es permisivo: un mensaje que no pide ayuda, no navega ni pregunta por el
  // proceso es una causa o un porqué, sin necesidad del clasificador por IA.
  if (whyIntent === "answer_why") return isNonCausalMessage(msgLower) ? "NON_CAUSAL" : "CAUSE_OR_WHY";

  return "UNKNOWN";
}

async function classifyIntentAI(studentMessage: string): Promise<IshikawaIntent> {
  // Clasificador mínimo: barato y estable. NO edita estado.
  const system =
    `Clasifica el mensaje del estudiante en UNA de estas etiquetas EXACTAS:\n` +
    `SHOW_MAP, HELP, ADVANCE_STAGE, CLOSE_BRANCH, NON_CAUSAL, CAUSE_OR_WHY, UNKNOWN.\n` +
    `Responde SOLO la etiqueta.`;

  const prompt =
    `Mensaje: ${studentMessage}\n\n` +
    `Etiqueta:`;

  try {
    const raw = await geminiText({ system, prompt, temperature: 0 });
    const label = (raw ?? "").trim().toUpperCase();

    if (
      label === "SHOW_MAP" ||
      label === "HELP" ||
      label === "ADVANCE_STAGE" ||
      label === "CLOSE_BRANCH" ||
      label === "NON_CAUSAL" ||
      label === "CAUSE_OR_WHY" ||
      label === "UNKNOWN"
    ) {
      return label as IshikawaIntent;
    }
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function classifyIntent(studentMessage: string): Promise<IshikawaIntent> {
  const msgLower = studentMessage.trim().toLowerCase();
  const ruleIntent = classifyIntentRules(msgLower);
  if (ruleIntent !== "UNKNOWN") return ruleIntent;

  // Si no matchea reglas, usamos IA solo para clasificar
  const aiIntent = await classifyIntentAI(studentMessage);
  return aiIntent;
}

function buildUnknownIntentMessage(state: IshikawaState) {
  const nextState = ensureDefaultCategoriesIfEmpty(state);
  const active = findActiveNodes(nextState);

  const problemText =
    typeof nextState.problem === "string"
      ? nextState.problem
      : nextState.problem?.text ?? "";

  // Mensaje fluido, sin opciones tipo bot
  // 1) Si hay rama activa: guiamos a retomar ahí
  if (active?.cat && active?.mc) {
    const catName = active.cat.name ?? "la categoría actual";
    const mcName = active.mc.name ?? active.mc.text ?? "esta causa";

    return {
      assistantMessage:
        `Te sigo 👍. Para no perder el hilo, dime qué prefieres hacer:\n\n` +
        `• Si solo quieres ver dónde vas, dime: **"muéstrame el avance"**.\n` +
        `• Si quieres continuar, sigamos en la rama actual: **${catName} → ${mcName}**.\n\n` +
        `Ahora dime una razón concreta del tipo: “ocurre porque ___” (qué pasa / dónde / cuándo).`,
      nextState,
    };
  }

  // 2) Si NO hay rama activa: pedimos una causa concreta o pedir avance
  return {
    assistantMessage:
      `Te entiendo 👍.\n\n` +
      (problemText ? `🎯 Estamos trabajando el problema: **${problemText}**.\n\n` : "") +
      `Si quieres, puedo mostrarte tu avance (dime **"muéstrame el avance"**).\n` +
      `Si lo que quieres es seguir construyendo el Ishikawa, dime una **causa concreta** del problema (qué pasa / dónde / cuándo).`,
    nextState,
  };
}

function buildActiveBranchMetaResponse(args: {
  state: IshikawaState;
  studentMessage: string;
}) {
  const nextState = ensureDefaultCategoriesIfEmpty(safeClone(args.state));
  const active = findActiveNodes(nextState);

  if (!active?.cat) {
    return {
      assistantMessage:
        "Claro. Para seguir bien el Ishikawa, dime primero en qué categoría quieres trabajar ahora.",
      nextState,
    };
  }

  const catName = active.cat.name ?? "la categoría actual";
  const mainName = active.mc?.name ?? active.mc?.text ?? "esta causa principal";
  const subName = active.sc?.name ?? active.sc?.text ?? "esta subcausa";

  const msg = args.studentMessage.toLowerCase();

  if (
    msg.includes("avance") ||
    msg.includes("que tenemos") ||
    msg.includes("qué tenemos") ||
    msg.includes("como va") ||
    msg.includes("cómo va") ||
    msg.includes("resumen")
  ) {
    return {
      assistantMessage:
        `Hasta ahora estamos trabajando en **${catName}**` +
        (active.mc ? `, dentro de la causa principal **${mainName}**` : "") +
        (active.sc ? `, y la subcausa activa es **${subName}**.` : ".") +
        `\n\nSi quieres, seguimos profundizando esta misma rama o cambiamos a otra categoría.`,
      nextState,
    };
  }

  if (
    msg.includes("ya terminamos") ||
    msg.includes("cerramos") ||
    msg.includes("ya podemos pasar") ||
    msg.includes("pasamos")
  ) {
    return {
      assistantMessage:
        `Podemos cerrarla solo si ya llegamos a una causa suficientemente concreta y accionable.\n\n` +
        `En este momento estamos en **${catName} → ${mainName}**` +
        (active.sc ? ` → ${subName}` : "") +
        `.\n\nSi quieres, te ayudo a decidir si esta rama ya está lista o si falta un porqué más.`,
      nextState,
    };
  }

  return {
    assistantMessage:
      `Te sigo. Ahora mismo estamos en **${catName}**` +
      (active.mc ? `, trabajando **${mainName}**` : "") +
      (active.sc ? ` y la subcausa **${subName}**` : "") +
      `.\n\nDime si quieres: continuar esta rama, cerrar esta subcausa o cambiar de categoría.`,
    nextState,
  };
}

function buildLLMStateContext(state: IshikawaState) {
  const cursor = state.cursor;

  // si no hay cursor devolvemos estado resumido
  if (!cursor?.categoryId) {
    return {
      cursor: null,
      categories: (state.categories ?? []).slice(0, 3).map((c) => ({
        id: c.id,
        name: c.name,
        mainCausesCount: c.mainCauses?.length ?? 0,
      })),
    };
  }

  const cat = state.categories.find(c => c.id === cursor.categoryId);
  if (!cat) return { cursor: null, categories: [] };

  const mc = cat.mainCauses.find(m => m.id === cursor.mainCauseId);
  const sc = mc?.subCauses.find(s => s.id === cursor.subCauseId);

  return {
    cursor: state.cursor,

    category: {
      id: cat.id,
      name: cat.name
    },

    mainCause: mc ? {
      id: mc.id,
      name: mc.name ?? mc.text ?? ""
    } : null,

    subCause: sc ? {
      id: sc.id,
      name: sc.name ?? sc.text ?? "",
      whys: (sc.whys ?? []).map(w => typeof w === "string" ? w : w.text)
    } : null,

    // otras categorías solo como resumen
    otherCategories: (state.categories ?? [])
      .filter(c => c.id !== cat.id)
      .slice(0, 2)
      .map(c => ({
        id: c.id,
        name: c.name,
        mainCausesCount: c.mainCauses?.length ?? 0
      }))
  };
}

function resolveIshikawaTurnAction(args: {
  studentMessage: string;
  state: IshikawaState;
  intent: IshikawaIntent;
}) : IshikawaTurnAction {
  const text = (args.studentMessage ?? "").trim();
  const state = ensureDefaultCategoriesIfEmpty(args.state);
  const active = findActiveNodes(state);
  const hasProblem =
    typeof state.problem === "string"
      ? state.problem.trim().length > 0
      : typeof state.problem?.text === "string"
        ? state.problem.text.trim().length > 0
        : false;

  const whyIntent = classifyWhyIntent(text);
  const alreadyInIshikawa = hasAnyIshikawaWork(state);

  // Solo la confirmación explícita (determinista) pide cerrar; la etiqueta CLOSE_BRANCH del
  // clasificador por IA no basta.
  const closeRequested = whyIntent === "close_request";

  if (!hasProblem) return "capture_problem";

  if (args.intent === "SHOW_MAP") return "show_map";

  if (!alreadyInIshikawa && args.intent === "ADVANCE_STAGE") {
    return "advance_stage_intro";
  }

  if (active?.sc) {
    if (closeRequested) return "close_branch";
    if (whyIntent === "switch_context") return "switch_category";
    if (whyIntent === "meta_process") return "ask_meta_inside_branch";
    if (whyIntent === "ask_guidance" || whyIntent === "ask_example") {
      return "ask_help_inside_branch";
    }

    // Todo lo demás es una respuesta al porqué: se captura y la calidad decide si sirve.
    if (whyIntent === "answer_why") return "capture_why_answer";

    return "fallback_llm";
  }

  if (alreadyInIshikawa && looksLikeSwitchCategoryIntent(text)) {
    return "switch_category";
  }

  if (alreadyInIshikawa && looksLikeContinueSameCategoryIntent(text)) {
    return "continue_same_category";
  }

  if (args.intent === "HELP") {
    return active?.mc ? "ask_help_inside_branch" : "fallback_llm";
  }

  if (closeRequested) {
    return "close_branch";
  }

  if (alreadyInIshikawa && !isNonCausalMessage(text)) {
    return "capture_new_main_cause";
  }

  return "fallback_llm";
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const userId = authed.userId;

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileError) {
      return failResponse(
        "INTERNAL",
        "No se pudo leer el perfil del estudiante.",
        500
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? authed.email ?? null,
    });

    const rawBody = await req.json().catch(() => null);
    const parsedBody = BodySchema.safeParse(rawBody);

    if (!parsedBody.success) {
      return failResponse(
        "BAD_REQUEST",
        "Payload inválido para Ishikawa.",
        400
      );
    }

    const studentMessage = parsedBody.data.studentMessage;
    const chatId = parsedBody.data.chatId;

    // Propiedad del chat verificada en el servidor (mismo mecanismo que ishikawa/state). Si el
    // chat no es del usuario, se corta aquí: no se lee ni se escribe nada.
    const ownership = await assertChatOwner(userId, chatId);
    if (!ownership.ok) {
      return failResponse(ownership.code, ownership.message, ownership.status);
    }

    const stored = await loadStoredIshikawaState(userId, chatId);
    if (!stored.ok) {
      console.error("[ISHIKAWA] lectura del estado guardado", stored.error);
      return failResponse("INTERNAL", "No se pudo leer el estado guardado de Ishikawa.", 500);
    }

    // closure, rejectedWhyAttempts y reformulateWhy se leen de la base, no del cuerpo: lo que
    // mande el cliente en esos campos se descarta antes de que el gate decida.
    const ishikawaState = hydrateServerFields(
      clearWhysReplaceFlags(parsedBody.data.ishikawaState),
      stored.value.serverSource
    );
    // Registro de raíces y pregunta pendiente siempre explícitos: al guardar, un campo
    // omitido conserva el valor anterior (así la pregunta se cierra escribiendo null).
    ishikawaState.rootCauses = parseRootRegistry(ishikawaState.rootCauses);
    ishikawaState.pendingRootMatch = parsePendingRootMatch(ishikawaState.pendingRootMatch);
    const serverFieldsAtStart = serverFieldsFingerprint(ishikawaState);

    // Respuesta de un turno. Si el turno cambió campos del servidor, antes de responder se
    // escriben en plan_stage_states: es la escritura durable, porque el guardado posterior
    // del cliente conserva esos campos de lo almacenado. Lleva además las señales de UI.
    const okTurn = async (
      payload: { assistantMessage: string; updates: { nextState: IshikawaState } },
      signals: { branchJustClosed?: boolean; rootQuestionShown?: boolean } = {}
    ) => {
      const nextState = payload.updates.nextState;

      // Pregunta pendiente de causa raíz repetida: no traba la conversación, pero se vuelve a
      // mostrar al final de cada respuesta hasta que el estudiante la conteste.
      const pendingQuestion = parsePendingRootMatch(nextState.pendingRootMatch);
      const assistantMessage =
        pendingQuestion && !signals.rootQuestionShown
          ? `${payload.assistantMessage}\n\n${buildRootQuestionReminder(nextState, pendingQuestion, "appended")}`
          : payload.assistantMessage;

      if (serverFieldsFingerprint(nextState) !== serverFieldsAtStart) {
        // Se relee justo antes de escribir para no pisar un guardado intermedio del cliente.
        const fresh = await loadStoredIshikawaState(userId, chatId);
        const saved = fresh.ok
          ? await writeIshikawaStateRow(
              userId,
              chatId,
              compactIshikawaState(mergeAssistantIshikawaState(fresh.value.exact, nextState))
            )
          : fresh;

        if (!saved.ok) {
          console.error("[ISHIKAWA] escritura de campos del servidor", saved.error);
          return failResponse(
            "INTERNAL",
            "No pude guardar el avance de esta rama. Intenta de nuevo.",
            500
          );
        }
      }

      return ok({
        assistantMessage,
        updates: payload.updates,
        ui: buildIshikawaTurnUi(nextState, { branchJustClosed: signals.branchJustClosed }),
      });
    };
    const caseContext = parsedBody.data.caseContext ?? null;
    const stage1Summary = parsedBody.data.stage1Summary ?? null;
    const recentMessages = parsedBody.data.recentMessages ?? [];
    const turnNow = new Date().toISOString();

    // Contexto del caso para los prompts (rubro, productos, áreas, FODA y lluvia de ideas). Se
    // lee de la base por el usuario de la sesión la primera vez que un prompt lo necesita; si
    // esa lectura no trae el contexto del caso, se usa el que mandó el cliente.
    let promptContextPromise: Promise<IshikawaPromptContext> | null = null;
    const getPromptContext = (): Promise<IshikawaPromptContext> => {
      if (!promptContextPromise) {
        promptContextPromise = loadIshikawaContextSources(userId, chatId).then((sources) =>
          buildIshikawaPromptContext({
            problem: problemTextOf(ishikawaState),
            caseContext: sources.caseContext ?? caseContext,
            foda: sources.foda,
            brainstorm: sources.brainstorm,
          })
        );
      }
      return promptContextPromise;
    };

    // Comparación de una raíz nueva contra las candidatas del registro (una llamada a Gemini,
    // temperatura baja). Solo recibe los textos de las raíces, sin contexto del caso.
    const matchRoots: RootMatcher = async ({ newRoot, candidates }) => {
      try {
        const raw = await geminiText({
          system: ROOT_MATCH_SYSTEM,
          prompt: buildRootMatchPrompt(newRoot, candidates),
          temperature: 0.1,
        });
        return interpretRootMatchResponse(raw, candidates.map((candidate) => candidate.id));
      } catch {
        return null;
      }
    };

    // Raíz de una rama recién cerrada contra el registro: repetida, nueva o pregunta.
    const resolveRoot = (state: IshikawaState, path: RootPath) =>
      resolveBranchRoot(
        {
          state,
          path,
          now: turnNow,
          newId: randomUUID,
          // Con otra pregunta abierta no se consulta ni se pisa: la raíz se compara después.
          canAsk: parsePendingRootMatch(state.pendingRootMatch) === null,
        },
        matchRoots
      );

    // Decisiones deterministas del comienzo del turno (sin Gemini): respuesta a la pregunta de
    // causa raíz repetida, retomar una rama, avance, pasar de etapa y, con una subcausa abierta,
    // un acuse. La confirmación de cierre y la respuesta al porqué siguen más abajo.
    const early = routeIshikawaTurn({ state: ishikawaState, message: studentMessage });
    logIshikawaDebug("EARLY_ROUTE", {
      studentMessage,
      route: early.kind,
      cursor: ishikawaState.cursor ?? null,
    });

    if (early.kind === "root_answer") {
      const resolved = answerPendingRootMatch(ishikawaState, early.answer);
      if (resolved.kind !== "no_pending") {
        // Raíces que se cerraron mientras la pregunta estaba abierta: ahora se comparan.
        const deferred = await resolveDeferredRootQuestion(
          { state: resolved.nextState, now: turnNow },
          matchRoots
        );
        const followUpQuestion =
          deferred.kind === "question"
            ? buildRootQuestion(deferred.nextState, deferred.entry.canonicalText, deferred.candidate, deferred.reason)
            : null;

        return okTurn(
          {
            assistantMessage: buildRootAnswerMessage(resolved, {
              followUpQuestion,
              offer: unreviewedOffer(deferred.nextState),
            }),
            updates: { nextState: deferred.nextState },
          },
          { rootQuestionShown: followUpQuestion !== null }
        );
      }
    }

    if (early.kind === "root_reminder") {
      const pendingQuestion = parsePendingRootMatch(ishikawaState.pendingRootMatch);
      if (pendingQuestion) {
        return okTurn(
          {
            assistantMessage: buildRootQuestionReminder(ishikawaState, pendingQuestion, "only"),
            updates: { nextState: ishikawaState },
          },
          { rootQuestionShown: true }
        );
      }
    }

    if (early.kind === "resume") {
      return okTurn(buildResumeResponse(ensureDefaultCategoriesIfEmpty(ishikawaState), early.request));
    }

    if (early.kind === "progress") {
      return okTurn(buildMapResponse(ishikawaState));
    }

    if (early.kind === "stage_advance") {
      return okTurn({
        assistantMessage: buildStageAdvanceMessage(ishikawaState),
        updates: { nextState: ishikawaState },
      });
    }

    if (early.kind === "reprompt") {
      return okTurn({
        assistantMessage: sanitizeStudentPlaceholder(buildActiveBranchReprompt(ishikawaState), preferredFirstName),
        updates: { nextState: ishikawaState },
      });
    }

    const msgLower = studentMessage.trim().toLowerCase();

    const intent = await classifyIntent(studentMessage);

    const turnAction = resolveIshikawaTurnAction({
      studentMessage,
      state: ishikawaState,
      intent,
    });

    logIshikawaDebug("TURN_CLASSIFIED", {
      studentMessage,
      intent,
      turnAction,
      cursor: ishikawaState.cursor ?? null,
    });

    // ✅ Si la intención quedó "UNKNOWN", NO dispares el prompt gigante.
    // Mejor aclaramos de forma fluida y seguimos sin romper el estado.
    if (intent === "UNKNOWN") {
      const { assistantMessage, nextState } = buildUnknownIntentMessage(ishikawaState);

      return okTurn({
        assistantMessage,
        updates: { nextState },
      });
    }


    // ✅ 1) Asegurar que el problema SIEMPRE esté en ishikawaState (si viene vacío)
    const currentProblem =
      typeof ishikawaState.problem === "string"
        ? ishikawaState.problem
        : ishikawaState.problem?.text ?? "";

    const ctxProblem =
      getStringField(caseContext, "problem", "problemText", "problema") ??
      getStringField(stage1Summary, "problem", "problemText", "problema") ??
      "";

    if (!currentProblem.trim() && ctxProblem.trim()) {
      ishikawaState.problem = { text: ctxProblem.trim() };
    }

    // Juicio de accionabilidad de una rama (una llamada a Gemini), con el problema del caso.
    const judgeBranch = (branch: BranchForJudge) =>
      judgeWhyActionability({
        problem:
          typeof ishikawaState.problem === "string"
            ? ishikawaState.problem
            : ishikawaState.problem?.text ?? "",
        ...branch,
      });

    const respondWith = (
      message: string,
      state: IshikawaState,
      signals?: { branchJustClosed?: boolean; rootQuestionShown?: boolean }
    ) =>
      okTurn(
        {
          assistantMessage: sanitizeStudentPlaceholder(message, preferredFirstName),
          updates: { nextState: state },
        },
        signals
      );

    // Redacción de un turno de la ruta rápida (la decisión es pura: resolveFastPathWhyTurn).
    // null si no hay subcausa abierta: el turno sigue por el camino general.
    const renderFastPath = async (
      fastPath: FastPathWhyOutcome,
      turnState: IshikawaState,
      answerRaw: string
    ) => {
      switch (fastPath.kind) {
        case "switch_category": {
          // Cambio de contexto/categoría: no se trata como causa.
          const switchResponse = buildSwitchCategoryResponse(
            turnState,
            detectExplicitCategoryId(turnState, answerRaw)
          );

          return okTurn({
            assistantMessage: switchResponse.assistantMessage,
            updates: { nextState: switchResponse.nextState },
          });
        }

        case "meta": {
          // Consulta meta o navegación residual: se responde según la rama activa.
          const meta = buildActiveBranchMetaResponse({ state: turnState, studentMessage: answerRaw });

          return okTurn({
            assistantMessage: meta.assistantMessage,
            updates: { nextState: meta.nextState },
          });
        }

        case "guided_help": {
          // Pide ayuda o todavía no hay una respuesta: ayuda contextual, sin guardar nada.
          const guidedHelp = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            ...fastPath.labels,
            whys: fastPath.whys,
            maxWhyDepth: MAX_WHY_DEPTH,
            rejectedAttempts: activeRejectedAttempts(turnState),
            context: await getPromptContext(),
          });

          return respondWith(guidedHelp || buildClarifyWhyMessage(answerRaw), turnState);
        }

        case "blocked":
          // Rechazo por calidad: el candidato no se guarda ni sube la profundidad.
          return respondWith(buildBlockedWhyMessage(fastPath.reason, fastPath.hint), fastPath.nextState);

        case "escalate": {
          // Varios intentos fallidos seguidos: se escala a formulaciones para elegir.
          let hypothesesHelp = "";
          try {
            hypothesesHelp = String(
              (await llmText(
                buildBranchHypothesesPrompt({
                  situation: "repeated_rejections",
                  ...fastPath.labels,
                  whys: activeBranchPrompt(fastPath.nextState)?.whys ?? [],
                  studentMessage: answerRaw,
                  rejectedAttempts: REJECTED_WHY_ATTEMPTS_LIMIT,
                  context: await getPromptContext(),
                })
              )) ?? ""
            ).trim();
          } catch {
            hypothesesHelp = "";
          }

          return respondWith(
            hypothesesHelp || buildBlockedWhyMessage(fastPath.reason, fastPath.hint),
            fastPath.nextState
          );
        }

        case "closed": {
          const root = await resolveRoot(fastPath.nextState, fastPath.path);

          return respondWith(
            buildBranchClosedMessage({
              rootCause: fastPath.rootCause,
              mainCauseName: fastPath.labels.mainCauseName,
              reason: fastPath.reason,
              root,
              offer: unreviewedOffer(root.nextState),
            }),
            root.nextState,
            { branchJustClosed: true, rootQuestionShown: root.kind === "question" }
          );
        }

        case "reformulate":
          // No se agrega un porqué más: el siguiente reemplaza al último.
          return respondWith(buildReformulateWhyMessage(fastPath.hint, fastPath.lastWhy), fastPath.nextState);

        case "ask_next": {
          const guidedMessage = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            ...fastPath.labels,
            whys: fastPath.whys,
            maxWhyDepth: MAX_WHY_DEPTH,
            hint: fastPath.hint,
            rejectedAttempts: activeRejectedAttempts(fastPath.nextState),
            context: await getPromptContext(),
          });

          return respondWith(guidedMessage || buildClarifyWhyMessage(answerRaw), fastPath.nextState);
        }

        case "no_active_subcause":
          return null;
      }
    };

    if (turnAction === "show_map") {
      return okTurn(buildMapResponse(ishikawaState));
    }

    // 0) Si el estudiante está confirmando avanzar a Etapa 4, damos introducción y arrancamos
    if (turnAction === "advance_stage_intro") {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);

      const problemText =
        typeof ishikawaState.problem === "string"
            ? ishikawaState.problem
            : ishikawaState.problem?.text ?? "";

        return okTurn({
        assistantMessage:
            "✅ **Listo, pasamos a la Etapa 4: Ishikawa + 5 Porqués.**\n\n" +
            "**¿Qué haremos?** Ordenaremos causas por categorías (6M) y profundizaremos con “¿por qué?” hasta llegar a una causa raíz.\n\n" +
            (problemText
            ? `🎯 **Problema (cabeza):** ${problemText}\n\n`
            : "") +
            "📌 **Primer paso (primer porqué desde el problema):**\n" +
            (problemText
            ? `¿**Por qué ocurre** este problema? (responde con una causa concreta: qué pasa / dónde / cuándo)\n\n`
            : "¿Por qué ocurre el problema principal? (qué pasa / dónde / cuándo)\n\n") +
            "Ejemplo: “La línea baja la velocidad porque el etiquetado genera atascos en el turno tarde”.",
        updates: { nextState },
        });

    }

    // Confirmación de cierre ("cerremos", "ok, cerrar"): pasa por el gate de calidad. Solo
    // cierra con veredicto accionable explícito; si no, explica qué falta sin cerrar.
    if (turnAction === "close_branch") {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
      const closeOutcome = await resolveCloseConfirmation(
        { state: nextState, now: turnNow },
        judgeBranch
      );

      if (closeOutcome.kind === "closed") {
        const root = await resolveRoot(closeOutcome.nextState, closeOutcome.path);

        return okTurn(
          {
            assistantMessage: sanitizeStudentPlaceholder(
              buildBranchClosedMessage({
                rootCause: closeOutcome.rootCause,
                mainCauseName: closeOutcome.labels.mainCauseName,
                reason: closeOutcome.reason,
                root,
                offer: unreviewedOffer(root.nextState),
              }),
              preferredFirstName
            ),
            updates: { nextState: root.nextState },
          },
          { branchJustClosed: true, rootQuestionShown: root.kind === "question" }
        );
      }

      if (closeOutcome.kind === "not_ready") {
        return okTurn({
          assistantMessage: sanitizeStudentPlaceholder(
            buildCloseNotReadyMessage(closeOutcome),
            preferredFirstName
          ),
          updates: { nextState: closeOutcome.nextState },
        });
      }

      // Sin subcausa abierta no hay rama que cerrar: se sigue en la categoría actual.
      const categoryId = nextState.cursor?.categoryId;
      if (categoryId) {
        const catName =
          nextState.categories.find((c) => c.id === categoryId)?.name ?? "la categoría actual";

        return okTurn({
          assistantMessage:
            `Ahora mismo no hay una subcausa abierta que cerrar.\n` +
            `Para completar **${catName}**, dime otra **causa principal** (otra rama) dentro de la misma categoría.`,
          updates: { nextState: { ...nextState, cursor: { categoryId } } },
        });
      }
    }

    // ...después de validar studentMessage e ishikawaState

    const msg = studentMessage.trim().toLowerCase();
    const alreadyInIshikawa = hasAnyIshikawaWork(ishikawaState);

    const continuationCategoryId = resolveContinuationCategoryId(
      ishikawaState,
      studentMessage
    );

    const explicitSwitchCategoryId = detectExplicitCategoryId(
      ishikawaState,
      studentMessage
    );

    const activeNodes = findActiveNodes(ishikawaState);
    const normalizedMessage = normalizeIntentText(studentMessage);

    // Respuesta al porqué con una subcausa abierta (el intérprete ya la reconoció sin exigir
    // frase causal). Antes de capturarla se descarta la navegación que las reglas no ven: una
    // categoría nombrada con verbo de cambio ("cambiemos a Máquina") o, si el mensaje trae
    // palabras de navegación, lo que diga el clasificador por IA, que solo puede sumar
    // navegación, nunca convertir la respuesta en ayuda o consulta.
    const captureCandidate =
      Boolean(activeNodes?.sc) &&
      turnAction === "capture_why_answer" &&
      !looksLikeCategoryNavigationMessage(studentMessage, ishikawaState);

    const shouldRunContextualBranchIntent =
      Boolean(activeNodes?.sc) &&
      (captureCandidate
        ? CAPTURE_NAVIGATION_WORDS.test(normalizedMessage)
        : Boolean(explicitSwitchCategoryId) || BRANCH_NAVIGATION_WORDS.test(normalizedMessage));

    const contextualBranchIntent = shouldRunContextualBranchIntent
      ? await classifyContextualBranchIntent({
          studentMessage,
          state: ishikawaState,
          recentMessages,
        })
      : null;

    const navigationByAi =
      contextualBranchIntent === "SWITCH_CATEGORY" || contextualBranchIntent === "CONTINUE_SAME_CATEGORY";

    if (captureCandidate && !navigationByAi) {
      // Se captura siempre por la ruta determinista, sea corta o larga: la calidad decide si
      // sirve como causa (rechazo con pista) y el gate si la rama se cierra.
      const nextState = ensureDefaultCategoriesIfEmpty(safeClone(ishikawaState));
      const fastPath = await resolveFastPathWhyTurn(
        { state: nextState, studentMessage, contextualIntent: null, now: turnNow },
        judgeBranch
      );

      logIshikawaDebug("CAPTURE_WHY_ANSWER", {
        studentMessage,
        outcome: fastPath.kind,
        cursor: nextState.cursor ?? null,
      });

      const rendered = await renderFastPath(fastPath, nextState, studentMessage.trim());
      if (rendered) return rendered;
    }

    logIshikawaDebug("BRANCH_CONTEXT", {
      shouldRunContextualBranchIntent,
      contextualBranchIntent,
      explicitSwitchCategoryId,
      continuationCategoryId,
      cursor: ishikawaState.cursor ?? null,
    });

    const wantsSwitchCategory =
      alreadyInIshikawa &&
      (
        looksLikeSwitchCategoryIntent(studentMessage) ||
        looksLikeCategoryNavigationMessage(studentMessage, ishikawaState) ||
        contextualBranchIntent === "SWITCH_CATEGORY"
      );

    if (wantsSwitchCategory) {
      const switchResponse = buildSwitchCategoryResponse(
        ishikawaState,
        explicitSwitchCategoryId
      );
    
      logIshikawaDebug("SWITCH_CATEGORY", {
        studentMessage,
        explicitSwitchCategoryId,
        resolvedCategoryName:
          ishikawaState.categories.find((c) => c.id === explicitSwitchCategoryId)?.name ?? null,
        cursorBefore: ishikawaState.cursor ?? null,
        cursorAfter: switchResponse.nextState.cursor ?? null,
      });

      return okTurn({
        assistantMessage: switchResponse.assistantMessage,
        updates: { nextState: switchResponse.nextState },
      });
    }

    const wantsContinueSameCategory =
      alreadyInIshikawa &&
      (
        looksLikeContinueSameCategoryIntent(studentMessage) ||
        (
          Boolean(continuationCategoryId) &&
          (
            msg.includes("continuemos") ||
            msg.includes("continuar") ||
            msg.includes("sigamos") ||
            msg.includes("seguimos") ||
            msg.includes("agregar otra causa") ||
            msg.includes("otra causa")
          )
        )
      );

    if (wantsContinueSameCategory && continuationCategoryId) {
      const nextState = ensureDefaultCategoriesIfEmpty(safeClone(ishikawaState));
      const cat = nextState.categories.find((c) => c.id === continuationCategoryId);

      if (cat) {
        const mainCauseCandidate = extractMainCauseCandidateFromContinuationMessage(studentMessage);

        // Caso A: el estudiante solo indicó que quiere seguir en esa categoría
        if (!mainCauseCandidate) {
          nextState.cursor = { categoryId: cat.id };

          return okTurn({
            assistantMessage:
              `Perfecto. Continuemos dentro de **${cat.name}**.\n\n` +
              `Ahora dime **otra causa principal** de esa categoría que también esté contribuyendo al problema.\n\n` +
              `Puede ser una idea breve y yo te ayudo a aterrizarla si hace falta.`,
            updates: { nextState },
          });
        }

        // Caso B: en el mismo mensaje ya propuso la nueva causa principal
        const duplicate = (cat.mainCauses ?? []).some((mc) => {
          const current = (mc.name ?? mc.text ?? "").toString().trim().toLowerCase();
          return current === mainCauseCandidate.trim().toLowerCase();
        });

        if (!duplicate) {
          const newMain = createMainCauseNode(mainCauseCandidate, `mc_${cat.id}`);
          cat.mainCauses = [...(cat.mainCauses ?? []), newMain];
          nextState.cursor = { categoryId: cat.id, mainCauseId: newMain.id };

          return okTurn({
            assistantMessage:
              `Bien. Tomo **${mainCauseCandidate}** como una nueva **causa principal** dentro de **${cat.name}**.\n\n` +
              `Ahora vayamos un nivel más abajo: ¿**por qué ocurre** ${mainCauseCandidate.toLowerCase()} en tu caso?`,
            updates: { nextState },
          });
        }

        // Caso C: ya existe; retomamos esa rama
        const existing = (cat.mainCauses ?? []).find((mc) => {
          const current = (mc.name ?? mc.text ?? "").toString().trim().toLowerCase();
          return current === mainCauseCandidate.trim().toLowerCase();
        });

        if (existing) {
          nextState.cursor = { categoryId: cat.id, mainCauseId: existing.id };

          return okTurn({
            assistantMessage:
              `Esa causa ya la tenemos dentro de **${cat.name}**.\n\n` +
              `Sigamos profundizando esa misma rama: ¿**por qué ocurre** ${mainCauseCandidate.toLowerCase()} en tu caso?`,
            updates: { nextState },
          });
        }
      }
    }

    // Ruta rápida para mensajes cortos con una subcausa abierta que no son una respuesta
    // (navegación, consulta o ayuda): la decisión es pura y aquí solo se redacta. Las
    // respuestas al porqué ya se capturaron arriba, sin importar su largo.
    if (alreadyInIshikawa && isShortFastPathCandidate(studentMessage)) {
      const nextState = ensureDefaultCategoriesIfEmpty(safeClone(ishikawaState));
      const answerRaw = studentMessage.trim();
      const fastPath = await resolveFastPathWhyTurn(
        {
          state: nextState,
          studentMessage,
          contextualIntent: contextualBranchIntent,
          now: turnNow,
        },
        judgeBranch
      );

      logIshikawaDebug("ACTIVE_BRANCH_FAST_PATH", {
        answerRaw,
        outcome: fastPath.kind,
        contextualBranchIntent,
        cursor: nextState.cursor ?? null,
      });

      const rendered = await renderFastPath(fastPath, nextState, answerRaw);
      if (rendered) return rendered;
    }

    // 1) TRANSICIÓN: SOLO si todavía NO empezamos Ishikawa
    const isTransitionToStage4 =
    !alreadyInIshikawa &&
    (
        /^(ok|dale|listo|ya|si|sí)\b/.test(msg) ||
        msg.includes("pasemos a etapa 4") ||
        msg.includes("pasemos a la etapa 4") ||
        msg.includes("etapa 4") ||
        msg.includes("ishikawa") ||
        msg.includes("diagrama") ||
        msg.includes("siguiente etapa") ||
        msg.includes("arranquemos") ||
        msg.includes("empecemos")
    );

    // 2) AYUDA: SOLO si YA estamos en Ishikawa
    const isHelpInsideIshikawa =
    alreadyInIshikawa &&
    (
        msg.includes("explica") ||
        msg.includes("no entiendo") ||
        msg.includes("que sigue") ||
        msg.includes("qué sigue") ||
        msg.includes("ayuda")
    );

    if (intent === "HELP" && alreadyInIshikawa) {
      const active = findActiveNodes(ishikawaState);

      // Si hay una rama activa, la ayuda debe ocurrir DENTRO de esa rama,
      // no redirigir al estudiante fuera del flujo.
      if (active?.cat && active?.mc && active?.sc) {
        const catName = active.cat.name ?? "la categoría actual";
        const mainName = active.mc.name ?? active.mc.text ?? "esta causa principal";
        const subName = active.sc.name ?? active.sc.text ?? "esta subcausa";

        const guidancePrompt = buildBranchHypothesesPrompt({
          situation: "asked_help",
          categoryName: catName,
          mainCauseName: mainName,
          subCauseName: subName,
          whys: whyTexts(active.sc.whys),
          studentMessage,
          rejectedAttempts: active.sc.rejectedWhyAttempts ?? 0,
          context: await getPromptContext(),
        });

        const guidedHelp = await llmText(guidancePrompt);

        return okTurn({
          assistantMessage: sanitizeStudentPlaceholder(
            String(guidedHelp ?? "").trim(),
            preferredFirstName
          ),
          updates: { nextState: ishikawaState },
        });
      }

      return okTurn({
        assistantMessage:
          "Claro. Sigamos paso a paso dentro del Ishikawa.\n\n" +
          "Cuéntame una causa concreta del problema y yo te ayudo a ubicarla y profundizarla con los porqués.",
        updates: { nextState: ishikawaState },
      });
    }

    // Contexto real del caso (rubro, productos, áreas, FODA y lluvia de ideas, leídos por el
    // servidor). Las instrucciones de coherencia solo nombran lo que el prompt recibe.
    const promptContext = await getPromptContext();
    const earlierStagesAvailable = [
      hasFoda(promptContext) ? "el FODA (Etapa 2)" : null,
      hasBrainstorm(promptContext) ? "la lluvia de ideas (Etapa 3)" : null,
    ].filter((item): item is string => item !== null);
    const coherenceWith =
      earlierStagesAvailable.length > 0
        ? `el contexto del caso, la problemática y ${earlierStagesAvailable.join(" y ")}`
        : "el contexto del caso y la problemática";

    const system = `
    Eres OPT-IA (asesor académico) guiando la ETAPA 4: DIAGRAMA ISHIKAWA + 5 POR QUÉS.

    Objetivo:
    - Construir un Ishikawa coherente con ${coherenceWith}.
    - Profundizar con "¿por qué?" hasta llegar a causas raíz (registradas como lista whys[] dentro de una subcausa).

    Reglas de interacción:
    - Conversación natural (sin formularios), breve y clara.
    - NO inventes datos del caso. Si falta info, pregunta 1 cosa concreta.
    - Mantén coherencia con ${coherenceWith}.
    - ${NO_PROPER_NAMES_RULE}
    - Tu salida SIEMPRE debe ser JSON válido y SOLO JSON (sin markdown).
    - Si el estudiante pide "pasar a etapa 4", "qué sigue" o pide explicación del Ishikawa, responde con una explicación corta (para novatos) y cómo trabajaremos, y devuelve nextState sin cambios.
    - Aunque no haya cambios en el diagrama, SIEMPRE devuelve JSON con assistantMessage y updates.nextState válido.

    Estilo docente (OBLIGATORIO):
    - Habla como un asesor humano (tono amable, didáctico, natural).
    - Estructura sugerida (sin etiquetas fijas):
    1) Una frase corta que conecte lo que dijo el estudiante con el problema (impacto en OEE/tiempo muerto/calidad).
    2) Luego una pregunta concreta para profundizar (idealmente “¿Por qué...?” o “¿Qué provoca...?”).
    - NO uses literalmente “Análisis:” ni “Siguiente pregunta:” como encabezados visibles.
    - Varía el inicio (ejemplos de arranque):
    - “Tiene sentido, porque…”
    - “Buena pista: eso suele generar…”
    - “Ok, eso explicaría que…”
    - “Perfecto, vayamos un nivel más abajo…”
    - Si el estudiante dice “no sé”, ofrece 2–3 hipótesis generales (sin inventar datos del caso) y pregunta cuál aplica.


    Estructura (IshikawaState):
    - categories[]: categorías (ideal 6M: Hombre, Máquina, Método, Material, Medida, Entorno).
    - mainCauses[] dentro de cada categoría.
    - subCauses[] dentro de cada causa principal.
    - whys[] dentro de cada subcausa para registrar los “por qué” (mínimo ${MIN_WHY_DEPTH} antes de cerrar una rama, máximo ${MAX_WHY_DEPTH}).

    Mínimos (orientativos, guía):
    - minCategories: ideal 5 (6M).
    - Por categoría: mínimo 3 causas principales. 
    - Si el estudiante tiene otra idea sólida, llegar a 4 (preguntar explícitamente si desea agregar una 4ta).
    - Por causa principal: 2-3 subcausas.
    - Profundidad: ${MIN_WHY_DEPTH} porqués como base; llegar a ${MIN_WHY_DEPTH + 1}–${MAX_WHY_DEPTH} SOLO si aún no es causa raíz accionable.
    - Por subcausa: completar whys[] cuando el estudiante responda "por qué" (1 a ${MAX_WHY_DEPTH}).

    Tu tarea con cada mensaje del estudiante:
    1) Clasifica la intención del mensaje:
    - (A) confirmar inicio / avanzar en etapa 4
    - (B) proponer/editar una CATEGORÍA
    - (C) agregar/editar CAUSA PRINCIPAL
    - (D) agregar/editar SUBCAUSA
    - (E) responder a un “¿por qué?” para una subcausa (agregar a whys[])
    - (F) cambiar de rama (moverse a otra categoría/causa)
    2) Actualiza ishikawaState SOLO en lo necesario, preservando TODO lo existente.
    3) Si el estudiante no indica categoría, ubícala tú en la mejor categoría 6M.
    4) Si el mensaje es ambiguo, haz 1 pregunta corta y no cambies el estado.
    5) Si acabas de agregar una causa principal o subcausa nueva, actualiza cursor para apuntar a esa rama (categoryId + mainCauseId) y haz la primera pregunta de “¿por qué?”.
    6) Antes de cambiar de rama, intenta llegar a al menos ${MIN_WHY_DEPTH} respuestas en whys[] para una subcausa importante.
    7) Para la categoría actual, completa mínimo minMainCausesPerCategory causas principales antes de proponer cambiar a otra categoría.
        Si el estudiante menciona una idea que cae en otra categoría mientras la categoría actual aún no llega al mínimo:
        Reconoce la idea (sin guardarla)
        Pregunta si la anotamos para después
        Pide una causa principal adicional para completar la categoría actual.
    8) Cierre de rama y continuación (OBLIGATORIO):
        - Considera “rama lista” SOLO cuando una subcausa clave ya tiene al menos ${MIN_WHY_DEPTH} porqués y la última respuesta es accionable/sistémica (algo que la empresa puede cambiar: un proceso, un control, una capacitación o un responsable).
        - Llegar al tope de ${MAX_WHY_DEPTH} porqués NO deja lista la rama: si en el tope la última respuesta todavía no es accionable, NO cierres ni limpies el cursor; pide al estudiante que reformule ese último porqué (sin agregar otro).
        - Cuando una rama esté lista:
        1) Propón cerrar la causa raíz candidata (resumen 1 línea).
        2) Limpia el cursor para permitir ampliar el diagrama en la MISMA categoría:
            - deja cursor = { categoryId: <misma categoría> } (sin mainCauseId)
        3) Pide la siguiente acción al estudiante:
            - “¿Agregamos otra causa principal dentro de <categoría> para llegar a 3 (y quizá 4)?”

    IDs:
    - Cuando crees categorías/causas/subcausas, genera ids únicos (string) y no repitas ids.

    Reglas de enfoque (OBLIGATORIAS):
    - Si ishikawaState.cursor.categoryId y ishikawaState.cursor.mainCauseId están definidos, estamos trabajando una rama específica.
    - En ese caso NO cambies de categoría ni inicies otra causa principal en otra categoría.
    - Si el estudiante escribe algo que suena a otra categoría mientras hay cursor activo:
    1) NO lo guardes aún.
    2) Pregunta si desea: (1) seguir con la rama actual (recomendado) o (2) cambiar de rama.
    3) Solo si confirma (2), entonces actualiza cursor hacia la nueva categoría/causa y recién agrega esa nueva causa.
    - Objetivo docente: profundiza con “¿por qué?” hasta registrar al menos ${MIN_WHY_DEPTH} elementos en whys[] para una subcausa importante antes de cerrar la rama y permitir cambio.
    - En modo cursor activo, tu explicación debe referirse SOLO a la rama actual (no menciones otra categoría).
    - Cierre de causa raíz:
    - NO es obligatorio llegar al ${MAX_WHY_DEPTH}º porqué.
    - Si al llegar a ${MIN_WHY_DEPTH} porqués ya aparece una causa sistémica accionable (ej: ausencia de estándar, mantenimiento inexistente, falta de método, falta de capacitación, falta de repuestos), propón cerrarla como "causa raíz candidata".
    - Pregunta al estudiante si están de acuerdo en cerrarla y pasar a otra subcausa/rama.


    Regla de conversación (MUY IMPORTANTE):
    - Nunca respondas solo con una pregunta.
    - Antes de cada “¿por qué?”, SIEMPRE:
    1) Analiza brevemente lo que dijo el estudiante.
    2) Explica por qué esa causa tiene sentido o qué impacto tiene en el problema (OEE, eficiencia, tiempo muerto, etc.).
    3) Recién después formula el siguiente “¿por qué?”.
    - Usa un tono docente, natural, como en una clase o asesoría, no como formulario.
    - Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
    - No uses apellido ni nombre completo.
    - No repitas el nombre en todos los mensajes.
    - Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
    - Evita repetir títulos, bloques largos o encabezados de etapa si ya estamos trabajando una causa.

    Si ya existe al menos una causa principal registrada o el cursor está activo:
    - NO vuelvas a mostrar el bloque de introducción de Etapa 4.
    - Asume que la sesión ya está en curso y continúa de forma natural.

    Cuando el estudiante responde al primer “¿por qué ocurre el problema?”:
    - Interpreta su respuesta como una causa principal.
    - Relaciónala explícitamente con el problema base.
    - Luego pregunta el segundo “¿por qué?” sobre ESA causa, no sobre el problema general.


    - Si cursor está definido, tu próximo mensaje debe continuar esa rama y tu assistantMessage debe ser una pregunta de “¿por qué?” o una solicitud de subcausa relacionada (no pidas una nueva causa en otra categoría).

    Formato de respuesta (OBLIGATORIO):
    {
    "assistantMessage": "texto breve y útil para el estudiante",
    "updates": { "nextState": { ...ishikawaState completo actualizado... } }
    }

    Contexto del caso:
    ${formatCaseContextBlock(promptContext, { foda: true, brainstorm: true })}

      Cursor actual: ${JSON.stringify(ishikawaState.cursor ?? null)}

      Contexto conversacional reciente (máximo 6 mensajes):
      ${buildRecentMessagesDigest(recentMessages) || "(sin historial reciente)"}

      Estado Ishikawa (solo lo necesario):
    ${JSON.stringify({
      minMainCausesPerCategory: ishikawaState.minMainCausesPerCategory,
      minSubCausesPerMain: ishikawaState.minSubCausesPerMain,
      maxWhyDepth: ishikawaState.maxWhyDepth,
      cursor: ishikawaState.cursor ?? null,
      categories: (ishikawaState.categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        mainCauses: (c.mainCauses ?? []).map((mc) => ({
          id: mc.id,
          name: mc.name ?? mc.text ?? "",
          subCauses: (mc.subCauses ?? []).map((sc) => ({
            id: sc.id,
            name: sc.name ?? sc.text ?? "",
            whysCount: (sc.whys ?? []).length,
          })),
        })),
      })),
    })}
    `;

    const prompt = `
Mensaje del estudiante:
${studentMessage}

Responde SOLO con JSON válido (sin markdown).
`;

    const raw = await geminiText({ system, prompt, temperature: 0.2 });
    const parsed = extractJsonSafe(raw);

    if (!parsed?.assistantMessage || !parsed?.updates?.nextState) {
        const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
        const catId = guessCategoryIdFromText(nextState, studentMessage);

        const catName =
            catId ? (nextState.categories.find(c => c.id === catId)?.name ?? "la categoría adecuada") : "una categoría";

        const msg =
            catId
            ? `Ok, esto suena a **${catName}**. ¿Quieres que lo registremos como una causa principal en esa categoría?`
            : `Ok, entiendo la causa. Para ubicarla bien, dime si encaja mejor en: Hombre / Máquina / Método / Material / Medición / Entorno.`;

        return okTurn({
            assistantMessage: msg,
            updates: { nextState },
        });
    }


    // 1) Normalizar assistantMessage: a veces Gemini devuelve { "Análisis": "...", "Siguiente pregunta": "..." }
    if (parsed?.assistantMessage && typeof parsed.assistantMessage !== "string") {
    const obj = parsed.assistantMessage as any;

    const analysis =
        (typeof obj?.["Análisis"] === "string" ? obj["Análisis"] : null) ??
        (typeof obj?.["Analisis"] === "string" ? obj["Analisis"] : null) ??
        "";

    const nextQ =
        (typeof obj?.["Siguiente pregunta"] === "string" ? obj["Siguiente pregunta"] : null) ??
        (typeof obj?.["Siguiente Pregunta"] === "string" ? obj["Siguiente Pregunta"] : null) ??
        "";

    const fallback =
        (() => {
        try {
            return JSON.stringify(obj);
        } catch {
            return String(obj);
        }
        })();

    parsed.assistantMessage =
        analysis || nextQ
        ? `Análisis: ${analysis}\nSiguiente pregunta: ${nextQ}`
        : fallback;
    }

    // 2) Enforce mínimo: 1 frase conectada al mensaje del estudiante + 1 pregunta variada
    if (typeof parsed.assistantMessage === "string") {
      let m = parsed.assistantMessage.trim();

      // limpia etiquetas viejas si aparecen
      m = m.replace(/^Análisis:\s*/i, "");
      m = m.replace(/\n?Siguiente pregunta:\s*/i, "\n");

      // Si está vacío/muy corto, o suena a plantilla repetida, lo regeneramos variado
      const looksTemplate =
        /ok,\s*eso encaja/i.test(m) ||
        /p[ée]rdida de eficiencia/i.test(m) && /¿por qu[ée]/i.test(m);

      const tooShort = m.length < 30;

      const hasQuestion = /\?\s*$/.test(m);

      if (tooShort || looksTemplate) {
        parsed.assistantMessage = buildVariedFollowUp(studentMessage);
      } else if (!hasQuestion) {
        // si no termina en pregunta, le añadimos una pregunta variada conectada
        parsed.assistantMessage = `${m}\n${buildVariedFollowUp(studentMessage).split("\n").slice(1).join("\n")}`;
      } else {
        parsed.assistantMessage = m;
      }
    }

    // El LLM no escribe campos del servidor (closure, contadores, registro) ni cierra una
    // rama soltando el cursor: si suelta la subcausa activa, el cierre se valida con el gate;
    // si no pasa, el cursor se conserva y el mensaje pide lo que falta. Antes, los porqués
    // guardados se restituyen tal cual y los que agregó el LLM pasan por el mismo criterio que
    // una respuesta de la ruta rápida (prepareLlmTurnState), para que el gate decida sobre la
    // cadena real y no sobre la que devolvió el LLM.
    const prepared = prepareLlmTurnState(ishikawaState, parsed.updates.nextState as IshikawaState, turnNow);

    const cursorGate = await resolveLlmCursorRelease(
      { prevState: ishikawaState, mergedState: prepared.state, now: turnNow },
      judgeBranch
    );

    // Cierre validado: la raíz se resuelve contra el registro (repetida, nueva o pregunta).
    const root =
      cursorGate.kind === "closed" ? await resolveRoot(cursorGate.nextState, cursorGate.path) : null;

    const llmMessage = String(parsed.assistantMessage ?? "");
    const droppedNote = buildDroppedWhysNote(prepared.dropped);
    const baseMessage = droppedNote ? `${llmMessage}\n\n${droppedNote}` : llmMessage;
    const turnMessage =
      cursorGate.kind === "kept_open"
        ? buildCloseNotReadyMessage(cursorGate)
        : cursorGate.kind === "closed" && root?.kind === "question"
          ? buildBranchClosedMessage({
              rootCause: cursorGate.rootCause,
              mainCauseName: cursorGate.labels.mainCauseName,
              reason: cursorGate.reason,
              root,
              offer: null,
            })
          : root?.kind === "repeated"
            ? `${baseMessage}\n\n${buildRepeatedRootNote(root)}`
            : baseMessage;

    const finalState = root?.nextState ?? cursorGate.nextState;

    return okTurn(
      {
        assistantMessage: sanitizeStudentPlaceholder(turnMessage, preferredFirstName),
        updates: { nextState: finalState },
      },
      { branchJustClosed: cursorGate.kind === "closed", rootQuestionShown: root?.kind === "question" }
    );

    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    const requestId = makeRequestId();
    console.error("[ISHIKAWA] INTERNAL", { requestId, error: err });

    return failResponse(
      "INTERNAL",
      `Ocurrió un error interno al procesar Ishikawa. Intenta de nuevo. (ref: ${requestId})`,
      500
    );
  }
}
