//src/app/api/plans/ishikawa/assistant/route.ts

import { z } from "zod";
import { ok, failResponse } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";
import {
  classifyWhyIntent,
  sanitizeWhyCandidate,
} from "@/lib/plan/ishikawaWhyInterpreter";

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

type IshikawaWhy = string | { id?: string; text?: string };

type IshikawaCategory = {
  id: string;
  name: string;
  mainCauses: Array<{
    id: string;
    text?: string;
    name?: string;
    subCauses: Array<{
      id: string;
      text?: string;
      name?: string;
      whys?: IshikawaWhy[];
    }>;
  }>;
};

export type IshikawaState = {
  problem: { text: string } | string | null;
  categories: IshikawaCategory[];
  minCategories: number; // 4-5
  minMainCausesPerCategory: number; // 2-3
  minSubCausesPerMain: number; // 2-3
  maxWhyDepth: number; // 3-5 (prefer 3)
  cursor?: { categoryId?: string; mainCauseId?: string; subCauseId?: string } | null;
  rootCauses?: string[]; // opcional: se puede rellenar al final
};

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
  ishikawaState: z
    .object({})
    .passthrough()
    .transform((value) => value as IshikawaState),
  caseContext: z.object({}).catchall(z.unknown()).nullable().optional(),
  stage1Summary: z.object({}).catchall(z.unknown()).nullable().optional(),
  brainstormState: z.object({}).catchall(z.unknown()).nullable().optional(),
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

function countRootCandidates(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  const roots: string[] = [];

  for (const c of cats) {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];

    for (const m of mains) {
      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];

      for (const s of subs) {
        const whys = Array.isArray(s?.whys) ? s.whys : [];

        const normalizedWhys = whys
          .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
          .map((t: any) => (t ?? "").toString().trim())
          .filter(Boolean);

        // Si hay 5-porqués, la raíz candidata es el último porqué
        if (normalizedWhys.length > 0) {
          const last = normalizedWhys[normalizedWhys.length - 1];
          if (last) roots.push(last);
          continue;
        }

        // Fallback: si no hay whys, cuenta la subcausa como candidata
        const t = (s?.text ?? s?.name ?? "").toString().trim();
        if (t) roots.push(t);
      }
    }
  }

  return roots;
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

function normalizeWhyText(input: string) {
  let t = (input ?? "").trim();

  t = t.replace(/^(si|sí|pues|bueno|ok|mmm)\s*,?\s*/i, "");
  t = t.replace(/^(creo que|pienso que|diría que)\s+/i, "");
  t = t.replace(/^(porque|por que)\s+/i, "");

  if (t.length) t = t[0].toUpperCase() + t.slice(1);

  return t;
}

function isActionableWhyText(input: string) {
  const t = (input ?? "").trim().toLowerCase();
  if (!t) return false;

  if (t.length < 8) return false;

  if (
    t.includes("ayudame") ||
    t.includes("ayúdame") ||
    t.includes("como encontramos") ||
    t.includes("cómo encontramos") ||
    t.includes("como hallar") ||
    t.includes("cómo hallar") ||
    t.includes("como encontrar") ||
    t.includes("cómo encontrar") ||
    t.includes("no se como") ||
    t.includes("no sé cómo") ||
    t.includes("cual seria") ||
    t.includes("cuál sería")
  ) {
    return false;
  }

  if (
    /^(seria|sería|podria|podría|quizas|quizás|tal vez|creo que|pienso que)\b/.test(t)
  ) {
    return false;
  }

  return true;
}

function sanitizeWhyList(whys: IshikawaWhy[] | undefined): string[] {
  const rawList = Array.isArray(whys) ? whys : [];

  const cleaned = rawList
    .map((item) => (typeof item === "string" ? item : (item?.text ?? "")))
    .map((item) => sanitizeWhyCandidate(String(item ?? "")))
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeWhyText(item))
    .filter((item) => isActionableWhyText(item));

  return Array.from(new Set(cleaned.map((item) => item.trim()))); // dedup exacto
}

function sanitizeIshikawaStateForWhyQuality(state: IshikawaState): IshikawaState {
  const cloned = safeClone(state);

  cloned.categories = (cloned.categories ?? []).map((cat) => ({
    ...cat,
    mainCauses: (cat.mainCauses ?? []).map((mc) => ({
      ...mc,
      subCauses: (mc.subCauses ?? []).map((sc) => ({
        ...sc,
        whys: sanitizeWhyList(sc.whys),
      })),
    })),
  }));

  return cloned;
}

