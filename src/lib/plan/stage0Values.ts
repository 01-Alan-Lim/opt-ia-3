// src/lib/plan/stage0Values.ts
//
// Control de calidad de los datos de la Etapa 0 (rubro, productos o servicios, área o proceso), el
// mismo en el navegador y en el servidor. Un valor se guarda solo si es un dato del caso: una frase
// nominal breve, sin verbos de la conversación ("decirlo", "recomiendes", "equivoqué"), sin
// negaciones, sin cuantificadores vacíos ("muchos", "ninguno en especial"), sin personas y sin
// nombres de empresas ni marcas. Lo usan:
//   - la extracción propia (stage0Context.ts), que descarta los tramos que no son datos;
//   - el turno (stage0Turn.ts) y POST /api/plans/context/interpret, sobre la lectura de Gemini,
//     que además debe apoyarse en palabras enteras de lo que el estudiante afirma
//     (groundStage0Value): nada deducido por parecido ("Pan" de "panadería") ni tomado de lo negado;
//   - POST /api/plans/context y /api/plans/context/confirm, que rechazan un valor inválido aunque
//     llegue directo del cliente.
// La detección de nombres propios es heurística (formas legales, siglas, palabras seguidas con
// mayúscula, "se llama…"): reduce el riesgo, no lo elimina.

import { foldSpanish, readStudentMessage, type StudentMessageReading } from "./studentMessageActs";

export type Stage0Field = "sector" | "products" | "process_focus";
export type Stage0Values = { sector?: string; products?: string[]; process_focus?: string[] };
export type Stage0ValueRejection =
  | "empty"
  | "too_long"
  | "company_name"
  | "refusal"
  | "negation"
  | "dialogue"
  | "person"
  | "vague"
  | "clause"
  | "ungrounded";
export type Stage0Rejected = { field: Stage0Field; reason: Stage0ValueRejection };

// Palabras que no aportan un dato: nombres de los campos, interrogativos, artículos, verbos comunes
// y de "qué pongo". "No sé cuál es el rubro" no trae un valor; un valor hecho solo de estas palabras
// ("Trabajo", "Productos") tampoco se guarda.
export const STAGE0_FILLER_WORDS = new Set([
  "sector", "rubro", "giro", "actividad", "empresa", "negocio", "producto", "productos", "servicio",
  "servicios", "area", "areas", "proceso", "procesos", "enfoque", "foco", "linea", "departamento",
  "departamentos", "seccion", "secciones", "intervencion", "practica", "practicas",
  "el", "la", "los", "las", "lo", "un", "una", "unos", "unas", "de", "del", "al", "a", "en", "con",
  "que", "cual", "cuales", "como", "cuanto", "es", "son", "era", "seria", "serian", "sea", "poner",
  "pongo", "responder", "respondo", "decir", "digo", "elegir", "elijo", "escribir", "escribo", "eso",
  "esto", "esa", "ese", "esta", "este", "mi", "mis", "su", "sus", "tu", "bien", "muy", "mucho",
  "exactamente", "realmente", "todavia", "aun", "aca", "aqui", "ahi", "alli", "pregunta", "respuesta", "dato",
  "datos", "informacion", "claro", "idea", "seguro", "segura", "nada", "tampoco", "pues", "y", "o",
  "pero", "si", "no", "me", "te", "se", "le", "hay", "tengo", "tenemos", "tiene", "tienen",
  "hace", "hacen", "hacemos", "hago", "hacer", "sabe", "saben", "estan", "estamos", "estoy", "trabaja",
  "trabajan", "trabajamos", "trabajo", "dedica", "dedican", "dedicamos", "algo", "todo", "toda", "todos",
  "cosa", "cosas", "nombre", "exacto", "exacta", "solo", "yo", "nosotros", "mas", "menos", "ok", "okay", "vale",
  "listo", "ya", "casi", "bastante", "siempre", "hoy", "ahora", "igual", "principal", "principales",
]);

// Primera persona del plural ("tenemos", "trabajamos", "damos"). Algunos sustantivos terminan igual.
const MOS_NOUNS = new Set([
  "ramos", "remos", "reclamos", "primos", "racimos", "animos", "gamos", "mimos", "limos", "tramos", "extremos",
  "supremos", "gramos", "kilogramos", "miligramos",
]);

