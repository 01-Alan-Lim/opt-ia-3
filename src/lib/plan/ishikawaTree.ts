// src/lib/plan/ishikawaTree.ts

// Modelo del árbol Ishikawa (E4) compartido por cliente y servidor. Sin I/O.
// Árbol: categories -> mainCauses -> subCauses -> whys[]; el cursor apunta a la rama activa.

import { z } from "zod";

// Cierre explícito de una rama (subcausa). Solo lo escribe el servidor (ishikawa/assistant)
// cuando el gate de calidad (decideWhyStep) devuelve "close". Si falta o no tiene esta forma,
// la rama cuenta como no revisada.
// - verdict: qué dictaminó el gate. Hoy solo se cierra con "actionable".
// - origin: quién inició el cierre: el estudiante ("cerremos") o el sistema (ruta rápida, o el
//   LLM al soltar el cursor), siempre validado por el gate.
// - rootId: entrada del registro de causas raíz (state.rootCauses) de esta rama; null
//   mientras no se resolvió o después de reabrirla.
export const BranchClosureSchema = z.object({
  reviewed: z.boolean(),
  at: z.string(), // ISO 8601
  verdict: z.literal("actionable"),
  origin: z.enum(["student_confirm", "system"]),
  rootId: z.string().nullable(),
});

export type BranchClosure = z.infer<typeof BranchClosureSchema>;

// Registro de causas raíz (state.rootCauses): identidad de cada raíz, en qué ramas apareció y
// qué pares declaró distintos el estudiante. Campo de autoridad del servidor. La lógica está
// en ishikawaRootRegistry.ts.
export const RootOccurrenceSchema = z.object({
  categoryId: z.string(),
  mainCauseId: z.string(),
  subCauseId: z.string(),
  text: z.string(), // la raíz tal como quedó en esa rama
});

export const RootCauseEntrySchema = z.object({
  id: z.string(), // lo genera el servidor
  canonicalText: z.string(), // como lo escribió el estudiante la primera vez
  normalizedText: z.string(), // minúsculas + espacios normalizados
  occurrences: z.array(RootOccurrenceSchema),
  distinctFrom: z.array(z.string()), // ids que el estudiante ya declaró distintos
  // Se registró mientras había otra pregunta abierta y tenía candidatas parecidas: se compara
  // cuando el estudiante responda la pendiente (resolveDeferredRootQuestion).
  recheck: z.boolean().optional(),
});

// Pregunta abierta al estudiante: ¿la raíz provisoria (rootId) de esa rama es la misma que la
// candidata (candidateId)? Campo de autoridad del servidor.
export const PendingRootMatchSchema = z.object({
  categoryId: z.string(),
  mainCauseId: z.string(),
  subCauseId: z.string(),
  rootId: z.string(),
  candidateId: z.string(),
  reason: z.string(),
  askedAt: z.string(),
});

export type RootOccurrence = z.infer<typeof RootOccurrenceSchema>;
export type RootCauseEntry = z.infer<typeof RootCauseEntrySchema>;
export type PendingRootMatch = z.infer<typeof PendingRootMatchSchema>;

// Registro leído de un estado sin tipar: se descartan las entradas con otra forma.
export function parseRootRegistry(value: unknown): RootCauseEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item: unknown) => {
    const parsed = RootCauseEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parsePendingRootMatch(value: unknown): PendingRootMatch | null {
  const parsed = PendingRootMatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type IshikawaWhy = string | { id?: string; text?: string };

export type IshikawaSubCause = {
  id: string;
  text?: string;
  name?: string;
  whys?: IshikawaWhy[];
  rejectedWhyAttempts?: number; // rechazos deterministas seguidos en esta subcausa
  reformulateWhy?: boolean; // el próximo porqué aceptado reemplaza al último
  whysReplace?: boolean; // solo en tránsito: la lista de porqués es autoritativa al guardar
  closure?: BranchClosure;
};

export type IshikawaMainCause = {
  id: string;
  text?: string;
  name?: string;
  subCauses: IshikawaSubCause[];
};

export type IshikawaCategory = {
  id: string;
  name: string;
  mainCauses: IshikawaMainCause[];
};

export type IshikawaCursor = {
  categoryId?: string;
  mainCauseId?: string;
  subCauseId?: string;
};

export type IshikawaState = {
  problem: { text: string } | string | null;
  categories: IshikawaCategory[];
  minCategories: number; // 4-5
  minMainCausesPerCategory: number; // 2-3
  minSubCausesPerMain: number; // 2-3
  maxWhyDepth: number; // tope de porqués (MAX_WHY_DEPTH)
  cursor?: IshikawaCursor | null;
  rootCauses?: RootCauseEntry[]; // registro de causas raíz (autoridad del servidor)
  pendingRootMatch?: PendingRootMatch | null; // pregunta abierta sobre una raíz repetida
};

// Estado de E4 tal como llega del cliente (ishikawa/state, ishikawa/assistant). Valida la
// forma del árbol y conserva los campos desconocidos (z.looseObject): los estados reales
// guardan claves que el código no declara (pendingHypotheses, whysCount…) y no deben perderse.
const WhyInputSchema = z.union([
  z.string(),
  z.looseObject({ id: z.string().optional(), text: z.string().optional() }),
]);

const SubCauseInputSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  text: z.string().optional(),
  whys: z.array(WhyInputSchema).optional(),
});

const MainCauseInputSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  text: z.string().optional(),
  subCauses: z.array(SubCauseInputSchema).optional(),
});

const CategoryInputSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  mainCauses: z.array(MainCauseInputSchema).optional(),
});

// Los ids del cursor pueden llegar en null: el LLM los devuelve así al soltar una rama y hay
// estados reales guardados de esa forma. Rechazarlos dejaría el turno en 400; se normalizan
// a ausentes.
const CursorIdInputSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

export const IshikawaStateInputSchema = z.looseObject({
  problem: z
    .union([z.string(), z.looseObject({ text: z.string().optional() }), z.null()])
    .optional(),
  categories: z.array(CategoryInputSchema).optional(),
  cursor: z
    .looseObject({
      categoryId: CursorIdInputSchema,
      mainCauseId: CursorIdInputSchema,
      subCauseId: CursorIdInputSchema,
    })
    .nullable()
    .optional(),
});

// Closure con la forma válida, o null. Acepta unknown para leer estados sin tipar.
export function parseBranchClosure(closure: unknown): BranchClosure | null {
  const parsed = BranchClosureSchema.safeParse(closure);
  return parsed.success ? parsed.data : null;
}

// Una rama está revisada solo con un closure válido y reviewed === true. Sin el campo
// (estados anteriores a este cambio) o con otra forma, no lo está.
export function isClosureReviewed(closure: unknown): boolean {
  return parseBranchClosure(closure)?.reviewed === true;
}

export function cloneIshikawaState(state: IshikawaState): IshikawaState {
  return JSON.parse(JSON.stringify(state)) as IshikawaState;
}

// Rama activa según el cursor: categoría y causa principal obligatorias; la subcausa
// puede faltar (cursor a nivel de causa principal).
export function findActiveNodes(state: IshikawaState) {
  const catId = state.cursor?.categoryId;
  const mcId = state.cursor?.mainCauseId;
  const scId = state.cursor?.subCauseId;

  if (!catId || !mcId) return null;

  const cat = (state.categories ?? []).find((c) => c.id === catId);
  if (!cat) return null;

  const mc = (cat.mainCauses ?? []).find((m) => m.id === mcId);
  if (!mc) return null;

  const sc = scId ? (mc.subCauses ?? []).find((s) => s.id === scId) ?? null : null;

  return { cat, mc, sc };
}

// Porqués guardados como texto (string, o { text } en estados antiguos), sin vacíos.
export function whyTexts(whys: unknown): string[] {
  if (!Array.isArray(whys)) return [];

  return whys
    .map((why: unknown) => {
      if (typeof why === "string") return why.trim();
      if (typeof why === "object" && why !== null && "text" in why && typeof why.text === "string") {
        return why.text.trim();
      }
      return "";
    })
    .filter(Boolean);
}

// Señales de un turno del asistente para el cliente: el flujo se decide con estas
// banderas y no leyendo el texto del mensaje.
// - branchJustClosed: en este turno se cerró una rama (se escribió un closure revisado).
// - offerStageClose: el turno admite ofrecer el paso a Pareto (nunca en el mismo turno que
//   un cierre de rama); el cliente además exige que el estado cumpla los mínimos.
// - awaitingWhy: tras el turno queda una subcausa abierta y se espera un porqué.
// - awaitingRootMatch: hay una pregunta abierta (¿dos causas raíz son la misma?). Mientras
//   tanto no se ofrece el paso a Pareto: el "sí"/"no" del estudiante responde esa pregunta.
export const IshikawaTurnUiSchema = z.object({
  branchJustClosed: z.boolean(),
  offerStageClose: z.boolean(),
  awaitingWhy: z.boolean(),
  awaitingRootMatch: z.boolean(),
});

export type IshikawaTurnUi = z.infer<typeof IshikawaTurnUiSchema>;

// Sin señales válidas (respuesta de error o de una versión anterior) no se ofrece nada.
export const NO_TURN_UI: IshikawaTurnUi = {
  branchJustClosed: false,
  offerStageClose: false,
  awaitingWhy: false,
  awaitingRootMatch: false,
};

export function buildIshikawaTurnUi(
  state: IshikawaState,
  signals: { branchJustClosed?: boolean } = {}
): IshikawaTurnUi {
  const branchJustClosed = signals.branchJustClosed === true;
  const awaitingRootMatch = parsePendingRootMatch(state.pendingRootMatch) !== null;

  return {
    branchJustClosed,
    offerStageClose: !branchJustClosed && !awaitingRootMatch,
    awaitingWhy: Boolean(findActiveNodes(state)?.sc),
    awaitingRootMatch,
  };
}

export function parseIshikawaTurnUi(value: unknown): IshikawaTurnUi {
  const parsed = IshikawaTurnUiSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...NO_TURN_UI };
}
