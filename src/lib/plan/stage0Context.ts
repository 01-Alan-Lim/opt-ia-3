// src/lib/plan/stage0Context.ts
//
// Lógica pura de la Etapa 0 (Contexto del caso) del chat: tipos, intención del mensaje,
// extracción determinista de sector/productos/área, lectura y fusión del contexto, paso
// siguiente y textos. Sin estado, I/O ni LLM: el turno está en src/app/chat/_lib/turns/stage0Turn.ts
// y la apertura en src/app/chat/_lib/stage0Opening.ts.
//
// La intención se decide ANTES de extraer: solo una respuesta (o una corrección) puede guardar
// datos. Pedir empezar, saludar, preguntar, pedir ayuda o un ejemplo, "no sé" o "ok" se responden
// sin guardar nada y sin Gemini; antes "ok", "Dame un ejemplo" o "¿Qué es un sector?" quedaban
// guardados como el sector. Lo que hace el mensaje (rechazar, aplazar, delegar, negar, corregir,
// quedarse en lo vago) lo lee studentMessageActs.ts, común a las etapas; la extracción lee solo lo
// que el estudiante afirma, y cada valor pasa el control de calidad de stage0Values.ts.
//
// Con los tres datos, E0 no se confirma sola: el asesor muestra el resumen y pregunta si lo
// registra (buildStage0Review). Solo un "sí" explícito del estudiante a ese resumen
// (isStage0ReviewConfirmation) lleva a la confirmación del servidor.

import { advisorGreeting, advisorQuestion, advisorStageHeading } from "@/lib/chat/advisorVoice";
import { isAdvisorSideRole } from "@/lib/chat/messageProvenance";
import type { Message } from "@/lib/types";

import { getAdvisorStageLabel } from "./advisorMessages";
import {
  assessStage0Value,
  groundStage0Value,
  isFirstPersonPluralVerb,
  STAGE0_FILLER_WORDS,
  stage0FieldLabel,
} from "./stage0Values";
import { EDIT_VERB_SOURCE, foldSpanish, readStudentMessage, type StudentMessageReading } from "./studentMessageActs";

import {
  isConfirmIntent,
  isGreetingOrSmallTalk,
  isReadyIntent,
  normalizeText,
} from "./advisorClientIntent";

export type Stage0ContextJson = {
  stage?: string;
  sector?: string;
  products?: string[];
  process_focus?: string[];
};
export type Stage0InterpretPayload = {
  // DECLINE: el estudiante no da el dato (lo rechaza, lo aplaza o lo deja en otro).
  intent?: "GREETING" | "QUESTION" | "START" | "EDIT" | "CONFIRM" | "ANSWER" | "DECLINE";
  sector?: unknown;
  products?: unknown;
  process_focus?: unknown;
  confidence?: unknown;
  needsClarification?: unknown;
  clarificationQuestion?: unknown;
  // Motivos de lo que el servidor descartó (stage0Values.ts), sin los valores.
  rejected?: unknown;
};
export type EditTarget = "sector" | "products" | "process_focus" | null;

type Stage0Intent = "GREETING" | "QUESTION" | "START" | "CONFIRM" | "EDIT" | "ANSWER";
export type Stage0DecisionIntent =
  | "answer"
  | "help_request"
  | "example_request"
  | "unknown"
  | "correction"
  | "meta_process"
  | "context_change"
  | "off_topic"
  | "ambiguous"
  | "start"
  | "greeting"
  | "confirm"
  // No comparte el dato ("prefiero no decirlo", "es confidencial").
  | "refusal"
  // Todavía no lo decidió ("todavía no lo decido", "luego te digo").
  | "deferral"
  // Deja la decisión al asesor ("el que tú me recomiendes", "cualquiera").
  | "delegation"
  // Remite a otra persona ("pregúntale a mi supervisor").
  | "third_party"
  // No concreta ("muchos, depende de la temporada", "ninguno en especial").
  | "vague"
  // Solo niega, sin decir el dato ("no es una fábrica").
  | "negated";
type Stage0Field = "sector" | "products" | "process_focus";
export type Stage0Step = 1 | 2 | 3;

// Formas de "empezar" que piden arrancar (infinitivo, primera persona, "empecemos"). No entran
// las de tercera persona ni los sustantivos ("la producción empieza a las 6", "el inicio").
const START_VERB =
  /\b(?:empezar|empezamos|empecemos|empiezo|comenzar|comenzamos|comencemos|comienzo|iniciar|iniciamos|iniciemos|arrancar|arrancamos|arranquemos)\b/;

// Una consulta empieza con un interrogativo o una fórmula de consulta (texto normalizado, sin
// signos). Con "?" basta un interrogativo en cualquier parte. "¿Alimentos?" no es una pregunta:
// es una respuesta dudosa.
const QUESTION_START =
  /^(?:(?:y|pero|entonces|oye|disculpa|perdon|una pregunta)\s+)?(?:que|como|cual|cuales|cuanto|cuantos|cuanta|cuantas|donde|cuando|quien|quienes|por que|para que|puedo|puedes|podrias|podemos|debo|tengo que|hay que|se puede|necesito saber|me explicas|me puedes)\b/;
const QUESTION_WORD = /\b(?:que|como|cual|cuales|cuanto|cuantos|donde|cuando|quien|por que|para que)\b/;

// "¿Por qué necesitas…?", "¿para qué sirve…?": preguntas por el propósito de la etapa.
const PURPOSE_QUESTION =
  /\b(?:por que|para que)\b.*\b(?:necesit\w*|pregunt\w*|pide\w*|sirve\w*|importa\w*|informacion|dato\w*|quieres|hace falta)\b/;

export function isStage0Question(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  if (QUESTION_START.test(t)) return true;
  if (t.includes("no entiendo") || t.includes("explicame")) return true;
  return /[?¿]/.test(text) && QUESTION_WORD.test(t);
}

// El mensaje trae un dato del caso: un verbo de actividad ("fabrica", "vende"), un campo con su
// valor ("el rubro es…") o "es una…". Sirve para no tomar como pregunta o pedido de empezar un
// mensaje que también responde.
export function hasStage0DataCue(text: string): boolean {
  const t = normalizeText(text);
  return (
    hasStage0ProductSignal(text) ||
    /\b(?:sector|rubro|giro|producto|productos|servicio|servicios|area|proceso)\s+(?:es|son|seria)\s+\w/.test(t) ||
    // "es una panadería" sí; "es un rubro" es una definición, no un dato.
    /\b(?:es|somos|son)\s+(?:un|una)\s+(?!(?:sector|rubro|giro|producto|servicio|area|proceso)\b)\w/.test(t) ||
    /\bempresa\s+(?:de|que)\s+\w/.test(t)
  );
}

export function isStage0StartRequest(text: string): boolean {
  return START_VERB.test(normalizeText(text)) && !hasStage0DataCue(text);
}

export function detectStage0Intent(text: string): Stage0Intent {
  const t = normalizeText(text).trim();
  if (!t) return "ANSWER";

  // saludo corto
  if (isGreetingOrSmallTalk(text)) return "GREETING";

  // editar/modificar datos guardados ("¿puedo cambiar el sector?" también es una corrección)
  if (t.includes("cambiar") || t.includes("editar") || t.includes("modificar")) return "EDIT";

  // pedir empezar, también como pregunta ("¿cómo empezamos?")
  if (isStage0StartRequest(text)) return "START";

  // pregunta / meta-pregunta: el "?" se mira en el texto original (normalizeText lo quita)
  if (isStage0Question(text) || t.includes("que debo responder") || t.includes("que preguntaste")) {
    return "QUESTION";
  }

  // confirmar avanzar (cuando ya se capturó todo y se pide confirmación)
  if (isReadyIntent(text) || isConfirmIntent(text)) return "CONFIRM";

  return "ANSWER";
}

export function hasStage0Extraction(value: Stage0ContextJson) {
  return Boolean(
    value.sector ||
      value.products?.length ||
      value.process_focus?.length
  );
}

export function mergeStage0Extraction(
  base: Stage0ContextJson,
  add: Stage0ContextJson
): Stage0ContextJson {
  return {
    stage: base.stage ?? add.stage ?? "ETAPA_0",
    sector: add.sector ?? base.sector,
    products: add.products ?? base.products,
    process_focus: add.process_focus ?? base.process_focus,
  };
}

const STAGE0_UNCERTAINTY =
  /\b(?:no\s+se|nose|no\s+lo\s+se|no\s+conozco|no\s+tengo|no\s+estoy\s+segur\w*|no\s+me\s+queda\s+claro|no\s+sabria|sin\s+idea|ni\s+idea|duda\w*|insegur\w*|confundid\w*|perdid\w*)\b/g;