export function isFirstPersonPluralVerb(word: string) {
  return /^[a-z]+(?:amos|emos|imos)$/.test(word) && !MOS_NOUNS.has(word);
}

const NEGATION_WORDS = new Set(["ni", "nunca", "tampoco", "jamas", "ningun", "ninguno", "ninguna", "nada"]);
// Verbos y pronombres de la conversación: hablan del diálogo o de la decisión, nunca de la empresa.
const DIALOGUE_WORDS = new Set([
  "dije", "dijo", "dijiste", "dijeron", "digo", "dices", "dice", "dicen", "diga", "digas", "decirlo", "decirla",
  "decirte", "decirle", "decido", "decidi", "decidimos", "decidido", "decidida", "decidir", "decida", "decidas",
  "definido", "definir", "defino", "recomiendes", "recomiendas", "recomienda", "recomiendo", "recomendar",
  "recomendaste", "sugieres", "sugieras", "sugiere", "sugiero", "sugerir", "elijas", "eliges", "elige", "elegir",
  "escojas", "escoge", "prefiero", "prefieres", "prefieras", "preferiria", "equivoque", "equivocado", "equivocada",
  "confundi", "confundido", "confundida", "preguntale", "preguntar", "preguntaste", "cambiemos", "cambiar", "cambies",
  "corrijo", "corregir", "corrige", "sabes", "creo", "crees", "pienso", "piensas", "supongo", "quieras", "quiera",
  "quieres", "puedes", "podrias", "mencione", "mencionaste", "comente", "pensando", "decidiendo", "definiendo",
  "consulto", "averiguo", "dejalo", "dejemoslo", "olvidalo", "yo", "tu", "me", "usted", "ustedes", "conmigo",
  "contigo", "mi", "nosotros", "nosotras",
]);
const PERSON_WORDS = new Set([
  "supervisor", "supervisora", "jefe", "jefa", "tutor", "tutora", "encargado", "encargada", "gerente", "docente",
  "licenciado", "licenciada", "ingeniero", "ingeniera", "dueno", "duena", "companero", "companera", "profesor",
  "profesora",
]);
const PRIVATE_WORDS = new Set([
  "confidencial", "confidenciales", "secreto", "secreta", "secretos", "reservado", "reservada", "privado", "privada",
  "privados", "privadas", "sensible",
]);
const VAGUE_WORDS = new Set([
  "muchos", "muchas", "varios", "varias", "cualquiera", "cualquier", "especial", "particular", "concreto", "general",
  "otros", "otras", "demas", "diversos", "diversas", "distintos", "distintas", "diferentes", "algunos", "algunas",
  "bastantes", "poco", "pocos", "normal", "etc",
]);
const CLAUSE_START = new Set(["que", "donde", "cual", "cuales", "como", "cuando", "quien", "quienes", "porque", "si"]);
const CONTRAST_WORDS = new Set(["pero", "sino", "aunque", "porque", "mientras"]);
const FINITE_WORDS = new Set([
  "es", "son", "era", "eran", "soy", "eres", "estoy", "estamos", "estan", "hay", "habia", "tengo", "tenemos", "tiene",
  "tienen", "puedo", "puede", "podemos", "quiero", "queremos", "sea", "seria", "sera", "fue", "fueron", "somos",
  "hago", "hace", "hacen",
]);
const CLITICS = new Set(["lo", "la", "los", "las", "le", "les", "se", "me", "te", "nos"]);

// Siglas del oficio que no son nombres de empresas.
const TRADE_ACRONYMS = new Set([
  "PYME", "PYMES", "MYPE", "MYPES", "TI", "TIC", "TICS", "ISO", "BPM", "HACCP", "POES", "SST", "EPP", "ERP", "CRM",
  "GLP", "GNV", "PVC", "MDF", "LED", "CNC", "KPI", "OEE", "TPM", "VSM", "SMED", "JIT", "FIFO", "PEPS", "UEPS", "QA",
  "QC", "RRHH", "IT",
]);
const LEGAL_FORM =
  /(?:^|[\s,(])(?:S\.?\s?A\.?(?:\s?C\.?|\s?S\.?)?|S\.?\s?R\.?\s?L\.?|S\.?\s?L\.?|Ltda\.?|C[ií]a\.?|E\.?\s?I\.?\s?R\.?\s?L\.?|Inc\.?|Corp\.?|LLC|Hnos\.?)(?=$|[\s,.;)])/i;
