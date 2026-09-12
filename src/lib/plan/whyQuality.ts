// src/lib/plan/whyQuality.ts

// Calidad de un porqué en Ishikawa (E4). Lógica pura: sin I/O ni llamadas a red.
// Decisión metodológica (CLAUDE.md): la rama se cierra por CALIDAD (la causa es
// accionable), no por contador. El filtro determinista solo bloquea casos evidentes;
// el juicio de accionabilidad lo da el LLM, y su ausencia o fallo nunca cierra.

import { z } from "zod";

import { MAX_WHY_DEPTH, MIN_WHY_DEPTH } from "./rootCauseLimits";

export type WhyBlockReason =
  | "tautology" // repite la subcausa o un porqué anterior
  | "external_only" // atribuye todo a un agente fuera del control de la empresa
  | "too_generic"; // generalidad sin objeto concreto

export type DeterministicVerdict =
  | { closable: false; reason: WhyBlockReason; hint: string }
  | { closable: true }; // pasa el filtro barato; falta el juicio de calidad

export type LlmActionabilityVerdict = { actionable: boolean; reason: string };

export type WhyStepDecision =
  | { action: "ask_next"; hint?: string }
  | { action: "consult_quality" } // aquí se consulta al LLM
  | { action: "close" }
  | { action: "reformulate"; hint: string };

// Tautología: el porqué no agrega nada respecto de la subcausa o de un porqué previo.
// Se bloquea si (a) todos sus tokens significativos ya están en la referencia, o
// (b) el índice de Jaccard entre ambos conjuntos es >= 0.8 (casi las mismas palabras).
// Umbral alto a propósito: profundizar reutiliza palabras del porqué anterior
// ("no se revisa el stock" -> "no existe un procedimiento que asigne quién revisa el
// stock" comparte 3 de 9 tokens, Jaccard 0,33) y eso no debe bloquearse.
export const TAUTOLOGY_JACCARD_THRESHOLD = 0.8;

// Con menos tokens significativos que esto, el porqué no nombra ningún objeto.
export const MIN_SIGNIFICANT_TOKENS = 2;

// Los términos de las listas van normalizados: minúsculas, sin acentos, en singular.
// Se comparan como prefijos de cada token ("proveedor" cubre "proveedores").

// Agentes fuera del control de la empresa.
export const EXTERNAL_AGENT_TERMS = [
  "clima",
  "lluvi",
  "sequi",
  "inundaci",
  "temporad",
  "mercado",
  "competenc",
  "competidor",
  "gobiern",
  "municipi",
  "alcaldi",
  "impuest",
  "arancel",
  "regulaci",
  "inflaci",
  "economi",
  "crisis",
  "dolar",
  "pandemi",
  "proveedor",
  "client",
  "transportist",
] as const;

// Mecanismos y actores internos: si aparece alguno, el porqué no es "solo externo".
export const INTERNAL_MECHANISM_TERMS = [
  "procedimient",
  "proceso",
  "estandar",
  "control",
  "registr",
  "inspecc",
  "supervis",
  "capacit",
  "entren",
  "induccion",
  "planific",
  "plan",
  "programac",
  "mantenim",
  "inventari",
  "contrat",
  "evalu",
  "selecc",
  "homolog",
  "acuerd",
  "politic",
  "responsab",
  "asign",
  "verific",
  "revis",
  "coordin",
  "indicador",
  "seguimient",
  "criteri",
  "especificac",
  "checklist",
  "instructiv",
  "manual",
  "protocol",
  "presupuest",
  "prioriz",
  "document",
  "compra",
  "climatiz",
  "refriger",
  "ventilac",
  "personal",
  "operari",
  "trabajador",
  "emplead",
  "jefe",
  "encargad",
  "gerenci",
  "gerente",
  "area",
  "departament",
  "turno",
  "empresa",
  "nuestr",
  "vendedor",
] as const;

// Ausencias internas ("no se controla", "no hay", "sin", "falta"): el porqué habla de
// algo que la empresa hace o deja de hacer.
export const INTERNAL_ABSENCE_MARKERS = [
  "no se",
  "no hay",
  "no existe",
  "no tiene",
  "no cuenta",
  "sin",
  "falta",
  "faltan",
] as const;

// Fórmulas vacías: un porqué compuesto solo de estas palabras no tiene objeto concreto.
export const VAGUE_QUALIFIER_TERMS = [
  "falta",
  "mala",
  "malo",
  "mal",
  "poca",
  "poco",
  "deficiente",
  "bajo",
  "baja",
  "escaso",
  "escasa",
  "inadecuado",
  "inadecuada",
  "no",
  "sin",
  "problema",
  "general",
] as const;