const STAGE0_HEDGES = /\b(?:quizas|quiza|tal\s+vez|creo\s+que|podria\s+ser|puede\s+ser|supongo\s+que)\b/g;

// Palabras que no aportan un dato (stage0Values.ts). "No sé cuál es el rubro" o "no estoy seguro
// del sector" no traen un valor; un valor hecho solo de estas palabras ("Trabajo", "Productos")
// tampoco se guarda.
const STAGE0_NON_CONTENT = STAGE0_FILLER_WORDS;

function isStage0Unknown(text: string) {
  const t = normalizeText(text);
  if (!new RegExp(STAGE0_UNCERTAINTY.source).test(t)) return false;

  const remainder = t
    .replace(STAGE0_UNCERTAINTY, " ")
    .replace(STAGE0_HEDGES, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Un verbo tampoco es un dato: "No sé qué productos fabrican" no nombra ningún producto.
  return remainder.every((word) => STAGE0_NON_CONTENT.has(word) || isStage0VerbWord(word));
}

// Intenciones que se responden sin guardar nada y sin Gemini. Solo "answer" y "correction" pueden
// guardar datos ("context_change" responde aparte). Antes una extracción determinista ganaba a la
// intención: "Dame un ejemplo" quedaba guardado como el sector, y "Eso es confidencial", como el
// rubro "Confidencial".
export function shouldAnswerWithoutLLM(intent: Stage0DecisionIntent) {
  return (
    intent === "start" ||
    intent === "greeting" ||
    intent === "confirm" ||
    intent === "unknown" ||
    intent === "help_request" ||
    intent === "example_request" ||
    intent === "meta_process" ||
    intent === "off_topic" ||
    intent === "ambiguous" ||
    intent === "refusal" ||
    intent === "deferral" ||
    intent === "delegation" ||
    intent === "third_party" ||
    intent === "vague" ||
    intent === "negated"
  );
}

// Mensajes largos: la extracción determinista está pensada para respuestas cortas y con una
// frase larga arma valores con medio mensaje. Se le pregunta a Gemini (una llamada). El turno lo
// mide sobre lo que el estudiante afirma (sin dudas, rellenos ni lo negado).
export function isLongStage0Message(text: string) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length > 8;
}

// Lo que el estudiante afirma en el mensaje (studentMessageActs.ts): la extracción lee esto.
export function readStage0Message(text: string): StudentMessageReading {
  return readStudentMessage(text);
}

// ---------------- Extracción determinista ----------------
// Para respuestas cortas: los mensajes largos o con datos de varios campos van antes a Gemini
// (stage0Turn.ts). Cómo se lee el mensaje:
//   - Se compara sobre una copia en minúsculas y sin tildes que conserva las posiciones, y el valor
//     se recorta del texto original: "El área es producción" guarda "Producción", con su tilde.
//   - Las palabras se reconocen enteras, nunca un pedazo. Los verbos de actividad, por su raíz y su
//     terminación ("fabricamos", "vende", "producimos"); antes "Fabricamos" se cortaba en "fabrica"
//     y quedaba "Mos" pegado al producto.
//   - Cada marca (el nombre de un campo, un verbo de actividad, "la venta de", "el área de"…) abre
//     un tramo que llega hasta la marca siguiente; lo que va antes de la primera marca responde la
//     pregunta en curso. Cada parte del mensaje va a un solo campo.
//   - Cada valor se limpia de artículos, conectores, dudas ("creo que") y pedidos ("quiero"). Si no
//     queda una palabra con contenido, no se guarda nada.

const STEP_FIELD: Record<Stage0Step, Stage0Field> = { 1: "sector", 2: "products", 3: "process_focus" };

// Minúsculas y sin tildes, letra por letra: cada posición coincide con la del texto original.
const foldStage0 = foldSpanish;

function stage0Words(folded: string) {
  return folded.split(/[^a-z0-9]+/).filter(Boolean);
}

// Una tilde descarta la palabra como verbo o infinitivo: "fábrica", "préstamos", "azúcar".
function hasStage0Accent(original: string) {
  return /[áéíóú]/i.test(original);
}

// Verbos de actividad (qué hace la empresa) por raíz y terminación: presente de él, nosotros y
// ellos (también "se venden"), infinitivo y gerundio. Sin la forma de "yo", que coincide con
// sustantivos ("desarrollo", "cultivo"). "Producción", "venta" o "fabricante" no son verbos.
const AR = "(?:a|as|amos|an|ar|ando)";
const ER = "(?:e|es|emos|en|er|iendo)";
const IR = "(?:e|es|imos|en|ir|iendo)";
const ACTIVITY_VERB_FORMS = [
  "(?:fabric|elabor|prepar|confeccion|comercializ|brind|ensambl|cultiv|export|envas|embotell|empac|empaquet|" +
    `repar|transport|instal|alquil|disen|desarroll|horne|suministr|proces|prest)${AR}`,
  // "importa" también es "tiene importancia"
  "import(?:amos|an|ar|ando)",
  `(?:vend|ofrec|tej|abastec)${ER}`,
  `(?:produc|imprim)${IR}`,
  "(?:distribu|constru)(?:ye|yes|imos|yen|ir|yendo)",
  "(?:prove|extra)(?:e|es|emos|en|er|yendo)",
  "hace|hacen|hacemos",
].join("|");
const ACTIVITY_VERB = new RegExp(`\\b(?:${ACTIVITY_VERB_FORMS})\\b`, "g");
const ACTIVITY_VERB_WORD = new RegExp(`^(?:${ACTIVITY_VERB_FORMS})$`);

// Primera persona del plural ("tenemos", "trabajamos", "damos"): al comienzo de un valor se quita.
// Algunos sustantivos terminan igual (stage0Values.ts).
const isStage0MosVerb = isFirstPersonPluralVerb;

function isStage0VerbWord(word: string) {
  return ACTIVITY_VERB_WORD.test(word) || isStage0MosVerb(word);
}

// ---- Marcas: dónde empieza el valor de cada campo ----

type Stage0Marker = {
  field: Stage0Field;
  start: number;
  end: number;
  // Solo en "la venta de…": dónde termina el sustantivo ("venta").
  nounEnd?: number;
};

const FIELD_NOUN = "sector|rubro|giro|productos?|servicios?|areas?|procesos?";
// "quiero cambiar el rubro (a textil)", "cambiemos el producto": el campo que se corrige; lo que
// sigue es el valor nuevo. El verbo, en cualquier forma (studentMessageActs.ts).
const EDIT_MARKER = new RegExp(
  "\\b(?:(?:quiero|quisiera|queria|necesito|deseo|puedo|podemos|me\\s+gustaria)\\s+)?" +
    `${EDIT_VERB_SOURCE}\\s+(?:(?:el|la|los|las|mi|mis)\\s+)?(${FIELD_NOUN})\\b`,
  "g"
);
const SECTOR_LABEL = /\b(?:sector|rubro|giro)\b/g;
// "es una…", "se dedica a…": presentan la actividad. Marcan el rubro solo cuando se pregunta el
// rubro; en otro paso se quitan del valor.
const SECTOR_INTRO = /\b(?:(?:es|somos|son|seria)\s+una?|(?:se|nos)\s+dedica(?:mos|n)?\s+al?|dedicad[oa]s?\s+al?)\b/g;
// "el producto es…", "productos:". Sin "es" ni ":", el nombre es parte del valor ("productos lácteos").
const PRODUCT_LABEL = /\b(?:productos?|servicios?)(?:\s+principal(?:es)?)?(?:\s+(?:es|son|seria|serian)\b|\s*:)/g;
// "la venta de ropa", "producción de yogur": el producto es lo que sigue a "de".
const ACTIVITY_NOUN =
  /\b(produccion|fabricacion|elaboracion|ventas?|comercializacion|distribucion|confeccion|preparacion)\s+del?\b/g;
const PROCESS_LABEL = /\b(?:areas?|procesos?|departamentos?|seccion(?:es)?|enfoque)\b/g;
const PROCESS_VERB =
  /\b(?:enfoc[a-z]*(?:\s+en)?|(?:analiz|mejor|optimiz|revis|estudi)(?:ar|amos|are|aremos)|intervenir(?:\s+en)?|trabajar\s+en)\b/g;

function fieldOfNoun(noun: string): Stage0Field {
  if (/^(?:sector|rubro|giro)$/.test(noun)) return "sector";
  if (/^(?:productos?|servicios?)$/.test(noun)) return "products";
  return "process_focus";
}