function isVagueWhyAnswer(input: string) {
  const t = (input ?? "").trim().toLowerCase();
  if (!t) return true;

  // Muy corto = probablemente poco útil
  if (t.length < 10) return true;

  // Respuestas típicas vagas
  if (
    /^(no se|no sé|ni idea|nose|quiz(a|á)|tal vez|creo|pienso|supongo|puede ser|por ahi|por ahí)/.test(t)
  ) {
    return true;
  }

  // Frases tipo "por mirar / a ojo" sin causa concreta
  if (/(por mirar|a ojo|solo mirando|me parece|como que)/.test(t)) return true;

  return false;
}

function isNonCausalMessage(input: string) {
  const t = normalizeIntentText(input);
  if (!t) return true;

  if (looksLikeSwitchCategoryIntent(t)) return true;

  if (
    t.includes("continuemos") ||
    t.includes("sigamos") ||
    t.includes("ahora trabajemos") ||
    t.includes("ahora quiero trabajar") ||
    t.includes("trabajar la categoria") ||
    t.includes("trabajar categoria") ||
    t.includes("podemos trabajar") ||
    t.includes("quiero trabajar") ||
    t.includes("quiero ir a") ||
    t.includes("pasemos a") ||
    t.includes("siguiente categoria") ||
    t.includes("otra categoria") ||
    t.includes("cambiemos de categoria") ||
    t.includes("cambiemos de rama") ||
    t.includes("cambiar de rama") ||
    t.includes("rama actual")
  ) {
    return true;
  }

  if (
    t.startsWith("que temas") ||
    t.startsWith("en que estamos") ||
    t.startsWith("que estamos viendo") ||
    t.includes("que causa estamos") ||
    t.includes("muestrame el avance") ||
    t.includes("en que rama") ||
    t.includes("donde ibamos") ||
    t.includes("retomemos")
  ) {
    return true;
  }

  return false;
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

function normalizeIntentText(text: string) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

type ContextualBranchIntent =
  | "SWITCH_CATEGORY"
  | "META_PROCESS"
  | "ASK_GUIDANCE"
  | "ANSWER_WHY"
  | "CONTINUE_SAME_CATEGORY"
  | "OTHER";

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

function looksLikeSwitchCategoryIntent(text: string) {
  const t = normalizeIntentText(text);
  if (!t) return false;

  return (
    t.includes("otra categoria") ||
    t.includes("siguiente categoria") ||
    t.includes("cambiar de categoria") ||
    t.includes("cambiar de rama") ||
    t.includes("pasemos a") ||
    t.includes("vamos a") ||
    t.includes("vamos con") ||
    t.includes("sigamos con") ||
    t.includes("continuemos con") ||
    t.includes("continuemos ahora en") ||
    t.includes("sigamos ahora en") ||
    t.includes("ahora con") ||
    t.includes("trabajemos") ||
    t.includes("trabajar la categoria") ||
    t.includes("trabajar categoria") ||
    t.includes("podemos trabajar") ||
    t.includes("quiero trabajar") ||
    t.includes("quiero ir a") ||
    t.includes("mejor pasemos a") ||
    t === "material" ||
    t === "metodo" ||
    t === "maquina" ||
    t === "hombre" ||
    t === "mano de obra" ||
    t === "medicion" ||
    t === "medida" ||
    t === "entorno"
  );
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

function extractRootCauses(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  const roots: { category: string; main: string; sub: string; root: string }[] = [];

  const clean = (x: any) => (x ?? "").toString().trim();
  const isPlaceholder = (s: string) => {
    const t = s.toLowerCase().trim();
    return !t || t === "causa" || t === "subcausa";
  };

  for (const c of cats) {
    const cName = clean(c?.name) || "(Categoría)";
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];

    for (const m of mains) {
      const mNameRaw = clean(m?.name ?? m?.text);
      const mName = isPlaceholder(mNameRaw) ? "(sin nombre de causa principal)" : mNameRaw;

      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];
      for (const s of subs) {
        const sNameRaw = clean(s?.name ?? s?.text);
        const sName = isPlaceholder(sNameRaw) ? "(sin nombre de subcausa)" : sNameRaw;

        const whys = (Array.isArray(s?.whys) ? s.whys : [])
          .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
          .map((t: any) => clean(t))
          .filter(Boolean);

        const root = whys.length > 0 ? whys[whys.length - 1] : (isPlaceholder(sNameRaw) ? "" : sNameRaw);

        if (root) {
          roots.push({ category: cName, main: mName, sub: sName, root });
        }
      }
    }
  }

  return roots;
}