export const VAGUE_NOUN_TERMS = [
  "organizacion",
  "gestion",
  "control",
  "orden",
  "comunicacion",
  "coordinacion",
  "compromiso",
  "interes",
  "motivacion",
  "cuidado",
  "atencion",
  "disciplina",
  "responsabilidad",
  "voluntad",
  "planificacion",
  "administracion",
] as const;

const SPANISH_STOPWORDS = new Set([
  "a", "al", "algo", "ante", "asi", "aun", "cada", "como", "con", "cual", "cuando",
  "de", "del", "desde", "donde", "e", "el", "ella", "ellos", "en", "entre", "era",
  "es", "esa", "ese", "eso", "esta", "estan", "este", "esto", "fue", "ha", "han",
  "hace", "hacen", "hasta", "hay", "la", "las", "le", "les", "lo", "los", "mas",
  "me", "mi", "mis", "muy", "ni", "nos", "o", "otra", "otro", "para", "pero", "por",
  "porque", "pues", "que", "quien", "se", "segun", "ser", "si", "sido", "sobre",
  "son", "su", "sus", "tambien", "tiene", "tienen", "todo", "toda", "todos",
  "todas", "tu", "u", "un", "una", "unas", "uno", "unos", "ya", "y",
]);

const VAGUE_QUALIFIERS = new Set<string>(VAGUE_QUALIFIER_TERMS);
const VAGUE_NOUNS = new Set<string>(VAGUE_NOUN_TERMS);

const HINT_TOO_GENERIC =
  'Esa idea es muy general. Di sobre qué cosa concreta ocurre (qué proceso, registro o equipo) y en qué momento. Por ejemplo: "no se registra la temperatura del horno en cada lote".';

const HINT_EXTERNAL_ONLY =
  "Eso depende de alguien fuera de la empresa y tu plan no lo puede cambiar. Busca qué hace o deja de hacer la empresa frente a eso: por ejemplo, si lo controla, lo registra o lo acuerda con ese actor.";

export const HINT_LLM_NOT_ACTIONABLE =
  "Todavía no es algo que la empresa pueda cambiar directamente. Pregúntate qué falla dentro de la empresa (un proceso, un control o un responsable) para que eso ocurra.";

export const HINT_REFORMULATE =
  "Llegamos al último porqué y la causa todavía no es algo que la empresa pueda cambiar directamente. Reformulémosla: ¿qué proceso, control o responsable de la empresa falla para que esto pase?";

function normalizeWhyText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Singular aproximado: quita la "s" final (sin tocar "crisis", "análisis").
function stemToken(token: string): string {
  return token.length > 4 && token.endsWith("s") && !token.endsWith("is")
    ? token.slice(0, -1)
    : token;
}

function significantTokens(text: string): string[] {
  return normalizeWhyText(text)
    .split(" ")
    .filter((token) => token.length >= 2 && !SPANISH_STOPWORDS.has(token))
    .map(stemToken);
}

function hasTermPrefix(tokens: readonly string[], terms: readonly string[]): boolean {
  return tokens.some((token) => terms.some((term) => token.startsWith(term)));
}

function isTautology(whyTokens: readonly string[], referenceTokens: readonly string[]): boolean {
  const why = new Set(whyTokens);
  const reference = new Set(referenceTokens);

  const shared = [...why].filter((token) => reference.has(token)).length;
  if (shared === why.size) return true;

  const union = new Set([...why, ...reference]).size;
  return union > 0 && shared / union >= TAUTOLOGY_JACCARD_THRESHOLD;
}

function isTooGeneric(tokens: readonly string[]): boolean {
  if (tokens.length < MIN_SIGNIFICANT_TOKENS) return true;

  return (
    tokens.every((token) => VAGUE_QUALIFIERS.has(token) || VAGUE_NOUNS.has(token)) &&
    tokens.some((token) => VAGUE_NOUNS.has(token))
  );
}

function isExternalOnly(normalizedWhy: string, tokens: readonly string[]): boolean {
  if (!hasTermPrefix(tokens, EXTERNAL_AGENT_TERMS)) return false;
  if (hasTermPrefix(tokens, INTERNAL_MECHANISM_TERMS)) return false;

  const padded = ` ${normalizedWhy} `;
  return !INTERNAL_ABSENCE_MARKERS.some((marker) => padded.includes(` ${marker} `));
}

