// src/lib/plan/ishikawaStateMerge.ts

// Fusión y compactación del estado de Ishikawa (E4) al guardarlo y leerlo, y reparto de la
// autoridad sobre sus campos. Lógica pura, sin I/O; acepta estados sin tipar (state_json de
// la BD o del cliente).
//
// Campos de autoridad del servidor: por subcausa closure, rejectedWhyAttempts y
// reformulateWhy; en el estado, rootCauses y pendingRootMatch. Solo los escribe
// ishikawa/assistant, que los relee de la base antes de decidir. El guardado del cliente
// (ishikawa/state) los descarta y conserva los almacenados. El resto del estado (árbol,
// porqués, cursor) sigue viniendo del cliente.

import { MAX_WHY_DEPTH, MIN_ROOT_CAUSES } from "./rootCauseLimits";
import { dedupeWhys, mergeSubCause } from "./whyList";
import { cloneIshikawaState, type IshikawaState } from "./ishikawaTree";
import { reconcileRootRegistry } from "./ishikawaRootRegistry";

type LooseRecord = Record<string, unknown>;

// Reglas globales de E4 que se fijan siempre en el estado guardado.
export const STAGE4_RULES = {
  minCategories: 3,
  minMainCausesPerCategory: 2,
  minSubCausesPerMain: 1,
  maxWhyDepth: MAX_WHY_DEPTH,
  minRootCandidates: MIN_ROOT_CAUSES,
};

export const SUBCAUSE_SERVER_KEYS = ["closure", "rejectedWhyAttempts", "reformulateWhy"] as const;
export const STATE_SERVER_KEYS = ["rootCauses", "pendingRootMatch"] as const;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null;
}

