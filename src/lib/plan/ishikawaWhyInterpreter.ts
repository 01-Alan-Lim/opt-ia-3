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

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
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

  const asksGuidance = hasAny(t, [
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