function quote(text: string, max = 80): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * Filtro determinista y conservador: bloquea solo casos evidentes (tautología, causa
 * solo externa, generalidad sin objeto); ante la duda devuelve `closable: true`.
 *
 * Contrato de uso:
 * - Se llama con el porqué CANDIDATO y con `previousWhys` = los porqués ya guardados
 *   en la rama, ANTES de agregar el candidato.
 * - Si devuelve `closable: false`, el llamador NO debe persistir el candidato ni
 *   incrementar la profundidad: responde con `hint` y espera otra respuesta.
 */
export function evaluateWhyDeterministic(input: {
  why: string;
  subCauseText: string;
  previousWhys: readonly string[];
}): DeterministicVerdict {
  const whyTokens = significantTokens(input.why);

  if (whyTokens.length === 0) {
    return { closable: false, reason: "too_generic", hint: HINT_TOO_GENERIC };
  }

  for (const reference of [input.subCauseText, ...input.previousWhys]) {
    const referenceTokens = significantTokens(reference);
    if (referenceTokens.length === 0) continue;

    if (isTautology(whyTokens, referenceTokens)) {
      return {
        closable: false,
        reason: "tautology",
        hint: `Esa respuesta dice casi lo mismo que "${quote(reference)}". Da un paso más atrás: ¿qué hace o deja de hacer la empresa para que eso ocurra?`,
      };
    }
  }

  if (isTooGeneric(whyTokens)) {
    return { closable: false, reason: "too_generic", hint: HINT_TOO_GENERIC };
  }

  if (isExternalOnly(normalizeWhyText(input.why), whyTokens)) {
    return { closable: false, reason: "external_only", hint: HINT_EXTERNAL_ONLY };
  }

  return { closable: true };
}

function reasonOrDefault(reason: string, fallback: string): string {
  const value = reason.replace(/\s+/g, " ").trim();
  return value || fallback;
}

/**
 * Máquina de decisión de una rama de porqués. Sin efectos.
 *
 * Contrato de uso:
 * - `depth` = cantidad de porqués DESPUÉS de agregar el candidato aceptado. Un
 *   candidato rechazado por evaluateWhyDeterministic no se agrega ni cuenta, así que
 *   con un veredicto bloqueado `depth` es la profundidad actual de la rama.
 * - `llmVerdict`: undefined = aún no se consultó al LLM; null = se consultó y falló.
 * - El filtro determinista manda primero en todas las profundidades: si bloquea, no
 *   se pide consultar al LLM.
 * - REGLA DURA: sin un veredicto accionable explícito del LLM nunca se devuelve
 *   "close", en ninguna profundidad.
 */
export function decideWhyStep(input: {
  depth: number;
  deterministic: DeterministicVerdict;
  llmVerdict?: LlmActionabilityVerdict | null;
}): WhyStepDecision {
  const { depth, deterministic, llmVerdict } = input;

  // Antes del mínimo nunca se cierra; el determinista solo informa con su pista.
  if (depth < MIN_WHY_DEPTH) {
    return deterministic.closable
      ? { action: "ask_next" }
      : { action: "ask_next", hint: deterministic.hint };
  }

  if (depth < MAX_WHY_DEPTH) {
    if (!deterministic.closable) return { action: "ask_next", hint: deterministic.hint };
    if (llmVerdict === undefined) return { action: "consult_quality" };
    if (llmVerdict === null) return { action: "ask_next" };

    return llmVerdict.actionable
      ? { action: "close" }
      : { action: "ask_next", hint: reasonOrDefault(llmVerdict.reason, HINT_LLM_NOT_ACTIONABLE) };
  }

  // Tope duro: sin veredicto accionable explícito se reformula.
  if (!deterministic.closable) return { action: "reformulate", hint: deterministic.hint };
  if (llmVerdict === undefined) return { action: "consult_quality" };
  if (llmVerdict === null) return { action: "reformulate", hint: HINT_REFORMULATE };

  return llmVerdict.actionable
    ? { action: "close" }
    : { action: "reformulate", hint: reasonOrDefault(llmVerdict.reason, HINT_REFORMULATE) };
}

const LlmActionabilitySchema = z.object({
  actionable: z.boolean(),
  reason: z.string(),
});

function parseJsonLoose(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned) return undefined;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Intenta con el primer bloque { ... } del texto.
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// Valida la respuesta del LLM. JSON inválido o forma inesperada -> null, que el
// llamador trata como "no cerrar". Nunca lanza excepciones.
export function interpretLlmActionabilityResponse(raw: unknown): LlmActionabilityVerdict | null {
  const candidate = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const parsed = LlmActionabilitySchema.safeParse(candidate);
  if (!parsed.success) return null;

  return {
    actionable: parsed.data.actionable,
    reason: parsed.data.reason.replace(/\s+/g, " ").trim().slice(0, 500),
  };
}