function records(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function applyStage4Rules(out: LooseRecord): LooseRecord {
  out.minCategories = STAGE4_RULES.minCategories;
  out.minRootCandidates = STAGE4_RULES.minRootCandidates;
  out.minMainCausesPerCategory = STAGE4_RULES.minMainCausesPerCategory;
  out.minSubCausesPerMain = STAGE4_RULES.minSubCausesPerMain;
  out.maxWhyDepth = STAGE4_RULES.maxWhyDepth;
  return out;
}

// Une por id conservando el orden de base; lo entrante gana campo a campo.
function mergeById(base: LooseRecord[], incoming: LooseRecord[]): LooseRecord[] {
  const map = new Map<unknown, LooseRecord>();
  for (const item of base) map.set(item.id, item);

  for (const item of incoming) {
    const prev = map.get(item.id);
    map.set(item.id, prev ? { ...prev, ...item } : item);
  }

  return Array.from(map.values());
}

function byId(list: LooseRecord[], id: unknown): LooseRecord | undefined {
  return list.find((item) => item.id === id);
}

// ✅ Normalizar problema a { text } si viene como string
function normalizeProblem(out: LooseRecord) {
  if (typeof out.problem === "string") {
    const t = out.problem.trim();
    out.problem = t ? { text: t } : out.problem;
  }
}

// Fusiona el estado entrante con el guardado sin perder datos: el problema no se borra si
// el entrante no lo trae; categorías, causas y subcausas se unen por id; los porqués se
// unen (o se reemplazan con whysReplace) y se recortan a MAX_WHY_DEPTH. Lo entrante gana
// campo a campo, también en los campos del servidor: por eso el guardado del cliente pasa
// por mergeClientIshikawaState.
export function mergeIshikawaStateForSave(base: unknown, incoming: unknown): unknown {
  if (!base) return incoming;
  if (!incoming) return base;
  if (!isRecord(base) || !isRecord(incoming)) return incoming;

  const out: LooseRecord = { ...base, ...incoming };
  applyStage4Rules(out);

  // 1) NO permitir que el problema se pierda si incoming no lo trae
  const incomingProblem = incoming.problem;
  const incomingProblemMissing =
    incomingProblem == null ||
    incomingProblem === "" ||
    (isRecord(incomingProblem) && !incomingProblem.text);

  if (incomingProblemMissing) out.problem = base.problem;

  // 2) merge categories -> mainCauses -> subCauses y preservar whys
  const baseCats = records(base.categories);
  const incCats = records(incoming.categories);

  out.categories = mergeById(baseCats, incCats).map((cat) => {
    const baseCat = byId(baseCats, cat.id) ?? {};
    const incCat = byId(incCats, cat.id) ?? cat;
    const mergedCat: LooseRecord = { ...baseCat, ...incCat };

    const baseMains = records(baseCat.mainCauses);
    const incMains = records(incCat.mainCauses);

    mergedCat.mainCauses = mergeById(baseMains, incMains).map((mc) => {
      const baseMc = byId(baseMains, mc.id) ?? {};
      const incMc = byId(incMains, mc.id) ?? mc;
      const mergedMc: LooseRecord = { ...baseMc, ...incMc };

      const baseSubs = records(baseMc.subCauses);
      const incSubs = records(incMc.subCauses);

      // ✅ whys deduplicados por texto y recortados a MAX_WHY_DEPTH. Sin flag se unen con
      //    los guardados; con whysReplace (reemplazo explícito de un porqué) la lista
      //    entrante es autoritativa. whysReplace no se persiste.
      mergedMc.subCauses = mergeById(baseSubs, incSubs).map((sc) =>
        mergeSubCause(byId(baseSubs, sc.id) ?? {}, byId(incSubs, sc.id) ?? sc, STAGE4_RULES.maxWhyDepth)
      );

      return mergedMc;
    });

    return mergedCat;
  });

  normalizeProblem(out);

  return applyStage4Rules(out);
}

// Normaliza el estado para guardarlo o devolverlo: porqués como string[] sin duplicados y
// recortados a MAX_WHY_DEPTH, sin el flag de tránsito whysReplace.
export function compactIshikawaState(state: unknown): unknown {
  if (!isRecord(state)) return state;

  const out: LooseRecord = { ...state };

  out.categories = records(out.categories).map((cat) => ({
    ...cat,
    mainCauses: records(cat.mainCauses).map((mc) => ({
      ...mc,
      subCauses: records(mc.subCauses).map((sc) => {
        // ✅ normalizar siempre a string[] y dedupe + cap
        const sc2: LooseRecord = {
          ...sc,
          whys: dedupeWhys(sc.whys ?? [], [], STAGE4_RULES.maxWhyDepth),
        };
        delete sc2.whysReplace;
        return sc2;
      }),
    })),
  }));

  normalizeProblem(out);
  applyStage4Rules(out);
  return out;
}

// ---------------------------------------------------------------------------
// Campos de autoridad del servidor
// ---------------------------------------------------------------------------

function pathKey(categoryId: unknown, mainCauseId: unknown, subCauseId: unknown): string {
  return JSON.stringify([categoryId, mainCauseId, subCauseId]);
}

// Subcausas de un estado indexadas por ruta (categoría, causa principal, subcausa).
function indexSubCauses(state: unknown): Map<string, LooseRecord> {
  const index = new Map<string, LooseRecord>();
  if (!isRecord(state)) return index;

  for (const cat of records(state.categories)) {
    for (const mc of records(cat.mainCauses)) {
      for (const sc of records(mc.subCauses)) index.set(pathKey(cat.id, mc.id, sc.id), sc);
    }
  }

  return index;
}

// Copia sobre `target` los campos de autoridad del servidor de `source`: los de cada
// subcausa por ruta de ids y los del estado tal cual. Lo que traiga `target` en esos campos
// se descarta; si `source` no los tiene, quedan ausentes.
export function withServerFieldsFrom(target: unknown, source: unknown): unknown {
  if (!isRecord(target)) return target;

  const sourceSubCauses = indexSubCauses(source);
  const out: LooseRecord = { ...target };

  out.categories = records(target.categories).map((cat) => ({
    ...cat,
    mainCauses: records(cat.mainCauses).map((mc) => ({
      ...mc,
      subCauses: records(mc.subCauses).map((sc) => {
        const next: LooseRecord = { ...sc };
        const stored = sourceSubCauses.get(pathKey(cat.id, mc.id, sc.id));

        for (const key of SUBCAUSE_SERVER_KEYS) {
          if (stored && stored[key] !== undefined) next[key] = stored[key];
          else delete next[key];
        }

        return next;
      }),
    })),
  }));

  for (const key of STATE_SERVER_KEYS) {
    if (isRecord(source) && source[key] !== undefined) out[key] = source[key];
    else delete out[key];
  }

  return out;
}

function isIshikawaStateLike(value: unknown): value is IshikawaState {
  return isRecord(value) && Array.isArray(value.categories);
}

// Estado del turno del asistente con los campos del servidor leídos de la base (`source`),
// no del cuerpo de la petición. Sin referencias compartidas con `source`.
export function hydrateServerFields(state: IshikawaState, source: unknown): IshikawaState {
  const hydrated = withServerFieldsFrom(state, source);
  return cloneIshikawaState(isIshikawaStateLike(hydrated) ? hydrated : state);
}

// El registro de raíces queda coherente con el árbol que se va a guardar.
function reconcileIfState(value: unknown): unknown {
  return isIshikawaStateLike(value) ? reconcileRootRegistry(value) : value;
}

// Guardado del cliente (ishikawa/state): se fusiona como siempre, pero los campos del
// servidor salen de lo almacenado; los que mande el cliente se descartan.
export function mergeClientIshikawaState(base: unknown, incoming: unknown, serverSource: unknown): unknown {
  return reconcileIfState(withServerFieldsFrom(mergeIshikawaStateForSave(base, incoming), serverSource));
}

// Escritura del asistente: su estado del turno trae los campos del servidor rehidratados de
// la base y actualizados en el turno, así que en la fusión ganan los suyos. Las subcausas
// que el turno no trae conservan los de la base.
export function mergeAssistantIshikawaState(base: unknown, turnState: unknown): unknown {
  return reconcileIfState(mergeIshikawaStateForSave(base, turnState));
}

// JSON con claves ordenadas: la base (jsonb) no conserva el orden de las claves.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

// Huella de los campos del servidor de un estado: si cambia durante el turno, el asistente
// tiene que escribir antes de responder.
export function serverFieldsFingerprint(state: unknown): string {
  const subCauses: Array<[string, unknown[]]> = [];

  for (const [key, sc] of indexSubCauses(state)) {
    const values = SUBCAUSE_SERVER_KEYS.map((field) => sc[field]);
    if (values.some((value) => value !== undefined)) subCauses.push([key, values]);
  }

  subCauses.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const stateFields = isRecord(state) ? STATE_SERVER_KEYS.map((field) => state[field]) : [];
  return stableStringify([subCauses, stateFields]);
}