const NAME_CONNECTORS = new Set(["de", "del", "la", "las", "los", "el"]);
const NAMING_CUE = /\b(?:se\s+llama|llamad[oa]|denominad[oa]|de\s+nombre|la\s+marca|marca)\s*$/;

type Token = { text: string; folded: string; start: number; end: number; sentenceStart: boolean };

function tokensOf(source: string): Token[] {
  const folded = foldSpanish(source);
  const out: Token[] = [];
  for (const match of source.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0;
    const before = source.slice(0, start).replace(/\s+$/, "");
    out.push({
      text: match[0],
      folded: folded.slice(start, start + match[0].length),
      start,
      end: start + match[0].length,
      sentenceStart: before === "" || /[.!?¡¿:\n"«(]$/.test(before),
    });
  }
  return out;
}

function capitalized(word: string) {
  return /^\p{Lu}/u.test(word);
}

// Verbos de actividad o de trabajo al comienzo de una oración ("Fabrica", "Vendemos", "Trabajo").
const SENTENCE_VERB =
  /^(?:fabric|vend|produc|elabor|ofrec|brind|hac|prepar|confeccion|distribu|comercializ|import|export|prest|trabaj|realiz|dedic|ten|tien|hag|est)[a-z]*$/;

function startsSentenceNaturally(folded: string) {
  return STAGE0_FILLER_WORDS.has(folded) || isFirstPersonPluralVerb(folded) || SENTENCE_VERB.test(folded);
}

function allCaps(word: string) {
  return word.length >= 3 && /\p{L}/u.test(word) && word === word.toUpperCase() && word !== word.toLowerCase();
}

function shouted(text: string) {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length > 4 && letters === letters.toUpperCase();
}

// Tramos del mensaje que parecen el nombre de una empresa o de una marca.
export function findCompanyNames(text: string): Array<[number, number]> {
  const source = String(text ?? "").normalize("NFC");
  const tokens = tokensOf(source);
  const spans: Array<[number, number]> = [];
  const isShouted = shouted(source);

  // Forma legal ("S.R.L.", "Ltda.") con las palabras con mayúscula que la preceden.
  const legal = source.match(LEGAL_FORM);
  if (legal) {
    const at = (legal.index ?? 0) + (legal[0].length - legal[0].trimStart().length);
    let from = at;
    for (let i = tokens.findIndex((t) => t.start >= at) - 1; i >= 0 && capitalized(tokens[i].text); i -= 1) from = tokens[i].start;
    spans.push([from, at + legal[0].trim().length]);
  }

  // Siglas que no son del oficio ("ACME"), si el mensaje no está todo en mayúsculas.
  if (!isShouted) {
    for (const t of tokens) if (allCaps(t.text) && !TRADE_ACRONYMS.has(t.text)) spans.push([t.start, t.end]);
  }

  // Quien escribe todo con mayúscula inicial no está marcando nombres.
  const middle = tokens.filter((t) => !t.sentenceStart && t.text.length >= 2);
  const titleCase = isShouted || (middle.length >= 3 && middle.filter((t) => capitalized(t.text)).length / middle.length > 0.6);
  if (titleCase) return spans;

  // Dos o más palabras seguidas con mayúscula ("Industrias Sol", "Lácteos Andinos fabrica…"), con
  // "de", "la"… en minúscula entre ellas. La primera palabra de la oración lleva mayúscula de todos
  // modos: cuenta solo si no es un verbo ni una palabra de relleno ("Vendemos Yogur" no es un nombre).
  let run: Token[] = [];
  const closeRun = () => {
    const named = run.filter((t) => capitalized(t.text) && !(t.sentenceStart && startsSentenceNaturally(t.folded)));
    if (named.length >= 2) spans.push([named[0].start, named[named.length - 1].end]);
    run = [];
  };
  for (const t of tokens) {
    if (capitalized(t.text) && t.text.length >= 2) {
      if (run.length && NAME_CONNECTORS.has(t.folded)) {
        // "De" con mayúscula en medio: escritura en título, no un nombre.
        run = [];
        continue;
      }
      run.push(t);
    } else if (run.length && NAME_CONNECTORS.has(t.text)) {
      run.push(t);
    } else {
      closeRun();
    }
  }
  closeRun();

  // Una palabra con mayúscula después de "se llama", "la marca"…
  const folded = foldSpanish(source);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!capitalized(t.text) || !NAMING_CUE.test(folded.slice(0, t.start))) continue;
    let end = t.end;
    for (let j = i + 1; j < tokens.length && capitalized(tokens[j].text); j += 1) end = tokens[j].end;
    spans.push([t.start, end]);
  }
  return spans;
}

