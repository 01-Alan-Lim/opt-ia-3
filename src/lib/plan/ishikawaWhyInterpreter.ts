// src/lib/plan/ishikawaWhyInterpreter.ts

// Intención de un mensaje del estudiante en Ishikawa (E4). Lógica pura, sin I/O.
//
// Separa dos juicios:
// 1) ¿El mensaje intenta responder al "¿por qué?"? Es permisivo: si no pide ayuda ni un
//    ejemplo, no cambia de tema, de rama o de etapa, no pregunta por el proceso y no es solo un
//    acuse ("ok", "gracias"), ES una respuesta. No se exige ninguna frase causal: "El operario
//    no conoce el procedimiento" es una respuesta aunque no diga "falta" ni "no hay".
// 2) ¿La respuesta sirve como causa? Lo decide whyQuality.ts (tautología, generalidad sin
//    objeto, causa solo externa y, desde el tercer porqué, el juicio de accionabilidad del
//    LLM). El rechazo sale de ahí, con una pista.
// Las listas de este archivo solo reconocen pedidos de ayuda, navegación y consultas del
// proceso; ninguna decide si una respuesta es una causa.

export type IshikawaWhyIntent =
  | "answer_why"
  | "ask_guidance"
  | "ask_example"
  | "meta_process"
  | "switch_context"
  | "close_request"
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

