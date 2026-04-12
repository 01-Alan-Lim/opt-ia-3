// src/lib/plan/ishikawaWhyInterpreter.ts

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

function mentionsCategory(text: string): boolean {
  return CATEGORY_TERMS.some((term) => text.includes(normalize(term)));
}

function isCategoryOnlyMessage(text: string): boolean {
  return CATEGORY_TERMS.map((term) => normalize(term)).includes(text);
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

  const asksGuidance =
    t.includes("ayudame") ||
    t.includes("me ayudas") ||
    t.includes("puedes ayudarme") ||
    t.includes("como lo dirias") ||
    t.includes("como se escribiria") ||
    t.includes("como encontramos la raiz") ||
    t.includes("como encontrar la raiz") ||
    t.includes("como hallamos la raiz") ||
    t.includes("no se como decirlo") ||
    t.includes("no se como redactarlo") ||
    t.includes("no tengo idea") ||
    t.includes("no se cual seria") ||
    t.includes("no se que poner") ||
    t.includes("como lo aterrizo") ||
    t.includes("como lo planteo") ||
    t.includes("que me recomiendas poner");

  if (asksGuidance) return "ask_guidance";

  const asksExample =
    t.includes("dame un ejemplo") ||
    t.includes("ejemplo") ||
    t.includes("opciones") ||
    t.includes("cual seria") ||
    t.includes("dame ideas") ||
    t.includes("dame algunas ideas");

  if (asksExample) return "ask_example";

  if (looksLikeSwitchContextMessage(t)) return "switch_context";

  const isMeta =
    t.includes("en que vamos") ||
    t.includes("ya terminamos") ||
    t.includes("ya llegamos") ||
    t.includes("cerramos") ||
    t.includes("pasamos") ||
    t.includes("como va quedando") ||
    t.includes("muestrame el avance") ||
    t.includes("que tenemos") ||
    t.includes("donde ibamos") ||
    t.includes("en que parte vamos") ||
    t.includes("retomemos") ||
    t.includes("como seguimos");

  if (isMeta) return "meta_process";

  const wordCount = raw.split(/\s+/).filter(Boolean).length;

  if (wordCount >= 3 && !looksLikeMetaWhyMessage(raw)) {
    return "answer_why";
  }

  return "unclear";
}

export function sanitizeWhyCandidate(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const intent = classifyWhyIntent(raw);
  if (
    intent === "switch_context" ||
    intent === "meta_process" ||
    intent === "ask_guidance" ||
    intent === "ask_example"
  ) {
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