function findStage0Markers(source: string, folded: string, sectorIntros: boolean): Stage0Marker[] {
  const found: Stage0Marker[] = [];
  const collect = (
    pattern: RegExp,
    read: (match: RegExpMatchArray, start: number) => Omit<Stage0Marker, "start" | "end"> | null
  ) => {
    for (const match of folded.matchAll(pattern)) {
      const start = match.index ?? 0;
      const marker = read(match, start);
      if (marker) found.push({ ...marker, start, end: start + match[0].length });
    }
  };

  collect(EDIT_MARKER, (match) => ({ field: fieldOfNoun(match[1] ?? "") }));
  collect(SECTOR_LABEL, () => ({ field: "sector" }));
  if (sectorIntros) collect(SECTOR_INTRO, () => ({ field: "sector" }));
  collect(PRODUCT_LABEL, () => ({ field: "products" }));
  collect(ACTIVITY_VERB, (match, start) =>
    hasStage0Accent(source.slice(start, start + match[0].length)) ? null : { field: "products" }
  );
  collect(ACTIVITY_NOUN, (match, start) => ({ field: "products", nounEnd: start + (match[1] ?? "").length }));
  collect(PROCESS_LABEL, () => ({ field: "process_focus" }));
  collect(PROCESS_VERB, () => ({ field: "process_focus" }));

  // Si dos marcas se pisan ("cambiar el rubro" contiene "rubro"), queda la que empieza antes.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const markers: Stage0Marker[] = [];
  for (const marker of found) {
    const last = markers[markers.length - 1];
    if (!last || marker.start >= last.end) markers.push(marker);
  }
  return markers;
}

// ---- Limpieza de un valor ----

const STAGE0_EDGE = "[\\s\\-–—*•.,;:¡!¿?\"'«»()\\[\\]/]+";
// Al comienzo: dudas, rellenos, la empresa o la práctica, cópulas, preposiciones, artículos,
// posesivos, cantidades, conectores y pronombres.
const STAGE0_LEADING_WORDS = [
  "no\\s+(?:lo\\s+)?se", "nose", "no\\s+sabria(?:\\s+decir)?", "no\\s+conozco", "no\\s+estoy\\s+segur[oa]s?",
  "no\\s+tengo\\s+claro", "no\\s+me\\s+queda\\s+claro", "sin\\s+idea", "ni\\s+idea", "creo\\s+que", "pienso\\s+que",
  "supongo\\s+que", "tal\\s+vez", "quizas?", "puede\\s+ser", "podria\\s+ser", "mas\\s+o\\s+menos", "digamos",
  "o\\s+sea", "osea", "bueno", "pues", "entonces", "ahora", "actualmente", "principalmente", "sobre\\s+todo",
  "basicamente", "mayormente", "solamente", "solo", "tambien", "ademas", "exactamente", "en\\s+realidad",
  "la\\s+verdad", "nosotr[oa]s", "yo", "ahi", "alli", "aqui", "aca", "si", "ok(?:ay)?", "vale", "claro", "ya", "eh+",
  "m+", "aja", "casi", "mas\\s+que\\s+nada", "mas", "menos", "bastante", "normalmente", "generalmente", "usualmente",
  "hoy", "siempre", "igual", "obvio", "lo\\s+principal", "principal(?:es)?", "especificamente", "en\\s+especial",
  "en\\s+particular", "intervencion",
  "empresa", "negocio", "compania", "organizacion", "(?:se|nos)\\s+dedica(?:mos|n)?\\s+al?", "dedicad[oa]s?\\s+al?",
  "somos", "(?:trabajo|trabajamos|estoy|estamos|hago|hacemos|realizo|realizamos)(?:\\s+(?:mi|mis|la|las|nuestra|nuestras))?\\s+practicas?",
  "(?:trabajo|trabajamos|estoy|estamos)\\s+en",
  "es", "son", "era", "eran", "fue", "seria", "serian", "sea",
  "de", "del", "en", "a", "al", "con", "para", "por", "desde", "sobre", "entre",
  "el", "la", "los", "las", "lo", "una?", "unos", "unas", "mis?", "tus?", "sus?", "nuestr[oa]s?",
  "est[ea]s?", "es[ea]s?", "aquel(?:la|lo|las|los)?", "cada", "todo\\s+tipo\\s+de", "tod[oa]s?",
  "dos", "tres", "cuatro", "cinco", "seis", "varios", "varias", "much[oa]s", "algun[oa]s", "diferentes",
  "distint[oa]s", "divers[oa]s", "como", "tipo",
  "que", "y", "e", "o", "u", "pero", "sino", "aunque", "porque", "mejor", "se", "nos", "me", "le", "les",
].join("|");
// Al final: conectores, artículos, pedidos que abren la frase siguiente ("…poleras y quiero").
const STAGE0_TRAILING_WORDS = [
  "y", "e", "o", "u", "que", "pero", "aunque", "porque", "de", "del", "en", "a", "al", "con", "para", "por",
  "el", "la", "los", "las", "lo", "una?", "mis?", "sus?", "nuestr[oa]s?", "donde", "como", "cuando", "tambien",
  "ademas", "etc", "entre\\s+otr[oa]s", "y\\s+otr[oa]s", "y\\s+mas", "quiero", "queremos", "quisiera", "necesito",
  "necesitamos", "me\\s+gustaria", "nos\\s+gustaria", "deseo", "voy\\s+a", "vamos\\s+a", "me\\s+toca", "nos\\s+toca",
  "pienso", "pensamos", "planeo", "(?:me|nos)\\s+interesa", "se", "nos", "me", "le", "les", "todavia", "aun", "ahora",
].join("|");
const STAGE0_LEADING = new RegExp(`^(?:${STAGE0_EDGE}|(?:${STAGE0_LEADING_WORDS})\\b)`);
const STAGE0_TRAILING = new RegExp(`(?:${STAGE0_EDGE}|\\b(?:${STAGE0_TRAILING_WORDS}))$`);
// Un pedido al comienzo ("quiero…", "me gustaría…"). Si lo que sigue es un infinitivo ("quiero
// cambiar algo"), el mensaje es un pedido y no un dato.
const STAGE0_REQUEST = new RegExp(
  "^(?:quiero|queremos|quisiera|quisieramos|me\\s+gustaria|nos\\s+gustaria|deseo|deseamos|necesito|necesitamos|" +
    "prefiero|preferimos|elijo|elegimos|voy\\s+a|vamos\\s+a|me\\s+toca|nos\\s+toca|pienso|pensamos|planeo|digo|" +
    "diria|pondria|pongo)\\b"
);
// Un valor no empieza con una orden: "cambiar algo", "saber más".
const STAGE0_COMMAND =
  /^(?:cambiar|editar|modificar|corregir|actualizar|borrar|eliminar|empezar|comenzar|iniciar|seguir|continuar|avanzar|saber|ver|preguntar|responder|ayudar|explicar|hacer|tener|poner|decir)\b/;

function leadingStage0MosVerb(source: string, folded: string, start: number, end: number) {
  const match = folded.slice(start, end).match(/^[a-z]+(?:amos|emos|imos)\b/);
  if (!match || !isStage0MosVerb(match[0])) return null;
  return hasStage0Accent(source.slice(start, start + match[0].length)) ? null : match;
}

// Recorta [start, end) quitando de los bordes lo que no es dato. null si no queda nada o si el
// tramo es un pedido ("quiero cambiar algo").
function cleanStage0Span(source: string, folded: string, start: number, end: number): [number, number] | null {
  let s = start;
  let e = end;
  let requested = false;
  let changed = true;
  while (changed && s < e) {
    changed = false;
    const head = folded.slice(s, e);
    const request = head.match(STAGE0_REQUEST);
    const lead = request ?? head.match(STAGE0_LEADING) ?? leadingStage0MosVerb(source, folded, s, e);
    if (lead) {
      if (request) requested = true;
      s += lead[0].length;
      changed = true;
      continue;
    }
    const tail = head.match(STAGE0_TRAILING);
    if (tail) {
      e -= tail[0].length;
      changed = true;
    }
  }
  if (s >= e) return null;

  const head = folded.slice(s, e);
  if (STAGE0_COMMAND.test(head)) return null;
  const firstWord = head.match(/^[a-z]+/)?.[0] ?? "";
  const infinitive = /(?:ar|er|ir)$/.test(firstWord) && !hasStage0Accent(source.slice(s, s + firstWord.length));
  return requested && infinitive ? null : [s, e];
}