function buildIshikawaMap(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];

  const minCats = state?.minCategories ?? 4;
  const minMain = state?.minMainCausesPerCategory ?? 2; // OJO: si quieres 2, cambia aquí a 2
  const minSub = state?.minSubCausesPerMain ?? 1; // recomendado 1 si usan 5-porqués

  const isPlaceholder = (s: string) => {
    const t = (s ?? "").toString().trim().toLowerCase();
    return !t || t === "causa" || t === "subcausa";
  };

  const labelMain = (mc: any) => {
    const raw = (mc?.name ?? mc?.text ?? "").toString().trim();
    return isPlaceholder(raw) ? "(sin nombre de causa principal)" : raw;
  };

  const labelSub = (sc: any) => {
    const raw = (sc?.name ?? sc?.text ?? "").toString().trim();
    return isPlaceholder(raw) ? "(sin nombre de subcausa)" : raw;
  };

  const normalizeWhys = (sc: any) => {
    const whys = Array.isArray(sc?.whys) ? sc.whys : [];
    return whys
      .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
      .map((t: any) => (t ?? "").toString().trim())
      .filter(Boolean);
  };

  // Causa raíz candidata = último porqué (si existe), si no la subcausa
  const roots: string[] = [];
  for (const c of cats) {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    for (const m of mains) {
      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];
      for (const s of subs) {
        const whys = normalizeWhys(s);
        if (whys.length > 0) {
          roots.push(whys[whys.length - 1]);
        } else {
          const t = (s?.text ?? s?.name ?? "").toString().trim();
          if (t && !isPlaceholder(t)) roots.push(t);
        }
      }
    }
  }


  // Subcausa válida si tiene nombre útil o al menos 1 porqué útil
  const isSubValid = (sc: any) => {
    const n = (sc?.name ?? sc?.text ?? "").toString().trim();
    if (n && !isPlaceholder(n)) return true;
    const whys = normalizeWhys(sc);
    return whys.length > 0;
  };

  // Causa principal completa si tiene minSub subcausas válidas
  const isMainComplete = (mc: any) => {
    const subs = Array.isArray(mc?.subCauses) ? mc.subCauses : [];
    const validSubs = subs.filter(isSubValid);
    return validSubs.length >= minSub;
  };

  // Categoría completa si tiene minMain causas principales completas
  const mainCompleteCount = (cat: any) => {
    const mains = Array.isArray(cat?.mainCauses) ? cat.mainCauses : [];
    return mains.filter(isMainComplete).length;
  };

  const completeCats = cats.filter((c: any) => mainCompleteCount(c) >= minMain);

  const lines: string[] = [];

  lines.push("📊 Progreso mínimo del Ishikawa");
  lines.push(`Categorías completas: ${completeCats.length}/${minCats}`);
  lines.push(`Causas raíz identificadas: ${roots.length}/10`);
  lines.push("");

  // 🧾 LISTA DE CAUSAS RAÍZ (para que el estudiante vea cuáles son)
  const uniqueRoots = Array.from(
    new Set(
      roots
        .map((r) => (r ?? "").toString().trim())
        .filter(Boolean)
    )
  );

  lines.push("🧾 Causas raíz identificadas (último porqué de cada rama)");
  if (uniqueRoots.length === 0) {
    lines.push("- (aún no se detectaron causas raíz)");
  } else {
    const MAX = 15; // evita que el chat se haga infinito
    for (const r of uniqueRoots.slice(0, MAX)) {
      lines.push(`- ${r}`);
    }
    if (uniqueRoots.length > MAX) {
      lines.push(`- ... (+${uniqueRoots.length - MAX} más)`);
    }
  }
  lines.push("");


  if (completeCats.length >= minCats && roots.length >= 10) {
    lines.push("✅ Ya cumples los mínimos para pasar a Pareto.");
  } else {
    lines.push("🧩 Para poder pasar a Pareto te falta:");
    if (completeCats.length < minCats) {
      lines.push(`- Completar al menos ${minCats} categorías (con ${minMain} causas principales completas cada una)`);
    }
    if (roots.length < 10) {
      lines.push(`- Identificar ${10 - roots.length} causas raíz adicionales`);
    }
  }

  lines.push("");
  lines.push("📌 Estado por categoría");
  for (const c of cats) {
    const done = mainCompleteCount(c);
    const ok = done >= minMain;
    lines.push(`${ok ? "✅" : "❌"} ${c?.name ?? "Categoría"} — causas completas: ${done}/${minMain}`);
  }

  lines.push("");
  lines.push("🗺️ Mapa Ishikawa");
  lines.push("");

  // Indentación SOLO por espacios (no líneas). Usamos NBSP para que no se colapse.
  const i2 = "\u00A0\u00A0";
  const i4 = "\u00A0\u00A0\u00A0\u00A0";
  const i6 = "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";
  const i8 = "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0";

  for (const c of cats) {
    lines.push(`▶ ${c?.name ?? "Categoría"}`);

    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    for (const mc of mains) {
      lines.push(`${i2}◆ ${labelMain(mc)}`);

      const subs = Array.isArray(mc?.subCauses) ? mc.subCauses : [];
      for (const sc of subs) {
        lines.push(`${i4}- ${labelSub(sc)}`);

        const whys = normalizeWhys(sc);
        for (let k = 0; k < whys.length; k++) {
          lines.push(`${i8}${k + 1}) ${whys[k]}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function normalizeText(x: unknown) {
  return (typeof x === "string" ? x : "").trim();
}

function mergeIshikawaState(prev: IshikawaState, incoming: IshikawaState): IshikawaState {
  // 1) Problema: no dejar que se borre
  const prevProblem =
    typeof prev.problem === "string" ? prev.problem : prev.problem?.text ?? "";
  const incProblem =
    typeof incoming.problem === "string" ? incoming.problem : incoming.problem?.text ?? "";

  const problemText = normalizeText(incProblem) || normalizeText(prevProblem);

  // 2) Categorías por ID: preservar prev y aplicar incoming por id
  const prevCats = prev.categories ?? [];
  const incCats = incoming.categories ?? [];

  const prevById = new Map(prevCats.map(c => [c.id, c]));
  const outCats: IshikawaCategory[] = [];

  // primero, recorremos incoming (aplica cambios)
  for (const ic of incCats) {
    const pc = prevById.get(ic.id);

    if (!pc) {
      // categoría nueva
      outCats.push(ic);
      continue;
    }

    // merge mainCauses por id
    const prevMainById = new Map((pc.mainCauses ?? []).map(m => [m.id, m]));
    const mergedMain: IshikawaCategory["mainCauses"] = [];

    for (const im of ic.mainCauses ?? []) {
      const pm = prevMainById.get(im.id);
      if (!pm) {
        mergedMain.push(im);
        continue;
      }

      // merge subCauses por id
      const prevSubById = new Map((pm.subCauses ?? []).map(s => [s.id, s]));
      const mergedSub: typeof pm.subCauses = [];

      for (const is of im.subCauses ?? []) {
        const ps = prevSubById.get(is.id);
        if (!ps) {
          mergedSub.push(is);
          continue;
        }

        // whys: si incoming trae whys vacío, conservar prev
        const incWhys = Array.isArray(is.whys) ? is.whys : [];
        const prevWhys = Array.isArray(ps.whys) ? ps.whys : [];
        const whys = incWhys.length ? incWhys : prevWhys;

        mergedSub.push({
          ...ps,
          ...is,
          whys,
        });

        prevSubById.delete(is.id);
      }

      // agregar subcauses que existían antes y no vinieron en incoming (no borrar)
      for (const leftover of prevSubById.values()) mergedSub.push(leftover);

      mergedMain.push({
        ...pm,
        ...im,
        subCauses: mergedSub,
      });

      prevMainById.delete(im.id);
    }

    // agregar maincauses prev que no vinieron (no borrar)
    for (const leftover of prevMainById.values()) mergedMain.push(leftover);

    outCats.push({
      ...pc,
      ...ic,
      mainCauses: mergedMain,
    });

    prevById.delete(ic.id);
  }

  // luego, agregamos categorías prev que no vinieron (no borrar)
  for (const leftover of prevById.values()) outCats.push(leftover);

  return {
    ...prev,
    ...incoming,
    problem: problemText ? { text: problemText } : prev.problem,
    categories: outCats,
  };
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

function isCloseBranchConfirm(text: string) {
  const t = (text ?? "").toLowerCase();
  return /(cerrar|cerremos|cerramos|cerrar ahi|cerrar ahí|de acuerdo cerrar|ok cerrar|si.*cerr)/.test(t);
}

function findActiveNodes(state: IshikawaState) {
  const catId = state.cursor?.categoryId;
  const mcId = state.cursor?.mainCauseId;
  const scId = state.cursor?.subCauseId;

  if (!catId || !mcId) return null;

  const cat = state.categories.find((c) => c.id === catId);
  if (!cat) return null;

  const mc = cat.mainCauses.find((m) => m.id === mcId);
  if (!mc) return null;

  const sc = scId ? mc.subCauses.find((s) => s.id === scId) : null;

  return { cat, mc, sc };
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

async function buildGuidedWhyStep(args: {
  studentMessage: string;
  categoryName: string;
  mainCauseName: string;
  subCauseName: string;
  whys: string[];
  maxWhyDepth: number;
}) {
  const depth = args.whys.length;
  const lastWhy = depth > 0 ? args.whys[depth - 1] : null;

  const prompt = `
Eres un asesor académico guiando un análisis Ishikawa + 5 porqués.

Estás trabajando una sola rama del árbol. Tu tarea es decidir cómo continuar la conversación
de forma natural y útil, SIN responder como robot.

Rama actual:
- Categoría: ${args.categoryName}
- Causa principal: ${args.mainCauseName}
- Subcausa: ${args.subCauseName}
- Why depth actual: ${depth}
- Último porqué registrado: ${lastWhy ?? "(ninguno)"}

Mensaje más reciente del estudiante:
"${args.studentMessage}"

Whys registrados hasta ahora:
${JSON.stringify(args.whys, null, 2)}

Reglas:
- Si el último porqué todavía no es una causa raíz accionable, pregunta un nuevo “¿por qué?” centrado en ESA rama.
- Si el estudiante quedó a medio formular, ayúdalo a aterrizar la causa con 2 o 3 formulaciones plausibles y una sola pregunta final.
- Si ya parece una causa raíz accionable/sistémica, puedes proponer cerrarla como raíz candidata.
- No preguntes cosas genéricas que no tengan relación con la rama.
- No uses frases rígidas tipo “esto puede estar contribuyendo...” si no aportan.
- Responde breve, natural y docente.
- Máximo 2 párrafos.
- No uses JSON.

Devuelve solo el mensaje final.
`;

  const text = await llmText(prompt);
  return String(text ?? "").trim();
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

  // MAPA / AVANCE / ESTADO
  if (
    msgLower.includes("situacion actual") ||
    msgLower.includes("situación actual") ||
    msgLower.includes("mapa") ||
    msgLower.includes("estado actual") ||
    msgLower.includes("resumen") ||
    msgLower.includes("que tenemos") ||
    msgLower.includes("qué tenemos") ||
    msgLower.includes("en que rama") ||
    msgLower.includes("en qué rama") ||
    msgLower.includes("avance") ||
    msgLower.includes("progreso") ||
    msgLower.includes("muéstrame") ||
    msgLower.includes("muestrame") ||
    msgLower.includes("hasta donde") ||
    msgLower.includes("donde continuar") ||
    msgLower.includes("dónde continuar")
  ) return "SHOW_MAP";

  // AYUDA
  if (
    msgLower.includes("ayuda") ||
    msgLower.includes("no entiendo") ||
    msgLower.includes("explica") ||
    msgLower.includes("qué sigue") ||
    msgLower.includes("que sigue")
  ) return "HELP";

  // AVANZAR/EMPEZAR ETAPA 4
  if (isAdvanceToStage4Message(msgLower)) return "ADVANCE_STAGE";

  // CERRAR RAMA
  if (isCloseBranchConfirm(msgLower)) return "CLOSE_BRANCH";

  // MENSAJE NO CAUSAL (control/navegación)
  if (isNonCausalMessage(msgLower)) return "NON_CAUSAL";

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
  const lower = text.toLowerCase();
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

  if (!hasProblem) return "capture_problem";

  if (args.intent === "SHOW_MAP") return "show_map";

  if (!alreadyInIshikawa && args.intent === "ADVANCE_STAGE") {
    return "advance_stage_intro";
  }

  if (active?.sc) {
    if (whyIntent === "switch_context") return "switch_category";
    if (whyIntent === "meta_process") return "ask_meta_inside_branch";
    if (whyIntent === "ask_guidance" || whyIntent === "ask_example") {
      return "ask_help_inside_branch";
    }

    if (!isNonCausalMessage(text)) {
      return "capture_why_answer";
    }

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

  if (args.intent === "CLOSE_BRANCH") {
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
        parsedBody.error.issues[0]?.message ?? "Payload inválido para Ishikawa.",
        400
      );
    }

    const studentMessage = parsedBody.data.studentMessage;
    const ishikawaState = parsedBody.data.ishikawaState;
    const caseContext = parsedBody.data.caseContext ?? null;
    const stage1Summary = parsedBody.data.stage1Summary ?? null;
    const brainstormState = parsedBody.data.brainstormState ?? null;
    const recentMessages = parsedBody.data.recentMessages ?? [];

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

      return ok({
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

    if (turnAction === "show_map") {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);
      const currentCategoryName = getCategoryDisplayName(nextState, nextState.cursor?.categoryId);

      const followUp =
        currentCategoryName
          ? `\n\n👉 Si quieres, podemos continuar ahora mismo en **${currentCategoryName}** agregando otra causa principal.`
          : "";

      return ok({
        assistantMessage: buildIshikawaMap(nextState) + followUp,
        updates: { nextState },
      });
    }

    // 0) Si el estudiante está confirmando avanzar a Etapa 4, damos introducción y arrancamos
    if (turnAction === "advance_stage_intro") {
      const nextState = ensureDefaultCategoriesIfEmpty(ishikawaState);

      const problemText =
        typeof ishikawaState.problem === "string"
            ? ishikawaState.problem
            : ishikawaState.problem?.text ?? "";

        return ok({
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

    const shouldRunContextualBranchIntent =
      Boolean(activeNodes?.sc) &&
      (
        Boolean(explicitSwitchCategoryId) ||
        /(?:categoria|categoría|rama|sigamos|continuemos|pasemos|ahora|trabaj|vamos)/i.test(
          studentMessage
        )
      );

    const contextualBranchIntent = shouldRunContextualBranchIntent
      ? await classifyContextualBranchIntent({
          studentMessage,
          state: ishikawaState,
          recentMessages,
        })
      : null;

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

      return ok({
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

          return ok({
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

          return ok({
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

          return ok({
            assistantMessage:
              `Esa causa ya la tenemos dentro de **${cat.name}**.\n\n` +
              `Sigamos profundizando esa misma rama: ¿**por qué ocurre** ${mainCauseCandidate.toLowerCase()} en tu caso?`,
            updates: { nextState },
          });
        }
      }
    }

    // ✅ FAST-PATH: si ya estamos en Ishikawa y el mensaje es corto, evitamos Gemini
    if (alreadyInIshikawa && isShortFastPathCandidate(studentMessage)) {
      const nextState = ensureDefaultCategoriesIfEmpty(safeClone(ishikawaState));

      // Caso 1: confirmación de cerrar rama (rápido) -> liberamos cursor a nivel categoría
      if (isCloseBranchConfirm(studentMessage) && nextState.cursor?.categoryId) {
        const cat = nextState.categories.find((c) => c.id === nextState.cursor?.categoryId);
        const catName = cat?.name ?? "la categoría actual";

        // Dejamos cursor solo en categoría (sin mainCauseId/subCauseId)
        nextState.cursor = { categoryId: nextState.cursor.categoryId };

        return ok({
          assistantMessage:
            `✅ Perfecto, cerramos esa rama como **causa raíz candidata**.\n` +
            `Para completar **${catName}**, dime otra **causa principal** (otra rama) dentro de la misma categoría.`,
          updates: { nextState },
        });
      }

      // Caso 2: respuesta corta a un "¿por qué?" si hay subcausa activa
      const active = findActiveNodes(nextState);
      if (active?.sc) {
        const sc = active.sc;
        const whysArr = sanitizeWhyList(sc.whys);

        const answerRaw = studentMessage.trim();
        const whyIntent = classifyWhyIntent(answerRaw);

        logIshikawaDebug("ACTIVE_BRANCH_FAST_PATH", {
          answerRaw,
          whyIntent,
          contextualBranchIntent,
          category: active.cat.name ?? null,
          mainCause: active.mc.name ?? active.mc.text ?? null,
          subCause: sc.name ?? sc.text ?? null,
          currentWhyDepth: whysArr.length,
        });

        // 1) Cambio de contexto/categoría: no tratarlo como causa
        if (
          whyIntent === "switch_context" ||
          contextualBranchIntent === "SWITCH_CATEGORY"
        ) {
          const switchResponse = buildSwitchCategoryResponse(
            nextState,
            detectExplicitCategoryId(nextState, answerRaw)
          );

          return ok({
            assistantMessage: switchResponse.assistantMessage,
            updates: { nextState: switchResponse.nextState },
          });
        }

        // 2) Consulta meta del proceso: responder según la rama activa
        if (
            whyIntent === "meta_process" ||
            contextualBranchIntent === "META_PROCESS"
          ) {
          const meta = buildActiveBranchMetaResponse({
            state: nextState,
            studentMessage: answerRaw,
          });

          return ok({
            assistantMessage: meta.assistantMessage,
            updates: { nextState: meta.nextState },
          });
        }

        // 3) El estudiante está pidiendo ayuda o ejemplos, no respondiendo una causa
        if (
            whyIntent === "ask_guidance" ||
            whyIntent === "ask_example" ||
            contextualBranchIntent === "ASK_GUIDANCE"
          ) {
          const currentWhys = sanitizeWhyList(sc.whys);

          const guidedHelp = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            categoryName: active.cat.name ?? "Sin categoría",
            mainCauseName: active.mc.name ?? active.mc.text ?? "Sin causa principal",
            subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
            whys: currentWhys,
            maxWhyDepth: nextState.maxWhyDepth ?? 3,
          });

          return ok({
            assistantMessage: sanitizeStudentPlaceholder(
              guidedHelp || buildClarifyWhyMessage(answerRaw),
              preferredFirstName
            ),
            updates: { nextState },
          });
        }

        // 4) Mensaje de navegación/control residual
        if (isNonCausalMessage(answerRaw)) {
          const meta = buildActiveBranchMetaResponse({
            state: nextState,
            studentMessage: answerRaw,
          });

          return ok({
            assistantMessage: meta.assistantMessage,
            updates: { nextState: meta.nextState },
          });
        }
        // 3) Muy vaga todavía -> pedir ayuda contextual real, no mensaje fijo
        if (isVagueWhyAnswer(answerRaw)) {
          const guidedHelp = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            categoryName: active.cat.name ?? "Sin categoría",
            mainCauseName: active.mc.name ?? active.mc.text ?? "Sin causa principal",
            subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
            whys: whysArr,
            maxWhyDepth: nextState.maxWhyDepth ?? 3,
          });

          return ok({
            assistantMessage: sanitizeStudentPlaceholder(
              guidedHelp || buildClarifyWhyMessage(answerRaw),
              preferredFirstName
            ),
            updates: { nextState },
          });
        }

        // 4) Sanitizar antes de persistir
        const cleanWhy = sanitizeWhyCandidate(answerRaw);
        if (!cleanWhy) {
          const guidedHelp = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            categoryName: active.cat.name ?? "Sin categoría",
            mainCauseName: active.mc.name ?? active.mc.text ?? "Sin causa principal",
            subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
            whys: whysArr,
            maxWhyDepth: nextState.maxWhyDepth ?? 3,
          });

          return ok({
            assistantMessage: sanitizeStudentPlaceholder(
              guidedHelp || buildClarifyWhyMessage(answerRaw),
              preferredFirstName
            ),
            updates: { nextState },
          });
        }

        const answer = normalizeWhyText(cleanWhy);

        // 5) Debe ser una causa accionable real, no texto meta
        if (!isActionableWhyText(answer)) {
          const guidedHelp = await buildGuidedWhyStep({
            studentMessage: answerRaw,
            categoryName: active.cat.name ?? "Sin categoría",
            mainCauseName: active.mc.name ?? active.mc.text ?? "Sin causa principal",
            subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
            whys: whysArr,
            maxWhyDepth: nextState.maxWhyDepth ?? 3,
          });

          return ok({
            assistantMessage: sanitizeStudentPlaceholder(
              guidedHelp || buildClarifyWhyMessage(answerRaw),
              preferredFirstName
            ),
            updates: { nextState },
          });
        }

        const alreadyExists = whysArr.some(
          (w) => w.toLowerCase() === answer.toLowerCase()
        );

        if (!alreadyExists) {
          whysArr.push(answer);
        }

        sc.whys = whysArr;

        const depth = whysArr.length;
        const max = nextState.maxWhyDepth ?? 3;

        // Si ya llegamos a profundidad, proponemos cerrar
        if (depth >= max) {
          // liberamos subCauseId para permitir otra subcausa en la misma causa principal
          nextState.cursor = { categoryId: active.cat.id, mainCauseId: active.mc.id };

          return ok({
            assistantMessage:
              `Tiene sentido: esto explica la causa a un nivel ya **accionable** (impacta en paros/tiempo muerto y OEE).\n` +
              `✅ Ya llegamos a profundidad suficiente (${depth}). ¿Te parece si **cerramos esta subcausa** como causa raíz candidata y agregamos otra subcausa dentro de **"${active.mc.name ?? active.mc.text ?? "esta causa"}"**?`,
            updates: { nextState },
          });
        }

        // Si aún no llegamos, seguimos profundizando con ayuda contextual real
        const guidedMessage = await buildGuidedWhyStep({
          studentMessage,
          categoryName: active.cat.name ?? "Sin categoría",
          mainCauseName: active.mc.name ?? active.mc.text ?? "Sin causa principal",
          subCauseName: sc.name ?? sc.text ?? "Sin subcausa",
          whys: whysArr,
          maxWhyDepth: max,
        });

        return ok({
          assistantMessage: sanitizeStudentPlaceholder(
            guidedMessage || buildClarifyWhyMessage(studentMessage),
            preferredFirstName
          ),
          updates: { nextState },
        });
      }

      // Si no hay subcausa activa, NO hacemos fast-path (evitamos “inventar” flujo)
      // Caemos al Gemini normal.
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

        const currentWhys = sanitizeWhyList(active.sc.whys);
        const lastWhy = currentWhys.length > 0 ? currentWhys[currentWhys.length - 1] : null;

        const guidancePrompt = `
    Eres un asesor académico guiando un análisis Ishikawa + 5 porqués.

    El estudiante está dentro de una rama activa y pidió ayuda para formular mejor la causa raíz.
    NO debes sacarlo del flujo ni preguntarle si quiere cambiar de categoría.
    Debes ayudarlo a aterrizar la MISMA rama actual.

    Contexto de la rama:
    - Categoría: ${catName}
    - Causa principal: ${mainName}
    - Subcausa: ${subName}
    - Último porqué registrado: ${lastWhy ?? "(ninguno)"}

    Mensaje del estudiante:
    "${studentMessage}"

    Tu objetivo:
    - interpretar qué quiso decir,
    - ayudarle a aterrizar la causa,
    - proponer 2 o 3 formulaciones plausibles y accionables si hace falta,
    - mantener la conversación natural,
    - terminar con una sola pregunta concreta para que el estudiante elija o precise.

    Responde SOLO en texto, no JSON.
    `;

        const guidedHelp = await llmText(guidancePrompt);

        return ok({
          assistantMessage: sanitizeStudentPlaceholder(
            String(guidedHelp ?? "").trim(),
            preferredFirstName
          ),
          updates: { nextState: ishikawaState },
        });
      }

      return ok({
        assistantMessage:
          "Claro. Sigamos paso a paso dentro del Ishikawa.\n\n" +
          "Cuéntame una causa concreta del problema y yo te ayudo a ubicarla y profundizarla con los porqués.",
        updates: { nextState: ishikawaState },
      });
    }

    const problemText =
      typeof ishikawaState.problem === "string"
        ? ishikawaState.problem
        : ishikawaState.problem?.text ?? "";

    const minimalContext = {
      product: getStringField(caseContext, "product", "producto"),
      sector: getStringField(caseContext, "sector", "rubro"),
      areas: getStringField(caseContext, "areas", "area"),
      problem: problemText || null,
      cursor: ishikawaState.cursor ?? null,
    };

    const system = `
    Eres OPT-IA (asesor académico) guiando la ETAPA 4: DIAGRAMA ISHIKAWA + 5 POR QUÉS.

    Objetivo:
    - Construir un Ishikawa coherente con el caso y con la Etapa 3 (Brainstorm).
    - Profundizar con "¿por qué?" hasta llegar a causas raíz (registradas como lista whys[] dentro de una subcausa).

    Reglas de interacción:
    - Conversación natural (sin formularios), breve y clara.
    - NO inventes datos del caso. Si falta info, pregunta 1 cosa concreta.
    - Mantén coherencia con: contexto del caso + problemática + brainstorm.
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
    - whys[] dentro de cada subcausa para registrar los “por qué” (profundidad 3 preferida, máximo maxWhyDepth).

    Mínimos (orientativos, guía):
    - minCategories: ideal 5 (6M).
    - Por categoría: mínimo 3 causas principales. 
    - Si el estudiante tiene otra idea sólida, llegar a 4 (preguntar explícitamente si desea agregar una 4ta).
    - Por causa principal: 2-3 subcausas.
    - Profundidad: 3 porqués como base; llegar a 4–5 SOLO si aún no es causa raíz accionable.
    - Por subcausa: completar whys[] cuando el estudiante responda "por qué" (1 a maxWhyDepth).

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
    6) Antes de cambiar de rama, intenta llegar a al menos 3 respuestas en whys[] para una subcausa importante.
    7) Para la categoría actual, completa mínimo minMainCausesPerCategory causas principales antes de proponer cambiar a otra categoría.
        Si el estudiante menciona una idea que cae en otra categoría mientras la categoría actual aún no llega al mínimo:
        Reconoce la idea (sin guardarla)
        Pregunta si la anotamos para después
        Pide una causa principal adicional para completar la categoría actual.
    8) Cierre de rama y continuación (OBLIGATORIO):
        - Considera “rama lista” cuando:
        (a) una subcausa clave ya tiene 2–3 porqués y la última respuesta es accionable/sistémica, o
        (b) ya se alcanzó maxWhyDepth.
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
    - Objetivo docente: profundiza con “¿por qué?” hasta registrar al menos 3 elementos en whys[] para una subcausa importante antes de cerrar la rama y permitir cambio.
    - En modo cursor activo, tu explicación debe referirse SOLO a la rama actual (no menciones otra categoría).
    - Cierre de causa raíz:
    - NO es obligatorio llegar al 5º porqué.
    - Si en 2–3 porqués ya aparece una causa sistémica accionable (ej: ausencia de estándar, mantenimiento inexistente, falta de método, falta de capacitación, falta de repuestos), propón cerrarla como "causa raíz candidata".
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

    Contexto mínimo:
      ${JSON.stringify(minimalContext)}

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

        return ok({
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

    const merged = mergeIshikawaState(
      ishikawaState,
      parsed.updates.nextState as IshikawaState
    );

    const sanitizedMerged = sanitizeIshikawaStateForWhyQuality(merged);

    return ok({
      assistantMessage: sanitizeStudentPlaceholder(
        String(parsed.assistantMessage ?? ""),
        preferredFirstName
      ),
      updates: { nextState: sanitizedMerged },
    });

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
