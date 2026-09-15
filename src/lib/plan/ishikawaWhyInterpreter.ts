// src/lib/plan/ishikawaWhyInterpreter.ts

import type { IshikawaWhy } from "./ishikawaTree";

export type IshikawaWhyIntent =
  | "answer_why"
  | "ask_guidance"
  | "ask_example"
  | "meta_process"
  | "switch_context"
  | "unclear";

const CATEGORY_TERMS = [
  "maquina",
  "máquina",
  "metodo",
  "método",
  "material",
  "hombre",
  "mano de obra",
  "medicion",
  "medición",
  "medida",
  "entorno",
  "medio ambiente",
  "ambiente",
];

function normalize(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Texto normalizado para comparar intenciones: minúsculas, sin acentos ni signos.
export function normalizeIntentText(text: string): string {
  return normalize(text);
}

function mentionsCategory(text: string): boolean {
  return CATEGORY_TERMS.some((term) => text.includes(normalize(term)));
}

function isCategoryOnlyMessage(text: string): boolean {
  return CATEGORY_TERMS.map((term) => normalize(term)).includes(text);
}

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

// "no se controla/revisa/verifica" describen una causa, no desconocimiento.
// Se retiran antes de evaluar la regla generica "no se" para que
// "no se controla el stock" no se trate como pedido de ayuda.
const NEGATED_PASSIVE_CAUSE_PATTERN = /\bno se (controla|revisa|verifica)n?\b/g;

function stripNegatedPassiveCauses(text: string): string {
  return text.replace(NEGATED_PASSIVE_CAUSE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function isQuestion(input: string, normalized: string): boolean {
  return input.includes("?") || input.includes("¿") || normalized.startsWith("por que ");
}

export function looksLikeMetaWhyMessage(input: string): boolean {
  const t = normalize(input);

  if (!t) return true;

  const metaSignals = [
    "ayudame a aterrizar",
    "ayudame a reformular",
    "como encontramos la raiz",
    "como encontrar la raiz",
    "como hallamos la raiz",
    "no se como decirlo",
    "no se como redactarlo",
    "me ayudas",
    "puedes ayudarme",
    "como lo dirias",
    "como se escribiria",
    "cual seria",
    "seria algo como",
    "no estoy seguro",
    "no tengo idea",
    "no se cual seria",
    "no se que poner",
    "como lo aterrizo",
    "como lo planteo",
    "que me recomiendas poner",
    "en que vamos",
    "en que parte vamos",
    "como va quedando",
    "que tenemos",
    "donde ibamos",
    "muestrame el avance",
    "retomemos",
    "estoy hablando del proceso",
    "hablo del proceso",
    "es sobre el proceso",
    "no estoy respondiendo",
    "no es una causa",
  ];

  return metaSignals.some((signal) => t.includes(signal));
}

function looksLikeSwitchContextMessage(input: string): boolean {
  const t = normalize(input);
  if (!t) return false;

  if (isCategoryOnlyMessage(t)) return true;

  const switchSignals = [
    "pasemos a",
    "otra categoria",
    "siguiente categoria",
    "sigamos con",
    "continuemos con",
    "continuemos ahora en",
    "sigamos ahora en",
    "vamos con",
    "vamos a",
    "ahora con",
    "trabajemos",
    "trabajar la categoria",
    "trabajar categoria",
    "podemos trabajar",
    "quiero trabajar",
    "quiero ir a",
    "cambiemos de categoria",
    "cambiar de categoria",
    "cambiar de rama",
    "mejor pasemos a",
  ];

  const categoryNavigationSignals = [
    "quiero cambiar de categoria",
    "quiero cambiar categoria",
    "cambiemos de categoria",
    "cambiar de categoria",
    "pasemos a otra categoria",
    "pasar a otra categoria",
    "quiero trabajar otra categoria",
    "trabajar otra categoria",
    "otra categoria",
    "siguiente categoria",
  ];

  if (hasAny(t, categoryNavigationSignals)) {
    return true;
  }

  if (switchSignals.some((signal) => t.includes(signal)) && mentionsCategory(t)) {
    return true;
  }

  if ((t.includes("categoria") || t.includes("rama")) && mentionsCategory(t)) {
    return true;
  }

  return false;
}

export function classifyWhyIntent(input: string): IshikawaWhyIntent {
  const raw = String(input ?? "").trim();
  const t = normalize(raw);

  if (!t) return "unclear";

  if (looksLikeSwitchContextMessage(t)) return "switch_context";

  const asksExample = hasAny(t, [
    "dame un ejemplo",
    "dame ejemplo",
    "un ejemplo",
    "ejemplo",
    "dame ideas",
    "dame algunas ideas",
    "opciones",
  ]);

  if (asksExample) return "ask_example";

  const asksGuidance = hasAny(stripNegatedPassiveCauses(t), [
    "ayudame",
    "me ayudas",
    "puedes ayudarme",
    "orientame",
    "explicame",
    "explica",
    "no entiendo",
    "no entiendo bien",
    "no me queda claro",
    "no se",
    "no tengo idea",
    "ni idea",
    "no estoy seguro",
    "me falta entender",
    "me falta claridad",
    "me falta comprender",
    "me cuesta entender",
    "como lo dirias",
    "como se escribiria",
    "como encontramos la raiz",
    "como encontrar la raiz",
    "como hallamos la raiz",
    "no se como decirlo",
    "no se como redactarlo",
    "no se cual seria",
    "no se que poner",
    "que pongo aqui",
    "que podria poner",
    "que deberia poner",
    "por que seria eso",
    "como lo aterrizo",
    "como lo planteo",
    "que me recomiendas poner",
  ]);

  if (asksGuidance) return "ask_guidance";

  const isMeta = hasAny(t, [
    "en que vamos",
    "ya terminamos",
    "ya llegamos",
    "cerramos",
    "pasamos",
    "como va quedando",
    "muestrame el avance",
    "que tenemos",
    "donde ibamos",
    "en que parte vamos",
    "retomemos",
    "como seguimos",
    "estoy hablando del proceso",
    "hablo del proceso",
    "es sobre el proceso",
  ]);

  if (isMeta) return "meta_process";

  if (isQuestion(raw, t)) return "ask_guidance";

  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const causalSignals = [
    "porque",
    "debido a",
    "a causa de",
    "por falta",
    "falta",
    "ausencia",
    "no existe",
    "no hay",
    "nadie",
    "no se controla",
    "no se revisa",
    "no se verifica",
    "no fue asignado",
    "sin responsable",
    "sin procedimiento",
    "sin control",
    "sin registro",
  ];

  if (
    wordCount >= 2 &&
    hasAny(t, causalSignals) &&
    !looksLikeMetaWhyMessage(raw)
  ) {
    return "answer_why";
  }

  return "unclear";
}

export function sanitizeWhyCandidate(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const intent = classifyWhyIntent(raw);
  if (intent !== "answer_why") {
    return null;
  }

  if (looksLikeMetaWhyMessage(raw)) return null;

  const cleaned = raw
    .replace(/^seria\s*:\s*/i, "")
    .replace(/^sería\s*:\s*/i, "")
    .replace(/^podria ser\s*:\s*/i, "")
    .replace(/^podría ser\s*:\s*/i, "")
    .trim();

  if (cleaned.length < 6) return null;

  return cleaned;
}

// ---------------------------------------------------------------------------
// Filtros de la respuesta a un "¿por qué?" (movidos sin cambios desde
// ishikawa/assistant para probar la ruta rápida sin la ruta HTTP).
// ---------------------------------------------------------------------------

// Quita muletillas iniciales ("sí,", "creo que", "porque") y capitaliza.
export function normalizeWhyText(input: string): string {
  let t = (input ?? "").trim();

  t = t.replace(/^(si|sí|pues|bueno|ok|mmm)\s*,?\s*/i, "");
  t = t.replace(/^(creo que|pienso que|diría que)\s+/i, "");
  t = t.replace(/^(porque|por que)\s+/i, "");

  if (t.length) t = t[0].toUpperCase() + t.slice(1);

  return t;
}

export function isActionableWhyText(input: string): boolean {
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

export function sanitizeWhyList(whys: IshikawaWhy[] | undefined): string[] {
  const rawList = Array.isArray(whys) ? whys : [];

  const cleaned = rawList
    .map((item) => (typeof item === "string" ? item : (item?.text ?? "")))
    .map((item) => sanitizeWhyCandidate(String(item ?? "")))
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeWhyText(item))
    .filter((item) => isActionableWhyText(item));

  return Array.from(new Set(cleaned.map((item) => item.trim()))); // dedup exacto
}

export function isVagueWhyAnswer(input: string): boolean {
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

export function looksLikeSwitchCategoryIntent(text: string): boolean {
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

export function isNonCausalMessage(input: string): boolean {
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