const STAGE0_CLAUSE_WORDS = new Set([
  "donde", "que", "cual", "cuales", "como", "cuando", "quien", "si", "porque", "cuanto", "cuantos",
]);
// Dicen cómo es la empresa, no a qué se dedica ("es una empresa familiar").
const STAGE0_COMPANY_TRAITS = new Set([
  "grande", "grandes", "pequena", "pequeno", "mediana", "mediano", "chica", "chico", "familiar", "privada",
  "privado", "publica", "publico", "nacional", "local", "nueva", "nuevo", "mixta", "estatal", "unipersonal",
  "conocida", "importante", "formal", "informal",
]);
// En el rubro delatan una frase y no una actividad ("tiene 50 trabajadores", "donde hago mis prácticas").
const STAGE0_SECTOR_BREAKERS = new Set([
  "tiene", "tienen", "tenemos", "tengo", "hay", "queda", "quedan", "esta", "estan", "estamos", "estoy", "cuenta",
  "cuentan", "trabaja", "trabajan", "trabajo", "es", "son", "era", "fue", "hago", "quiero", "queremos", "necesito",
  "necesitamos", "puedo", "podemos", "debo", "toca", "sirve", "significa", "pongo", "llama", "llaman", "se", "me",
  "nos", "mi", "mis",
]);

// El rubro es una frase corta: "panadería", "alimentos y bebidas", "servicios", "construcción".
function isStage0SectorValue(folded: string) {
  const words = stage0Words(folded);
  if (words.length === 0 || words.length > 5 || /[\d,;]/.test(folded)) return false;
  if (STAGE0_CLAUSE_WORDS.has(words[0])) return false;
  if (words.some((word) => STAGE0_SECTOR_BREAKERS.has(word) || isStage0MosVerb(word))) return false;
  return words.some(
    (word) => word === "servicio" || word === "servicios" || (!STAGE0_NON_CONTENT.has(word) && !STAGE0_COMPANY_TRAITS.has(word))
  );
}

// Al menos una palabra que no sea un artículo, el nombre de un campo o un verbo ("Fabrican").
function hasStage0Content(folded: string) {
  return stage0Words(folded).some((word) => !STAGE0_NON_CONTENT.has(word) && !isStage0VerbWord(word));
}