function contentWords(text: string) {
  return foldSpanish(String(text ?? "").normalize("NFC"))
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STAGE0_FILLER_WORDS.has(word));
}

// Raíz para comparar palabras enteras: sin plural ni vocal final ("poleras" y "polera" -> "poler").
function stem(word: string) {
  return word.replace(/(?:es|s)$/, "").replace(/[aeo]$/, "");
}

function editDistanceAtMostOne(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function sameWord(a: string, b: string) {
  const x = stem(a);
  const y = stem(b);
  return x === y || (x.length >= 5 && y.length >= 5 && editDistanceAtMostOne(x, y));
}

// ¿Cada palabra con contenido del valor está dicha en el texto? Palabras enteras, por su raíz o con
// una letra de diferencia ("yogurt"/"yogur"); nunca por parecido del comienzo ("Pan" no sale de
// "panadería", ni "Producción" de "producimos").
export function groundStage0Value(value: string, text: string) {
  const said = contentWords(text);
  return contentWords(value).every((word) => said.some((other) => sameWord(word, other)));
}

// El valor repite una palabra que en el mensaje solo aparece dentro de un nombre de empresa.
function sharesCompanyName(value: string, source: string) {
  const spans = findCompanyNames(source);
  if (!spans.length) return false;
  const inside = (start: number) => spans.some(([s, e]) => start >= s && start < e);
  const tokens = tokensOf(source).filter((t) => t.folded.length >= 3 && !STAGE0_FILLER_WORDS.has(t.folded));
  const named = tokens.filter((t) => inside(t.start)).map((t) => t.folded);
  const outside = tokens.filter((t) => !inside(t.start)).map((t) => t.folded);
  return contentWords(value).some(
    (word) => named.some((n) => sameWord(word, n)) && !outside.some((o) => sameWord(word, o))
  );
}

function looksLikeCompanyName(value: string) {
  if (LEGAL_FORM.test(value) || value.includes("&")) return true;
  if (shouted(value)) return false;
  return tokensOf(value).some((t) => allCaps(t.text) && !TRADE_ACRONYMS.has(t.text));
}

// Motivo por el que un valor no es un dato del caso, o null si lo es. source: el mensaje del
// estudiante, para reconocer nombres de empresas por cómo los escribió.
export function assessStage0Value(
  field: Stage0Field,
  value: string,
  opts: { source?: string } = {}
): Stage0ValueRejection | null {
  const original = String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const tokens = tokensOf(original);
  const words = tokens.map((t) => t.folded);
  if (!words.some((word) => /[a-z]{2}/.test(word))) return "empty";
  if (words.length > (field === "sector" ? 6 : 8) || original.length > 120) return "too_long";
  if (looksLikeCompanyName(original) || (opts.source && sharesCompanyName(original, opts.source))) return "company_name";

  const content = words.filter((word) => !STAGE0_FILLER_WORDS.has(word));
  if (content.length && content.every((word) => PRIVATE_WORDS.has(word))) return "refusal";

  const accented = (i: number) => /[áéíóú]/i.test(tokens[i]?.text ?? "");
  const negated = words.some((word, i) => {
    if (NEGATION_WORDS.has(word)) return true;
    if (word !== "no") return false;
    const next = words[i + 1];
    return i === 0 || next === undefined || FINITE_WORDS.has(next) || CLITICS.has(next) || isFirstPersonPluralVerb(next);
  });
  if (negated) return "negation";

  // "té" (la bebida) y "mí" no son el pronombre "te"/"mi" de la conversación.
  if (words.some((word, i) => (DIALOGUE_WORDS.has(word) || word === "te") && !(word === "te" && accented(i)))) return "dialogue";
  if (words.some((word) => PERSON_WORDS.has(word))) return "person";
  if (words.some((word) => /^depend/.test(word)) || (content.length && content.every((word) => VAGUE_WORDS.has(word)))) {
    return "vague";
  }

  if (CLAUSE_START.has(words[0]) || (words.length > 1 && /^(?:el|la|lo|los|las)$/.test(words[0]) && words[1] === "que")) {
    return "clause";
  }
  const finite = words.some(
    (word, i) =>
      CONTRAST_WORDS.has(word) ||
      FINITE_WORDS.has(word) ||
      (word === "esta" && accented(i)) ||
      (isFirstPersonPluralVerb(word) && !accented(i))
  );
  if (finite) return "clause";

  const servicesSector = field === "sector" && words.some((word) => word === "servicio" || word === "servicios");
  if (!content.length && !servicesSector) return "empty";
  return null;
}

function onlyNegated(value: string, reading: StudentMessageReading) {
  const words = contentWords(value);
  if (!words.length || !reading.negated.length) return false;
  const negatedWords = reading.negated.flatMap(contentWords);
  const affirmed = contentWords(reading.content);
  return (
    words.every((word) => negatedWords.some((other) => sameWord(word, other))) &&
    !words.some((word) => affirmed.some((other) => sameWord(word, other)))
  );
}

// Valores leídos del mensaje del estudiante (por la extracción propia o por Gemini). Quedan los que
// son datos del caso; los productos y las áreas, además, solo si el estudiante los afirmó (no se
// deducen ni salen de lo negado). El rubro sí se puede deducir de la actividad ("fabricamos yogur"
// -> alimentos), salvo de lo negado o de un nombre de empresa. Los motivos de lo descartado van
// aparte, sin los valores (no se repite un nombre de empresa).
export function validateStage0Extraction(
  values: Stage0Values,
  userText: string
): { values: Stage0Values; rejected: Stage0Rejected[] } {
  const reading = readStudentMessage(userText);
  const rejected: Stage0Rejected[] = [];
  const accept = (field: Stage0Field, value: string) => {
    const reason =
      assessStage0Value(field, value, { source: reading.source }) ??
      (field === "sector"
        ? onlyNegated(value, reading)
          ? "negation"
          : null
        : groundStage0Value(value, reading.content)
          ? null
          : "ungrounded");
    if (reason) rejected.push({ field, reason });
    return !reason;
  };
  const list = (field: Stage0Field, items?: string[]) => {
    const kept = items?.filter((item) => accept(field, item));
    return kept?.length ? kept : undefined;
  };
  const sector = values.sector && accept("sector", values.sector) ? values.sector : undefined;
  return {
    values: { sector, products: list("products", values.products), process_focus: list("process_focus", values.process_focus) },
    rejected,
  };
}

// Para el servidor: los valores presentes en un context_json que no son datos del caso. Un campo
// vacío ("" o []) es un dato pendiente, no un error.
export function findInvalidStage0Fields(contextJson: Record<string, unknown>): Stage0Rejected[] {
  const out: Stage0Rejected[] = [];
  const sector = contextJson.sector;
  if (typeof sector === "string" && sector.trim()) {
    const reason = assessStage0Value("sector", sector);
    if (reason) out.push({ field: "sector", reason });
  }
  for (const field of ["products", "process_focus"] as const) {
    const value = contextJson[field];
    const items: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const item of items) {
      if (typeof item === "string" && !item.trim()) continue;
      const reason = typeof item === "string" ? assessStage0Value(field, item) : "empty";
      if (reason) {
        out.push({ field, reason });
        break;
      }
    }
  }
  return out;
}

export function stage0FieldLabel(field: Stage0Field) {
  if (field === "sector") return "el rubro";
  if (field === "products") return "el producto o servicio";
  return "el área o proceso";
}
