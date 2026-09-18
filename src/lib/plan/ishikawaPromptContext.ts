// src/lib/plan/ishikawaPromptContext.ts

// Contexto del caso para los prompts de Ishikawa (E4). Lógica pura: resume datos ya cargados;
// no consulta la base. El servidor los lee de plan_case_contexts y de los artefactos validados
// de E2 (FODA) y E3 (lluvia de ideas) por el usuario de la sesión (ishikawaContextStore.ts),
// nunca del cuerpo de la petición.
//
// Formas reales en la base: context_json = { sector: string, products: string[],
// process_focus: string[] }; FODA payload.items = { F, O, D, A } con listas de textos o de
// objetos { text | item, evidence }; lluvia de ideas payload.ideas = [{ text }].
// Se resume: pocas entradas y cortas. Nunca se pasa la evidencia del FODA.

type LooseRecord = Record<string, unknown>;

export type IshikawaPromptContext = {
  problem: string | null;
  sector: string | null;
  products: string[];
  areas: string[];
  fodaWeaknesses: string[];
  fodaThreats: string[];
  brainstormIdeas: string[];
};

const MAX_ITEM_CHARS = 140;
const MAX_CASE_ITEMS = 5;
const MAX_FODA_ITEMS = 4;
const MAX_BRAINSTORM_IDEAS = 8;

// Regla para todos los prompts que redactan para el estudiante.
export const NO_PROPER_NAMES_RULE =
  "No escribas nombres propios de empresas ni de personas, aunque aparezcan en el contexto: di «la empresa», «el encargado», «el operario».";

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max = MAX_ITEM_CHARS): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item)) {
    for (const key of ["text", "item", "name"]) {
      const value = item[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

// Lista de textos a partir de un arreglo (de textos u objetos con text/item/name) o de un texto.
function textList(value: unknown, max: number): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];

  for (const item of items) {
    const text = clip(itemText(item));
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length >= max) break;
  }

  return out;
}

function firstList(record: LooseRecord, keys: readonly string[], max: number): string[] {
  for (const key of keys) {
    const list = textList(record[key], max);
    if (list.length > 0) return list;
  }
  return [];
}

function firstText(record: LooseRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, 80);
  }
  return null;
}

// Rubro, productos y áreas del caso (E0). Acepta las claves reales (sector, products,
// process_focus) y las variantes antiguas (rubro, product, producto, areas, area).
export function readCaseFacts(contextJson: unknown): { sector: string | null; products: string[]; areas: string[] } {
  if (!isRecord(contextJson)) return { sector: null, products: [], areas: [] };

  return {
    sector: firstText(contextJson, ["sector", "rubro"]),
    products: firstList(contextJson, ["products", "product", "producto", "productos"], MAX_CASE_ITEMS),
    areas: firstList(contextJson, ["process_focus", "areas", "area"], MAX_CASE_ITEMS),
  };
}

// Debilidades y amenazas del FODA validado (lo más cercano a causas del problema).
export function summarizeFoda(payload: unknown): { weaknesses: string[]; threats: string[] } {
  const items = isRecord(payload) && isRecord(payload.items) ? payload.items : null;
  if (!items) return { weaknesses: [], threats: [] };

  return {
    weaknesses: textList(items.D, MAX_FODA_ITEMS),
    threats: textList(items.A, MAX_FODA_ITEMS),
  };
}

// Ideas de la lluvia de ideas validada.
export function summarizeBrainstorm(payload: unknown): string[] {
  return isRecord(payload) ? textList(payload.ideas, MAX_BRAINSTORM_IDEAS) : [];
}

// "a", "a y b", "a, b y c".
export function joinReadable(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

export function buildIshikawaPromptContext(input: {
  problem: string | null;
  caseContext: unknown;
  foda: unknown;
  brainstorm: unknown;
}): IshikawaPromptContext {
  const facts = readCaseFacts(input.caseContext);
  const foda = summarizeFoda(input.foda);
  const problem = input.problem ? clip(input.problem, 300) : null;

  return {
    problem: problem || null,
    sector: facts.sector,
    products: facts.products,
    areas: facts.areas,
    fodaWeaknesses: foda.weaknesses,
    fodaThreats: foda.threats,
    brainstormIdeas: summarizeBrainstorm(input.brainstorm),
  };
}

export const EMPTY_PROMPT_CONTEXT: IshikawaPromptContext = {
  problem: null,
  sector: null,
  products: [],
  areas: [],
  fodaWeaknesses: [],
  fodaThreats: [],
  brainstormIdeas: [],
};

export function hasBrainstorm(context: IshikawaPromptContext): boolean {
  return context.brainstormIdeas.length > 0;
}

export function hasFoda(context: IshikawaPromptContext): boolean {
  return context.fodaWeaknesses.length > 0 || context.fodaThreats.length > 0;
}

// Bloque de texto con el contexto disponible. Solo aparecen los datos que existen; si no hay
// ninguno, lo dice (el prompt no debe pedir coherencia con algo que no recibe).
export function formatCaseContextBlock(
  context: IshikawaPromptContext,
  options: { foda?: boolean; brainstorm?: boolean } = {}
): string {
  const lines: string[] = [];

  if (context.problem) lines.push(`- Problema (cabeza del Ishikawa): ${context.problem}`);
  if (context.sector) lines.push(`- Rubro: ${context.sector}`);
  if (context.products.length > 0) lines.push(`- Productos o servicios: ${joinReadable(context.products)}`);
  if (context.areas.length > 0) lines.push(`- Áreas o procesos en foco: ${joinReadable(context.areas)}`);

  if (options.foda && context.fodaWeaknesses.length > 0) {
    lines.push("- Debilidades del FODA (Etapa 2):", ...context.fodaWeaknesses.map((item) => `  • ${item}`));
  }
  if (options.foda && context.fodaThreats.length > 0) {
    lines.push("- Amenazas del FODA (Etapa 2; son externas, no son causas accionables):", ...context.fodaThreats.map((item) => `  • ${item}`));
  }
  if (options.brainstorm && context.brainstormIdeas.length > 0) {
    lines.push("- Ideas de la lluvia de ideas (Etapa 3):", ...context.brainstormIdeas.map((item) => `  • ${item}`));
  }

  return lines.length > 0 ? lines.join("\n") : "- (sin datos del caso disponibles)";
}