function words(text: string): string[] {
  return text.split(" ").filter(Boolean);
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

// ---------------------------------------------------------------------------
// Confirmación de cierre de rama
// ---------------------------------------------------------------------------

// Confirmación explícita de cierre: el mensaje completo debe serlo (muletillas de acuerdo
// + verbo de cierre + complementos cortos: "sí, cerremos esta rama", "ok, cerrar", "cerrar
// ahí"). Una frase que solo contiene la palabra no confirma: "falta personal para cerrar
// la caja", "el sitio queda cerrado", "no sé si cerrar".
const CLOSE_CONFIRM_PATTERN = new RegExp(
  "^" +
    "(?:(?:ok|okay|okey|si|dale|listo|bueno|perfecto|de acuerdo|entonces|ya|vale|va)\\s+)*" +
    "(?:(?:la|lo)\\s+)?" +
    "(?:cerremos(?:la|lo)?|cerramos|cerrar(?:la|lo)?|cierra(?:la|lo)?)" +
    "(?:\\s+(?:ahi|aqui|ya|entonces|nomas|asi|por favor|porfa|esta|esa|la|rama|subcausa|causa|raiz))*" +
    "$"
);

export function isCloseBranchConfirm(text: string): boolean {
  return CLOSE_CONFIRM_PATTERN.test(normalize(text));
}

// ---------------------------------------------------------------------------
// Avance, mapa y "¿qué me falta?"
// ---------------------------------------------------------------------------

// Un sustantivo de avance cuenta solo si el mensaje no dice nada más ("muéstrame el avance",
// "el mapa", "resumen por favor"): en "no se actualiza el mapa de procesos" el mapa es parte
// de una causa.
const PROGRESS_NOUNS = new Set(["avance", "avances", "progreso", "mapa", "resumen", "diagrama"]);

const PROGRESS_FILLERS = new Set([
  "muestrame",
  "mostrame",
  "muestra",
  "ensename",
  "dame",
  "quiero",
  "ver",
  "puedo",
  "podemos",
  "podrias",
  "puedes",
  "me",
  "el",
  "la",
  "los",
  "las",
  "mi",
  "mis",
  "un",
  "una",
  "del",
  "de",
  "por",
  "favor",
  "porfa",
  "hasta",
  "ahora",
  "cual",
  "es",
  "como",
  "va",
  "lo",
  "que",
  "llevamos",
  "llevo",
  "tengo",
  "tenemos",
  "estado",
  "actual",
  "situacion",
  "general",
  "completo",
  "todo",
  "ishikawa",
  "nuestro",
  "nuestra",
  "y",
]);

const PROGRESS_QUESTIONS: readonly RegExp[] = [
  /^(?:y )?(?:que|cuanto|cuantas|cuantos) (?:me |nos )?(?:falta|faltan)\b/,
  /\bpor que no (?:puedo|podemos|me deja|nos deja) (?:avanzar|pasar|cerrar|seguir)\b/,
  /^(?:y )?(?:como|en que) (?:voy|vamos|va)\b/,
  /\bcomo va quedando\b/,
  /^(?:y )?que (?:tenemos|llevamos)\b/,
];

export function isProgressRequest(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (PROGRESS_QUESTIONS.some((pattern) => pattern.test(t))) return true;

  const tokens = words(t);
  const hasNoun =
    tokens.some((token) => PROGRESS_NOUNS.has(token)) || /\b(?:estado|situacion) actual\b/.test(t);

  return hasNoun && tokens.every((token) => PROGRESS_NOUNS.has(token) || PROGRESS_FILLERS.has(token));
}

// ---------------------------------------------------------------------------
// Pasar de etapa ("pasemos a Pareto")
// ---------------------------------------------------------------------------

const STAGE_TARGET =
  "(?:pareto|la etapa 5|etapa 5|la etapa cinco|etapa cinco|la siguiente etapa|siguiente etapa|la proxima etapa|proxima etapa|otra etapa)";

const STAGE_ADVANCE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:ya\\s+)?${STAGE_TARGET}$`),
  new RegExp(
    "\\b(?:pasemos|pasar|pasamos|paso|vamos|ir|avanzar|avancemos|seguir|sigamos|continuar|continuemos|empezar|empecemos)\\b" +
      `(?:\\s+\\w+){0,3}\\s+${STAGE_TARGET}\\b`
  ),
  /\b(?:cerrar|cerremos|terminar|terminemos|finalizar|finalicemos|validar|validemos)\s+(?:la etapa|esta etapa|el ishikawa|ishikawa|el diagrama)\b/,
];

export function isStageAdvanceRequest(text: string): boolean {
  const t = normalize(text);
  return Boolean(t) && STAGE_ADVANCE_PATTERNS.some((pattern) => pattern.test(t));
}

// ---------------------------------------------------------------------------
// Cambio de categoría o de rama
// ---------------------------------------------------------------------------

const CATEGORY_NAVIGATION_SIGNALS = [
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

// El verbo de cambio va al comienzo del mensaje: "vamos con Máquina" navega, pero "no vamos a
// poder reparar la máquina a tiempo" es una respuesta que menciona una máquina.
const SWITCH_VERB_AT_START =
  /^(?:y\s+)?(?:mejor\s+)?(?:ahora\s+)?(?:pasemos a|sigamos con|continuemos con|continuemos ahora en|sigamos ahora en|vamos a|vamos con|ahora con|trabajemos|quiero trabajar|quiero ir a|podemos trabajar|cambiemos a|movernos a|ir a la categoria)\b/;

function looksLikeSwitchContextMessage(t: string): boolean {
  if (!t) return false;
  if (isCategoryOnlyMessage(t)) return true;
  if (hasAny(t, CATEGORY_NAVIGATION_SIGNALS)) return true;
  if (SWITCH_VERB_AT_START.test(t) && mentionsCategory(t)) return true;
  if ((t.includes("categoria") || /\brama\b/.test(t)) && mentionsCategory(t)) return true;
  return false;
}

// Navegación dentro del diagrama sin nombrar una categoría: "sigamos", "otra causa",
// "cambiemos de rama".
const FLOW_NAVIGATION_PATTERNS: readonly RegExp[] = [
  /^(?:y\s+)?(?:sigamos|continuemos|seguimos|siguiente|avancemos|adelante)$/,
  /^(?:y\s+)?(?:(?:pasemos|vamos|sigamos|continuemos|quiero ir|quiero pasar)\s+(?:a|con)\s+|agreguemos\s+|agregar\s+|quiero agregar\s+|anotemos\s+)?(?:otra|otro|la siguiente|el siguiente|una nueva|un nuevo|nueva|nuevo)\s+(?:causa|subcausa|rama)\b/,
  /\b(?:cambiemos|cambiar|dejemos|dejar|saltemos|saltar|abandonemos)\s+(?:de\s+)?(?:esta\s+|la\s+|el\s+)?(?:rama|tema|subcausa)\b/,
];

function isFlowNavigation(t: string): boolean {
  return FLOW_NAVIGATION_PATTERNS.some((pattern) => pattern.test(t));
}

// ---------------------------------------------------------------------------
// Pedidos de ayuda y de ejemplos
// ---------------------------------------------------------------------------

const HELP_PHRASES = [
  "ayudame",
  "me ayudas",
  "puedes ayudarme",
  "podrias ayudarme",
  "me puedes ayudar",
  "me podrias ayudar",
  "orientame",
  "guiame",
  "explicame",
  "me explicas",
  "puedes explicar",
  "podrias explicar",
  "me puedes explicar",
  "no entiendo",
  "no entendi",
  "no comprendo",
  "no me queda claro",
  "no queda claro",
  "me cuesta entender",
  "me falta entender",
  "me falta claridad",
  "me falta comprender",
  "no tengo idea",
  "ni idea",
  "no sabria",
  "como lo dirias",
  "como se escribiria",
  "como lo redacto",
  "como lo escribo",
  "como lo planteo",
  "como lo aterrizo",
  "que pongo",
  "que podria poner",
  "que deberia poner",
  "que me recomiendas",
  "como encontramos la raiz",
  "como encontrar la raiz",
  "como hallamos la raiz",
  "por que seria eso",
  "cual seria",
];

// "no sé" pide ayuda. Sin tilde ("no se") solo cuenta si no sigue un verbo: "no se registra la
// temperatura" es una causa en voz pasiva; "no se qué poner" es un pedido.
const NO_SE_AS_HELP =
  /(?:^|\s)no se(?:$|\s+(?:que|como|cual|cuales|si|donde|cuando|por que|bien|muy bien|mucho|la verdad|exactamente|decir|decirte|responder|contestar|explicar|explicarlo|nada)\b)/;

const NO_SE_WITH_ACCENT = /(?:^|[\s¿¡,.;:])no sé(?:$|[\s?!,.;:])/;

function asksForGuidance(raw: string, t: string): boolean {
  if (NO_SE_WITH_ACCENT.test(raw.toLowerCase())) return true;
  if (NO_SE_AS_HELP.test(t)) return true;
  if (/^(?:una\s+|necesito\s+|me das\s+|dame\s+|pido\s+|quiero\s+)?ayuda\b/.test(t)) return true;
  if (/\bnecesito (?:una |tu |de tu )?ayuda\b/.test(t)) return true;
  if (/^explica\b/.test(t)) return true;
  // "no estoy seguro" solo, sin una respuesta a continuación ("no estoy seguro, pero falta X").
  if (t.includes("no estoy segur") && !/\bpero\b/.test(t)) return true;
  return hasAny(t, HELP_PHRASES);
}

// "dame un ejemplo" pide un ejemplo; "por ejemplo, no hay registro de…" es una respuesta.
function asksForExample(t: string): boolean {
  if (/^(?:y\s+)?(?:un|algun|otro|mas)?\s*ejemplos?$/.test(t)) return true;
  if (
    /\b(?:dame|dime|damelo|ponme|muestrame|sugiereme|proponme)\b(?:\s+\w+){0,3}\s+(?:ejemplos?|ideas|opciones|alternativas)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(?:puedes|podrias|me puedes|me podrias)\s+(?:dar|poner|mostrar|sugerir|proponer)(?:me)?\b(?:\s+\w+){0,3}\s+(?:ejemplos?|ideas|opciones|alternativas)\b/.test(
      t
    )
  ) {
    return true;
  }
  return /^(?:que|algunas)\s+(?:opciones|ideas)\b/.test(t);
}

// ---------------------------------------------------------------------------
// Consultas del proceso y acuses
// ---------------------------------------------------------------------------

const META_PHRASES = [
  "en que parte vamos",
  "en que parte estamos",
  "donde ibamos",
  "donde quedamos",
  "en que rama",
  "que causa estamos",
  "que estamos viendo",
  "rama actual",
  "estoy hablando del proceso",
  "hablo del proceso",
  "es sobre el proceso",
  "no es una causa",
  "no estoy respondiendo",
  "ya te dije",
  "ya te lo dije",
  "ya lo dije",
  "ya respondi",
  "ya conteste",
  "me repites",
  "otra vez lo mismo",
  "de nuevo lo mismo",
  "no me entiendes",
  "no entendiste",
];

// Solo al comienzo del mensaje: "que sigue" pregunta por el proceso, pero "no hay claridad de
// qué sigue después del corte" es una respuesta.
const META_AT_START =
  /^(?:y\s+)?(?:ya terminamos|ya llegamos|ya pasamos|en que vamos|en que estamos|donde estamos|que temas|como seguimos|que sigue|que hacemos|que hago)\b/;

const META_WHOLE = /^(?:y\s+)?ahora que(?:\s+hacemos|\s+sigue)?$/;

function isMetaProcess(t: string): boolean {
  return META_AT_START.test(t) || META_WHOLE.test(t) || hasAny(t, META_PHRASES);
}

function isQuestion(raw: string): boolean {
  return raw.includes("?") || raw.includes("¿");
}

// Mensajes que solo acusan recibo o saludan: no son una respuesta ni piden nada.
const ACKNOWLEDGEMENT_TOKENS = new Set([
  "ok",
  "okay",
  "okey",
  "oki",
  "okas",
  "si",
  "no",
  "vale",
  "dale",
  "listo",
  "bueno",
  "bien",
  "gracias",
  "muchas",
  "entendido",
  "entiendo",
  "perfecto",
  "claro",
  "genial",
  "ya",
  "veo",
  "de",
  "acuerdo",
  "hola",
  "buenas",
  "buenos",
  "dias",
  "tardes",
  "noches",
  "jaja",
  "jajaja",
  "jajajaja",
  "jeje",
  "jejeje",
  "mmm",
  "mm",
  "aja",
  "ah",
  "oh",
  "va",
  "sale",
  "super",
  "excelente",
  "chevere",
  "exacto",
  "correcto",
]);

function isAcknowledgementOnly(t: string): boolean {
  const tokens = words(t);
  return tokens.length > 0 && tokens.every((token) => ACKNOWLEDGEMENT_TOKENS.has(token));
}

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------

export function classifyWhyIntent(input: string): IshikawaWhyIntent {
  const raw = String(input ?? "").trim();
  const t = normalize(raw);

  if (!t) return "unclear";
  if (isCloseBranchConfirm(raw)) return "close_request";
  if (isProgressRequest(raw)) return "meta_process";
  if (isStageAdvanceRequest(raw) || looksLikeSwitchContextMessage(t) || isFlowNavigation(t)) {
    return "switch_context";
  }
  if (asksForExample(t)) return "ask_example";
  if (asksForGuidance(raw, t)) return "ask_guidance";
  if (isMetaProcess(t)) return "meta_process";
  if (isQuestion(raw)) return "ask_guidance";
  if (isAcknowledgementOnly(t)) return "unclear";

  // Todo lo demás es un intento de responder. Si sirve como causa lo decide whyQuality.ts.
  return "answer_why";
}

// ---------------------------------------------------------------------------
// Texto de la respuesta que se guarda
// ---------------------------------------------------------------------------

// Muletillas y reservas al comienzo de una respuesta. Se quitan del texto que se guarda; no
// deciden si el mensaje es una respuesta.
const END = "(?=[\\s,.:;!-]|$)";
const LEADING_FILLER_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:sí|si(?=\\s*,)|pues|bueno|ok|okay|mmm+|eh+|claro|dale|vale|mira|a ver)${END}\\s*[,.:;!-]?\\s*`, "i"),
  /^(?:yo\s+)?(?:creo|pienso|diria|diría|supongo|considero|siento|opino)\s+que\s+/i,
  /^me\s+parece\s+que\s+/i,
  new RegExp(
    `^(?:tal\\s+vez|quizas|quizás|quiza|quizá|a\\s+lo\\s+mejor|puede\\s+ser\\s+que|posiblemente|probablemente)${END}\\s*[,:]?\\s*`,
    "i"
  ),
  new RegExp(`^(?:seria|sería|podria\\s+ser|podría\\s+ser)${END}\\s*[,:]?\\s*`, "i"),
  /^no\s+estoy\s+segur[oa]\s*[,.]?\s*pero\s+/i,
  /^(?:es\s+que|lo\s+que\s+pasa\s+es\s+que|pasa\s+que|sucede\s+que|la\s+causa\s+es\s+que)\s+/i,
  /^(?:porque|por\s+que|por\s+qué|debido\s+a\s+que)\s+/i,
];

// Quita muletillas iniciales ("sí,", "creo que", "tal vez", "porque") y capitaliza.
export function normalizeWhyText(input: string): string {
  let t = String(input ?? "").trim();

  for (let pass = 0; pass < 6; pass++) {
    const before = t;
    for (const pattern of LEADING_FILLER_PATTERNS) t = t.replace(pattern, "").trim();
    if (t === before) break;
  }

  if (t.length) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

// Texto de la respuesta al "¿por qué?" que se evalúa y se guarda, o null si el mensaje no es
// una respuesta (pide ayuda, navega, pregunta por el proceso o solo acusa recibo).
export function extractWhyAnswer(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || classifyWhyIntent(raw) !== "answer_why") return null;

  const cleaned = normalizeWhyText(raw);
  return cleaned ? cleaned : null;
}

// ---------------------------------------------------------------------------
// Navegación fuera de una subcausa abierta (ishikawa/assistant)
// ---------------------------------------------------------------------------

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