// Primera letra en mayúscula y el resto como lo escribió el estudiante: "Prendas de vestir", no
// "Prendas De Vestir". Un valor escrito todo en mayúsculas pasa a minúsculas, salvo siglas cortas.
function toStage0Display(value: string) {
  const text = value.replace(/\s+/g, " ").trim().slice(0, 140);
  const letters = text.replace(/[^\p{L}]/gu, "");
  const shouted = letters.length > 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  const base = shouted ? text.toLowerCase() : text;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Sin repetidos (sin importar mayúsculas ni tildes) y hasta tres, como los lee readStage0Context.
function uniqueStage0Values(values: string[]) {
  const seen = new Set<string>();
  const unique = values.filter((value) => {
    const key = foldStage0(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length ? unique.slice(0, 3) : undefined;
}

const STAGE0_COPULA = /\b(?:es|son|era|eran|sera|seran|seria|serian)\b/g;

// "El área donde trabajo es producción", "mi producto estrella es el yogur": el dato va después de
// la última cópula. Si después no queda un dato ("productos de limpieza es lo principal"), va antes.
function splitStage0Copula(source: string, folded: string, span: [number, number] | null): [number, number] | null {
  if (!span) return null;
  const copulas = [...folded.slice(span[0], span[1]).matchAll(STAGE0_COPULA)];
  const last = copulas[copulas.length - 1];
  if (!last) return span;
  const at = span[0] + (last.index ?? 0);
  const after = cleanStage0Span(source, folded, at + last[0].length, span[1]);
  if (after && hasStage0Content(folded.slice(after[0], after[1]))) return after;
  return cleanStage0Span(source, folded, span[0], at);
}

const STAGE0_NAMING_CUE = /[\s,]+(?:llamad[oa]s?|que\s+se\s+llama\w*|se\s+llama\w*|denominad[oa]s?|de\s+nombre|cuyo\s+nombre\s+es|con\s+el\s+nombre\s+de)\b/;

// Valores de un tramo. El rubro es uno solo; productos y áreas, una lista separada por comas, punto
// y coma o "y". Cada valor pasa el control de calidad (stage0Values.ts): un tramo que no es un dato
// ("Supervisor dice que somos", "Te dije") se descarta y cuenta el tramo siguiente.
function readStage0Values(
  source: string,
  folded: string,
  start: number,
  end: number,
  field: Stage0Field,
  firstSlot: boolean
): string[] {
  // "Una panadería llamada …": el nombre que sigue no es parte del dato (y no se registra).
  const naming = folded.slice(start, end).search(STAGE0_NAMING_CUE);
  const span = splitStage0Copula(
    source,
    folded,
    cleanStage0Span(source, folded, start, naming >= 0 ? start + naming : end)
  );
  if (!span) return [];
  const isData = (value: string) => assessStage0Value(field, value, { source }) === null;

  if (field === "sector") {
    const comma = folded.slice(span[0], span[1]).search(/[,;\n]/);
    // Una lista sin marcas ("Textil, poleras, producción") no se reparte a ciegas: la lee Gemini.
    if (comma >= 0 && firstSlot) return [];
    const sector = comma >= 0 ? cleanStage0Span(source, folded, span[0], span[0] + comma) : span;
    if (!sector || !isStage0SectorValue(folded.slice(sector[0], sector[1]))) return [];
    const value = toStage0Display(source.slice(sector[0], sector[1]));
    return isData(value) ? [value] : [];
  }

  const values: string[] = [];
  const separators = [...folded.slice(span[0], span[1]).matchAll(/\s*[,;\n]\s*|\s+[ye]\s+/g)];
  let from = span[0];
  for (const separator of [...separators, null]) {
    const to = separator ? span[0] + (separator.index ?? 0) : span[1];
    const part = cleanStage0Span(source, folded, from, to);
    if (part && hasStage0Content(folded.slice(part[0], part[1]))) {
      const value = toStage0Display(source.slice(part[0], part[1]));
      if (isData(value)) values.push(value);
    }
    if (separator) from = to + separator[0].length;
  }
  return values;
}

export function extractStage0Deterministic(
  text: string,
  step: Stage0Step,
  forceField?: Stage0Field | null
): Stage0ContextJson {
  const source = text.normalize("NFC");
  const folded = foldStage0(source);
  // El primer tramo responde la pregunta en curso, o el campo que se está corrigiendo.
  const target = forceField ?? STEP_FIELD[step];
  const found: Record<Stage0Field, string[]> = { sector: [], products: [], process_focus: [] };

  let slotField = target;
  let slotStart = 0;
  for (const marker of [...findStage0Markers(source, folded, target === "sector"), null]) {
    const slotEnd = marker ? marker.start : source.length;
    const values = readStage0Values(source, folded, slotStart, slotEnd, slotField, slotStart === 0);
    found[slotField].push(...values);
    // "Área de producción de yogur": la actividad sin nada antes es el nombre del área.
    if (marker?.nounEnd !== undefined && values.length === 0 && slotField === "process_focus") {
      found.process_focus.push(toStage0Display(source.slice(marker.start, marker.nounEnd)));
    }
    if (marker) {
      slotField = marker.field;
      slotStart = marker.end;
    }
  }

  return {
    sector: found.sector[0],
    products: uniqueStage0Values(found.products),
    process_focus: uniqueStage0Values(found.process_focus),
  };
}

function stage0MarkedFields(text: string) {
  const source = text.normalize("NFC");
  return new Set(findStage0Markers(source, foldStage0(source), false).map((marker) => marker.field));
}

// Un verbo de actividad, "el producto es…" o "la venta de…".
export function hasStage0ProductSignal(text: string) {
  return stage0MarkedFields(text).has("products");
}

// El mensaje trae marcas de dos campos o más: la lectura se le pide a Gemini (stage0Turn.ts).
export function hasMultipleStage0FieldSignals(text: string) {
  return stage0MarkedFields(text).size >= 2;
}

const STAGE0_FIELD_MENTION =
  /\b(?:(sector|rubro|giro|actividad)|(productos?|servicios?)|(areas?|procesos?|departamentos?|seccion(?:es)?|enfoque|intervencion))\b/;

// El dato por el que pregunta o duda el mensaje ("¿Qué significa área de intervención?"), para que
// la ayuda explique ese dato aunque se esté pidiendo otro.
export function stage0FieldMentioned(text: string): Stage0Field | null {
  const match = foldStage0(text.normalize("NFC")).match(STAGE0_FIELD_MENTION);
  if (!match) return null;
  if (match[1]) return "sector";
  return match[2] ? "products" : "process_focus";
}

// Valores de Gemini que el estudiante no dijo: inventados o deducidos de otro dato, no se guardan.
// Cada palabra del valor tiene que estar en el mensaje, entera o por su raíz (stage0Values.ts);
// antes bastaban las cuatro primeras letras y "Pan" pasaba por "panadería". El rubro sí se puede
// deducir ("fabricamos yogur" -> alimentos): la pregunta es a qué se dedica la empresa.
export function groundStage0Extraction(extraction: Stage0ContextJson, text: string): Stage0ContextJson {
  const keep = (values?: string[]) => {
    const kept = values?.filter((value) => groundStage0Value(value, text));
    return kept?.length ? kept : undefined;
  };
  return { ...extraction, products: keep(extraction.products), process_focus: keep(extraction.process_focus) };
}

// El dato que el mensaje niega, si es uno ya registrado ("no era yogur sino queso" con el producto
// Yogur): lo que sigue lo reemplaza.
export function stage0FieldNegated(negated: string[], context: Stage0ContextJson): Stage0Field | null {
  if (!negated.length) return null;
  const said = negated.join(" ");
  const mentions = (value?: string) => Boolean(value && groundStage0Value(value, said));
  if (context.products?.some(mentions)) return "products";
  if (context.process_focus?.some(mentions)) return "process_focus";
  if (mentions(context.sector)) return "sector";
  return null;
}

// Orden: lo que no puede ser un dato va primero. Una pregunta que empieza con un interrogativo es
// una pregunta aunque nombre un campo ("¿Qué es un sector?"); con "?" al final y un dato del caso
// ("Es una panadería, ¿sirve así?") es una respuesta. Rechazar, aplazar, delegar o quedarse en lo
// vago cuentan solo si el mensaje no afirma además un dato ("No puedo decir el nombre, pero es una
// panadería" es una respuesta).
export function classifyStage0DecisionIntent(
  text: string,
  localIntent: Stage0Intent,
  reading: StudentMessageReading = readStudentMessage(text)
): Stage0DecisionIntent {
  const t = normalizeText(text);
  const { acts } = reading;
  const affirms = hasStage0Content(foldStage0(reading.content));

  if (!t) return "ambiguous";
  if (acts.contextChange) return "context_change";
  if (localIntent === "EDIT" || acts.correction) return "correction";
  if (isStage0Unknown(text)) return "unknown";
  if (!affirms) {
    if (acts.refusal) return "refusal";
    if (acts.deferral) return "deferral";
    if (acts.delegation === "third_party") return "third_party";
    if (acts.delegation === "advisor") return "delegation";
    if (acts.vague) return "vague";
    if (acts.uncertain) return "unknown";
  }
  if (localIntent === "GREETING") return "greeting";
  if (localIntent === "START") return "start";

  const dataCue = hasStage0DataCue(text);
  if (
    PURPOSE_QUESTION.test(t) ||
    t.includes("que sigue") ||
    t.includes("como seguimos") ||
    t.includes("en que etapa")
  ) {
    return "meta_process";
  }
  if (!dataCue && (t.includes("ejemplo") || t.includes("opcion") || t.includes("opciones"))) {
    return "example_request";
  }
  // "¿sector?" no dice nada; "¿Alimentos?" es una respuesta dudosa y se guarda.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1 && /[?¿]/.test(text) && STAGE0_NON_CONTENT.has(words[0] ?? "")) {
    return "ambiguous";
  }
  const asksHelp =
    t.includes("ayuda") || t.includes("no entiendo") || t.includes("explicame") || t.includes("que significa");
  // "Como la empresa fabrica muebles…" empieza igual que "¿Cómo…?" pero trae un dato.
  const startsAsQuestion = QUESTION_START.test(t) && (/[?¿]/.test(text) || !dataCue);
  if (startsAsQuestion || ((localIntent === "QUESTION" || asksHelp) && !dataCue)) {
    return "help_request";
  }
  if (localIntent === "CONFIRM") return "confirm";
  if (
    t.includes("balanceo de linea") ||
    t.includes("pareto") ||
    t.includes("ishikawa") ||
    t.includes("foda")
  ) {
    return "off_topic";
  }
  // Solo niega ("no es una fábrica"): no hay dato que guardar.
  if (acts.negation && !affirms) return "negated";

  return "answer";
}

// ---------------- Textos de E0 ----------------
// Siguen el estilo del asesor (src/lib/chat/advisorVoice.ts). Una sola pregunta principal por
// mensaje, destacada: la de cada dato está en stage0QuestionFor; el recordatorio (stage0Reminder)
// la retoma sin repetirla como pregunta, para cuando ya está a la vista. Nunca se pide el nombre
// real de la empresa.

function knownProducts(context: Stage0ContextJson) {
  return context.products?.filter(Boolean).join(", ") ?? "";
}

export function stage0QuestionFor(step: Stage0Step) {
  if (step === 1) {
    return advisorQuestion(
      "¿A qué se dedica la empresa donde realizas tu Práctica Empresarial?",
      "Cuéntamelo brevemente, sin mencionar su nombre."
    );
  }
  if (step === 2) {
    return advisorQuestion(
      "¿Cuál es el producto o servicio principal con el que vas a trabajar?",
      "Si son varios, puedes nombrar hasta tres."
    );
  }
  return advisorQuestion(
    "¿En qué área o proceso de la empresa vas a enfocar tu plan de mejora?",
    "Por ejemplo: producción, almacén, calidad, despacho o atención al cliente."
  );
}

export function stage0Reminder(step: Stage0Step) {
  if (step === 1) {
    return (
      "Lo primero es que me cuentes a qué se dedica la empresa donde realizas tu práctica. Con una frase basta, " +
      "sin su nombre; por ejemplo, «fabrica muebles de madera» o «es un restaurante»."
    );
  }
  if (step === 2) {
    return "Me falta el producto o servicio principal con el que vas a trabajar; puedes nombrar hasta tres.";
  }
  return "Solo me falta el área o proceso donde vas a enfocar tu plan de mejora; por ejemplo, producción, almacén, calidad o despacho.";
}

// Apertura de E0: saludo, la etapa (con la misma etiqueta de la barra lateral), los tres datos y
// para qué sirven, y la pregunta del primer dato que falta. Al retomar, reconoce lo ya registrado.
// greetingName es el nombre de pila del perfil (describeChatIdentity) y se usa tal cual.
export function buildStage0Opening(step: Stage0Step, context: Stage0ContextJson, greetingName?: string | null) {
  const heading = advisorStageHeading(getAdvisorStageLabel(0));

  if (step === 1) {
    return [
      advisorGreeting(
        greetingName,
        "👋 Vamos a desarrollar tu Plan de Mejora a partir de tu Práctica Empresarial. Yo te orientaré durante " +
          "el proceso y tú tomarás las decisiones."
      ),
      heading,
      "Para comenzar, conoceremos tres aspectos de la empresa: su rubro, los productos o servicios que ofrece y " +
        "el área o proceso que analizarás. Esto nos permitirá adaptar el diagnóstico a tu caso real.",
      stage0QuestionFor(1),
    ].join("\n\n");
  }

  const known =
    step === 2
      ? `Ya tengo registrado el rubro: **${context.sector ?? ""}**.`
      : `Ya tengo registrados el rubro (**${context.sector ?? ""}**) y el producto o servicio (**${knownProducts(context)}**).`;

  return [advisorGreeting(greetingName, "👋 Sigamos con el contexto de tu caso."), heading, known, stage0QuestionFor(step)].join(
    "\n\n"
  );
}

// Ayuda sobre un dato: el contenido y, aparte, la invitación a responderlo (stage0Help).
type Stage0Help = { body: string; ask: string };

function stage0Explanation(step: Stage0Step, context: Stage0ContextJson): Stage0Help {
  if (step === 1) {
    return {
      body: [
        "El **rubro** es el tipo de actividad de la empresa, lo que hace para generar ingresos. Para ubicarlo, fíjate si la empresa:",
        "- fabrica o transforma algo (manufactura: alimentos, textil, muebles…);\n" +
          "- compra y revende productos (comercio);\n" +
          "- presta un servicio (transporte, mantenimiento, salud, educación…).",
      ].join("\n\n"),
      ask: "No necesitas el nombre técnico: cuéntame con tus palabras qué hace la empresa y te ayudo a ubicar el rubro.",
    };
  }
  if (step === 2) {
    const sector = context.sector ? `, dentro del rubro **${context.sector}**` : "";
    return {
      body:
        `El **producto o servicio principal** es lo que la empresa entrega a sus clientes${sector}. Conviene elegir ` +
        "uno concreto (o hasta tres), porque los indicadores y las mejoras se miden sobre esa línea.",
      ask: "Piensa en lo que más vende o produce, o en lo que se relaciona con el área donde realizas tu práctica, y escríbelo con tus palabras.",
    };
  }
  const product = knownProducts(context);
  return {
    body:
      "El **área o proceso** (el área de intervención) es la parte de la empresa donde vas a buscar el problema y " +
      `proponer la mejora${product ? ` de **${product}**` : ""}. Delimitarla evita un plan demasiado amplio.`,
    ask: "Piensa en el área donde realizas tu práctica o en dónde ves más demoras, errores o desperdicios, y dime cuál es.",
  };
}

function stage0Examples(step: Stage0Step, context: Stage0ContextJson): Stage0Help {
  if (step === 1) {
    return {
      body: [
        "Algunas formas de describir la actividad de una empresa:",
        "- «Elabora pan y pasteles» → rubro alimentos\n" +
          "- «Confecciona uniformes escolares» → rubro textil\n" +
          "- «Fabrica muebles de melamina» → rubro manufactura de muebles\n" +
          "- «Distribuye bebidas a tiendas» → rubro comercio o distribución\n" +
          "- «Da mantenimiento a maquinaria» → rubro servicios",
      ].join("\n\n"),
      ask: "Describe de forma parecida la empresa donde realizas tu práctica, sin su nombre.",
    };
  }
  if (step === 2) {
    const intro = context.sector
      ? `Como la empresa es del rubro **${context.sector}**, el producto suele ser la línea que más vende o produce. Algunos ejemplos de cómo nombrarlo:`
      : "Algunos ejemplos de cómo nombrar el producto o servicio:";
    return {
      body: [
        intro,
        "- «Pan de molde» o «pasteles»\n" +
          "- «Poleras de algodón»\n" +
          "- «Yogur bebible»\n" +
          "- «Servicio de mantenimiento de equipos»",
      ].join("\n\n"),
      ask: "Escribe el de tu caso; si son varios, nombra hasta tres.",
    };
  }
  const product = knownProducts(context);
  return {
    body: [
      product
        ? `Para **${product}**, el foco del plan podría estar en alguna de estas áreas:`
        : "Áreas o procesos donde suele enfocarse un plan de mejora:",
      "- Producción o elaboración\n" +
        "- Almacén o inventarios\n" +
        "- Calidad o control\n" +
        "- Despacho o logística\n" +
        "- Ventas o atención al cliente\n" +
        "- Mantenimiento",
    ].join("\n\n"),
    ask: "Elige la que corresponda a tu práctica o escríbela con tus palabras.",
  };
}

// "No sé": orienta con lo que ya se sabe del caso, sin inventar el dato.
function stage0Unknown(step: Stage0Step, context: Stage0ContextJson): Stage0Help {
  if (step === 1) {
    return {
      body: "No te preocupes, es normal no tenerlo claro al principio, y no necesito el nombre técnico del rubro.",
      ask: "Basta con que me cuentes qué hace la empresa (qué fabrica o vende, o qué servicio presta) y lo ubicamos juntos.",
    };
  }
  if (step === 2) {
    const where = context.sector
      ? `Como la empresa es del rubro **${context.sector}**, piensa en lo que más vende o produce, o`
      : "Piensa en lo que la empresa entrega a sus clientes o";
    return {
      body: `No hay problema. ${where} en lo que ves a diario en tu práctica; con eso basta, aunque no sea el nombre comercial exacto.`,
      ask: "Si tienes dudas, la persona que te supervisa en la empresa puede confirmarlo.",
    };
  }
  const product = knownProducts(context);
  const where = product
    ? `en qué parte del trabajo con **${product}** ves más demoras, errores o desperdicios`
    : "en qué parte de la empresa ves más demoras, errores o desperdicios";
  return {
    body: `No hay problema. Piensa en el área donde realizas tu práctica o ${where}; suele ser un buen punto de partida.`,
    ask: "Si tienes dudas, la persona que te supervisa en la empresa puede ayudarte a definirlo.",
  };
}

// "Prefiero no decirlo", "es confidencial": no hace falta nada que identifique a la empresa.
function stage0Refusal(step: Stage0Step): Stage0Help {
  const general =
    step === 1
      ? "una descripción general de su actividad, como «fabrica alimentos» o «presta servicios de transporte»"
      : step === 2
        ? "el tipo de producto o servicio en palabras generales, como «pan» o «mantenimiento de equipos», sin marcas"
        : "el nombre general del área o proceso, como «producción» o «almacén»";
  return {
    body:
      "Entiendo. No necesito el nombre de la empresa ni información confidencial: basta con " +
      `${general}. Con eso no se puede identificar a la empresa y el plan se ajusta a tu caso.`,
    ask: "Cuando quieras, escríbelo así.",
  };
}

// "Todavía no lo decido": sin apuro, con un criterio para decidir.
function stage0Deferral(step: Stage0Step, context: Stage0ContextJson): Stage0Help {
  if (step === 1) {
    return {
      body: "No hay apuro. Para el rubro basta con saber qué hace la empresa: qué fabrica o vende, o qué servicio presta.",
      ask: "Cuando lo tengas, cuéntamelo con tus palabras; si te ayuda, puedes confirmarlo con la persona que te supervisa.",
    };
  }
  if (step === 2) {
    const sector = context.sector ? ` del rubro **${context.sector}**` : "";
    return {
      body:
        `Puedes tomarte un momento. Un buen criterio es elegir lo que la empresa${sector} más vende o produce, o lo ` +
        "que se relaciona con el área donde realizas tu práctica.",
      ask: "Cuando lo decidas, escríbelo; puedes nombrar hasta tres.",
    };
  }
  return {
    body:
      "Está bien tomarse un momento. Para decidir, piensa en qué parte del proceso ves más demoras, errores, " +
      "reprocesos o desperdicios, y en cuál puedes conseguir datos durante tu práctica.",
    ask: "Cuando lo decidas, dime el área o proceso; si te ayuda, coméntalo con la persona que te supervisa.",
  };
}

// "El que tú me recomiendes": la decisión es del estudiante; el asesor da criterios y ejemplos.
function stage0Delegation(step: Stage0Step, context: Stage0ContextJson): Stage0Help {
  const examples = stage0Examples(step, context);
  return {
    body:
      "Esa decisión es tuya, porque conoces la empresa y el plan tiene que responder a tu caso real. Lo que sí puedo " +
      `hacer es orientarte.\n\n${examples.body}`,
    ask: examples.ask,
  };
}

// "Pregúntale a mi supervisor": el asesor no habla con terceros.
const STAGE0_THIRD_PARTY =
  "No puedo comunicarme con la persona que te supervisa, pero consultarle es una buena idea. Cuando tengas la " +
  "respuesta, escríbemela aquí.";

// "Muchos, depende de la temporada", "ninguno en especial": hace falta algo concreto.
function stage0Vague(step: Stage0Step): Stage0Help {
  if (step === 1) {
    return {
      body: "Necesito una idea concreta de la actividad principal de la empresa: qué fabrica, qué vende o qué servicio presta.",
      ask: "Si hace varias cosas, quédate con la principal.",
    };
  }
  if (step === 2) {
    return {
      body:
        "Para el plan conviene elegir algo concreto: uno, o hasta tres. Si varía según la temporada, quédate con lo " +
        "que más se vende o produce durante el año, o con lo que se relaciona con el área donde realizas tu práctica.",
      ask: "Escríbelo en palabras generales, sin marcas.",
    };
  }
  return {
    body:
      "Para el plan necesito un área o proceso concreto. Si ves problemas en varias, elige la que más afecta al " +
      "resultado o en la que puedas conseguir datos.",
    ask: "Por ejemplo: producción, almacén, calidad, despacho o atención al cliente.",
  };
}

// Si la ayuda es sobre el dato que se está pidiendo, termina invitando a responderlo. Si es sobre
// otro ("¿Qué significa área de intervención?" mientras se pide el rubro), explica ese y retoma la
// pregunta en curso: una sola pregunta por mensaje.
function stage0Help(help: Stage0Help, topic: Stage0Step, step: Stage0Step, separator = "\n\n") {
  if (topic === step) return `${help.body}${separator}${help.ask}`;
  return `${help.body}\n\n${topic > step ? "Ese dato lo vemos más adelante. " : ""}${stage0Reminder(step)}`;
}

const STAGE0_PURPOSE =
  "Te lo pregunto porque todo el Plan de Mejora se construye sobre tu caso: el rubro y el producto definen qué " +
  "indicadores tienen sentido, y el área delimita dónde buscaremos las causas y propondremos mejoras. Así ninguna " +
  "etapa trabaja con datos inventados. No necesito el nombre de la empresa, solo su actividad.";

// Respuesta a un mensaje que no trae datos del caso (shouldAnswerWithoutLLM). alreadyPrompted:
// el estudiante ya vio una pregunta de E0 en este chat. Si no la vio (escribió antes de que
// llegara la apertura), pedir empezar, saludar o confirmar recibe la apertura completa.
export function buildStage0Reply(input: {
  intent: Stage0DecisionIntent;
  step: Stage0Step;
  context: Stage0ContextJson;
  alreadyPrompted: boolean;
  // Nombre de pila para la apertura completa (describeChatIdentity).
  greetingName?: string | null;
  // Dato por el que pregunta o duda el mensaje (stage0FieldMentioned); si no nombra ninguno, el
  // que se está pidiendo.
  topic?: Stage0Step;
  // Se está cambiando un dato ya registrado (editingField): "ok" no significa que falte algo.
  editing?: boolean;
}) {
  const { intent, step, context, alreadyPrompted } = input;
  const topic = input.topic ?? step;

  if ((intent === "start" || intent === "greeting" || intent === "confirm") && !alreadyPrompted) {
    return buildStage0Opening(step, context, input.greetingName);
  }

  switch (intent) {
    case "start":
      return `¡Ya estamos en marcha! ${stage0Reminder(step)}`;
    case "greeting":
      return `¡Hola de nuevo! ${stage0Reminder(step)}`;
    case "confirm":
      return input.editing
        ? `Para actualizarlo necesito el dato nuevo.\n\n${stage0QuestionFor(step)}`
        : `Todavía no podemos avanzar: me falta un dato del contexto.\n\n${stage0Reminder(step)}`;
    case "help_request":
      return stage0Help(stage0Explanation(topic, context), topic, step);
    case "example_request":
      return stage0Help(stage0Examples(topic, context), topic, step);
    case "unknown":
      return stage0Help(stage0Unknown(topic, context), topic, step, " ");
    case "meta_process":
      return `${STAGE0_PURPOSE}\n\n${stage0Reminder(step)}`;
    case "off_topic":
      return (
        "Eso lo veremos más adelante, en su propia etapa. Por ahora estamos armando el contexto de tu caso, que es " +
        `la base de todo lo demás.\n\n${stage0Reminder(step)}`
      );
    case "refusal":
      return stage0Help(stage0Refusal(step), step, step, " ");
    case "deferral":
      return stage0Help(stage0Deferral(step, context), step, step, " ");
    case "delegation":
      return stage0Help(stage0Delegation(topic, context), topic, step);
    case "third_party":
      return `${STAGE0_THIRD_PARTY}\n\n${stage0Reminder(step)}`;
    case "vague":
      return stage0Help(stage0Vague(step), step, step, " ");
    case "negated":
      return `Gracias por aclararlo. ${stage0Reminder(step)}`;
    default:
      return `No logré entender bien tu mensaje.\n\n${stage0Reminder(step)}`;
  }
}

// Cuando el estudiante intentó responder pero no se pudo identificar el dato.
export function buildStage0Clarification(step: Stage0Step) {
  const field = step === 1 ? "a qué se dedica la empresa" : step === 2 ? "el producto o servicio" : "el área o proceso";
  return `Gracias. Todavía no logro identificar ${field} en tu mensaje.\n\n${stage0Reminder(step)}`;
}

// "Quiero cambiar de empresa": se actualizan los datos empezando por el rubro; el borrador no se
// borra y nada queda registrado hasta que el estudiante revise el resumen.
export function buildStage0ContextChange() {
  return (
    "Si vas a trabajar con otra empresa, actualizamos los datos del contexto empezando por el rubro. Nada queda " +
    `registrado hasta que revises el resumen.\n\n${stage0QuestionFor(1)}`
  );
}

// Un mensaje largo que Gemini no pudo leer: no se guarda nada a medias.
export function buildStage0RetryShort(step: Stage0Step) {
  return `Para no registrar algo equivocado, prefiero que me lo digas en pocas palabras.\n\n${stage0Reminder(step)}`;
}

// El mensaje nombraba a la empresa o una marca y ese valor no se registró. La detección es
// heurística (stage0Values.ts): el texto no afirma que lo fuera.
export const STAGE0_ANONYMITY_NOTE = "Por confidencialidad no registro nombres de empresas ni marcas.";

export function buildStage0AnonymityReply(step: Stage0Step) {
  const ask =
    step === 2
      ? "Escribe el producto o servicio en palabras generales; por ejemplo, «yogur bebible» en lugar de la marca."
      : stage0Reminder(step);
  return `${STAGE0_ANONYMITY_NOTE.replace(/\.$/, "")}, y tu mensaje parece incluir uno. ${ask}`;
}

// ---- Revisión y confirmación de E0 ----
// Con los tres datos, E0 queda en borrador hasta que el estudiante los revisa y responde que sí. Ese
// estado se deduce de plan_case_contexts (borrador con los tres datos), así que sobrevive a una
// recarga o a otra pestaña: el resumen queda guardado en el historial y el turno siguiente lo
// atiende (stage0Turn.ts).

export function isStage0AwaitingReview(contextJson: unknown, status: "draft" | "confirmed") {
  return status !== "confirmed" && getNextStage0StepFromContext(contextJson) === 0;
}

export function buildStage0Summary(context: Stage0ContextJson) {
  return [
    `- **Rubro:** ${context.sector || "(pendiente)"}`,
    `- **Producto o servicio:** ${knownProducts(context) || "(pendiente)"}`,
    `- **Área o proceso:** ${context.process_focus?.filter(Boolean).join(", ") || "(pendiente)"}`,
  ].join("\n\n");
}

const STAGE0_REVIEW_QUESTION = advisorQuestion(
  "¿Lo registro así?",
  "Si algo no es correcto, dime qué dato quieres cambiar."
);

export const STAGE0_REVIEW_REMINDER =
  "Cuando lo hayas revisado, responde «sí» para registrarlo así, o dime qué dato quieres cambiar.";

// El resumen de los tres datos y la pregunta de si se registra. lead: lo que se acaba de registrar
// o cambiar.
export function buildStage0Review(context: Stage0ContextJson, lead?: string) {
  return [lead, "Así queda el contexto de tu caso:", buildStage0Summary(context), STAGE0_REVIEW_QUESTION]
    .filter(Boolean)
    .join("\n\n");
}

// Apertura con los tres datos ya en borrador (el chat no tiene historial): saludo, la etapa y el
// resumen para revisar.
export function buildStage0ReviewOpening(context: Stage0ContextJson, greetingName?: string | null) {
  return [
    advisorGreeting(greetingName, "👋 Sigamos con el contexto de tu caso."),
    advisorStageHeading(getAdvisorStageLabel(0)),
    "Ya tengo los tres datos. Revísalos antes de registrarlos:",
    buildStage0Summary(context),
    STAGE0_REVIEW_QUESTION,
  ].join("\n\n");
}

export function stage0CorrectionQuestion() {
  return advisorQuestion(
    "¿Qué dato quieres cambiar: el rubro, el producto o servicio, o el área o proceso?",
    "Puedes escribir directamente el valor nuevo; por ejemplo, «el producto es queso»."
  );
}

// Lo que se cambió durante la revisión.
export function stage0CorrectionLead(field: Stage0Field, context: Stage0ContextJson) {
  const value = field === "sector" ? context.sector : field === "products" ? knownProducts(context) : context.process_focus?.join(", ");
  return `Actualicé ${stage0FieldLabel(field)}: **${value ?? ""}**.`;
}

// Huella de los tres datos: el turno no confirma un contexto distinto del que el estudiante revisó
// en esta pestaña (otra pestaña pudo cambiarlo).
export function stage0ReviewKey(context: Stage0ContextJson) {
  const fold = (value: string) => normalizeText(value);
  return JSON.stringify([
    fold(context.sector ?? ""),
    (context.products ?? []).map(fold),
    (context.process_focus ?? []).map(fold),
  ]);
}

// "Sí" al resumen: el mensaje entero tiene que ser una confirmación ("sí", "está bien, regístralo",
// "todo correcto"). Con "pero", "no", un dato o una pregunta, no lo es.
const REVIEW_YES = new Set([
  "si", "sip", "ok", "okay", "okey", "dale", "correcto", "correcta", "correctos", "bien", "confirmo", "confirmado",
  "registralo", "registrala", "registrelo", "registra", "guardalo", "adelante", "acuerdo", "perfecto", "exacto", "listo",
  "vale", "claro", "conforme", "efectivamente", "procede", "yes", "vamos", "sigamos", "continuemos", "avancemos",
]);
const REVIEW_YES_FILLER = new Set([
  "asi", "esta", "estan", "todo", "todos", "lo", "la", "los", "es", "son", "eso", "de", "por", "favor", "gracias", "muy",
  "datos", "el", "contexto", "estoy", "que", "y", "ya", "entonces", "nomas", "porfa", "totalmente", "completamente",
  "queda", "quedo", "sigamos", "continuemos", "avancemos", "seguimos", "con", "siguiente", "etapa", "uno", "1",
]);

export function isStage0ReviewConfirmation(text: string) {
  const words = normalizeText(text).split(" ").filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 10 &&
    words.some((word) => REVIEW_YES.has(word)) &&
    words.every((word) => REVIEW_YES.has(word) || REVIEW_YES_FILLER.has(word))
  );
}

// Respuesta en la revisión a lo que no es confirmar ni corregir: contesta y recuerda qué falta, sin
// volver a preguntar.
export function buildStage0ReviewReply(input: {
  intent: Stage0DecisionIntent;
  context: Stage0ContextJson;
  alreadyPrompted: boolean;
  greetingName?: string | null;
  topic?: Stage0Step | null;
}) {
  const { intent, context, alreadyPrompted, topic } = input;
  if ((intent === "start" || intent === "greeting") && !alreadyPrompted) {
    return buildStage0ReviewOpening(context, input.greetingName);
  }
  const withReminder = (text: string) => `${text}\n\n${STAGE0_REVIEW_REMINDER}`;
  switch (intent) {
    case "start":
    case "greeting":
      return withReminder("¡Hola de nuevo! Estamos revisando el contexto de tu caso antes de registrarlo.");
    case "help_request":
    case "example_request":
      return topic
        ? withReminder(stage0Explanation(topic, context).body)
        : withReminder("Ya tengo los tres datos del contexto; solo falta que confirmes que están bien.");
    case "meta_process":
      return withReminder(STAGE0_PURPOSE);
    case "unknown":
    case "deferral":
    case "vague":
      return withReminder(
        "No hace falta decidirlo con total certeza ahora: nada queda registrado hasta que me lo confirmes. Si " +
          "tienes dudas sobre algún dato, puedes consultarlo con la persona que te supervisa."
      );
    case "delegation":
      return withReminder(
        "La decisión es tuya, porque conoces la empresa y el caso. Si algún dato no te convence, cámbialo; si están " +
          "bien, lo registro."
      );
    case "third_party":
      return withReminder(STAGE0_THIRD_PARTY);
    case "refusal":
      return withReminder(
        "No necesito el nombre de la empresa ni información confidencial. Si algún dato permite identificarla, " +
          "cámbialo por una descripción general."
      );
    case "off_topic":
      return withReminder("Eso lo veremos más adelante, en su propia etapa. Primero registremos el contexto de tu caso.");
    default:
      return withReminder("No me queda claro si quieres registrar el contexto o cambiar algún dato.");
  }
}

// E0 confirmada por el servidor: el resumen y cómo seguir (E1 arranca con "productividad" u "ok").
export function buildStage0Confirmed(context: Stage0ContextJson, opts: { already?: boolean } = {}) {
  return [
    opts.already
      ? "El contexto de tu caso ya estaba registrado, así que la Etapa 0 está completa."
      : "Registré el contexto de tu caso: la Etapa 0 está completa.",
    buildStage0Summary(context),
    "Si ya tienes datos mensuales de producción, escribe **productividad** y empezamos con la Etapa 1 " +
      "(Productividad). Si todavía no los tienes, responde **ok** y seguimos con el diagnóstico.",
  ].join("\n\n");
}

export function formatContextSummary(ctxJson: any) {
  const sector = String(ctxJson?.sector ?? "").trim() || "(pendiente)";
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
  const focus = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus.filter(Boolean) : [];

  return (
    `- **Sector:** ${sector}\n` +
    `- **Producto(s):** ${products.length ? products.join(", ") : "(pendiente)"}\n` +
    `- **Área:** ${focus.length ? focus.join(", ") : "(pendiente)"}`
  );
}

function readStage0StringList(value: unknown): string[] | undefined {
  const source =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const text = String(item ?? "").replace(/\s+/g, " ").trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out.length > 0 ? out.slice(0, 3) : undefined;
}

export function readStage0Context(value: Record<string, unknown>): Stage0ContextJson {
  const sector =
    typeof value.sector === "string" && value.sector.trim()
      ? value.sector.trim()
      : undefined;

  return {
    stage: typeof value.stage === "string" ? value.stage : "ETAPA_0",
    sector,
    products: readStage0StringList(value.products),
    process_focus: readStage0StringList(value.process_focus),
  };
}

export function readStage0Extraction(payload: Stage0InterpretPayload): Stage0ContextJson {
  const sector =
    typeof payload.sector === "string" && payload.sector.trim()
      ? payload.sector.trim()
      : undefined;

  return {
    sector,
    products: readStage0StringList(payload.products),
    process_focus: readStage0StringList(payload.process_focus),
  };
}

export function mergeStage0Context(
  current: Stage0ContextJson,
  patch: Stage0ContextJson
): Stage0ContextJson {
  return {
    stage: current.stage ?? "ETAPA_0",
    sector: patch.sector ?? current.sector,
    products: patch.products ?? current.products ?? [],
    process_focus: patch.process_focus ?? current.process_focus ?? [],
  };
}

export function askForMissingStage0Field(step: 1 | 2 | 3, ctxJson: Stage0ContextJson) {
  if (step === 1 && ctxJson.products?.length) {
    return `Ya tengo el producto o servicio: **${knownProducts(ctxJson)}**.\n\n${stage0QuestionFor(1)}`;
  }
  return stage0QuestionFor(step);
}

const STAGE0_TENTATIVE_NOTE = "Lo dejo como provisional: antes de registrar el contexto revisaremos los tres datos juntos.";
const STAGE0_TENTATIVE_REVIEW_NOTE = "Lo anoto como provisional; revísalo con calma antes de registrarlo.";

// Lo que se acaba de registrar y la pregunta del dato siguiente; con los tres datos, el resumen para
// revisar (buildStage0Review), nunca la confirmación. Empieza con "Gracias," y no con "Perfecto,":
// softenAssistantLeadInChat quita esas muletillas al mostrar el mensaje. tentative: el estudiante
// respondió con duda ("creo que…"); note: un aviso más (p. ej., que no se registró un nombre);
// corrected: el dato que ya estaba y se cambió ("Actualicé el rubro…").
export function buildStage0ProgressMessage(
  captured: Stage0ContextJson,
  nextContext: Stage0ContextJson,
  opts: { tentative?: boolean; note?: string; corrected?: Stage0Field } = {}
) {
  const lines: string[] = [];

  if (captured.sector) {
    lines.push(`el rubro: **${captured.sector}**`);
  }

  if (captured.products?.length) {
    lines.push(`el producto o servicio: **${captured.products.join(", ")}**`);
  }

  if (captured.process_focus?.length) {
    lines.push(`el área o proceso: **${captured.process_focus.join(", ")}**`);
  }

  const nextStep = getNextStage0StepFromContext(nextContext);
  const intro = opts.corrected
    ? stage0CorrectionLead(opts.corrected, nextContext)
    : lines.length
      ? `Gracias, registré ${lines.join("; ")}.`
      : "Gracias, actualicé el contexto.";

  const notes = [opts.tentative ? (nextStep === 0 ? STAGE0_TENTATIVE_REVIEW_NOTE : STAGE0_TENTATIVE_NOTE) : "", opts.note ?? ""];
  const lead = [intro, ...notes].filter(Boolean).join(" ");

  if (nextStep === 0) return buildStage0Review(nextContext, lead);

  return `${lead}\n\n${askForMissingStage0Field(nextStep, nextContext)}`;
}

export function detectEditingField(text: string): EditTarget {
  const t = normalizeText(text);

  if (t.includes("sector") || t.includes("rubro")) return "sector";
  if (t.includes("producto") || t.includes("productos") || t.includes("servicio")) return "products";
  if (t.includes("area") || t.includes("proceso")) return "process_focus";

  // Si dice "los 3" o "todo"
  if (t.includes("los 3") || t.includes("todo") || t.includes("los tres")) return null;

  return null;
}

export function stage0StepForField(field: EditTarget): 1 | 2 | 3 | null {
  if (field === "sector") return 1;
  if (field === "products") return 2;
  if (field === "process_focus") return 3;
  return null;
}

export function getNextStage0StepFromContext(ctxJson: any): 1 | 2 | 3 | 0 {
  const sector = String(ctxJson?.sector ?? "").trim();
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products : [];
  const process = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus : [];

  if (!sector) return 1;
  if (!products.length) return 2;
  if (!process.length) return 3;
  return 0; // listo (mínimo completo)
}

// El chat ya no la usa: la apertura de E0 decide por el historial guardado y por quién habló
// primero (src/app/chat/_lib/stage0Opening.ts), no por el texto. Queda para las pruebas de
// procedencia (messageProvenance, advisorPersistEndToEnd), que la usan como ejemplo.
export function lastAssistantIsStage0Prompt(msgs: Message[]) {
  // Las preguntas de E0 son textos locales (advisor): cuenta el último mensaje del asesor.
  const last = [...msgs].reverse().find((m) => isAdvisorSideRole(m.role))?.content ?? "";
  return (
    last.includes("1/3") ||
    last.includes("2/3") ||
    last.includes("3/3") ||
    last.includes("¿Cuál es el producto") ||
    last.includes("¿Cuál es el sector") ||
    last.includes("¿En qué área")
  );
}
