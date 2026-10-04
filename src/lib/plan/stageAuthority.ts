// src/lib/plan/stageAuthority.ts

// Reparto de autoridad sobre el estado de cada etapa, y qué admite el endpoint genérico
// /api/plans/stage-state.
//
// El problema que resuelve: /api/plans/stage-state aceptaba cualquier `stage` con
// cualquier `stateJson` y, para las etapas 0 a 5, lo escribía tal cual (el `default` de
// mergeStageState). Corre con service role, así que ninguna policy de RLS lo detiene. Por
// ahí se podía escribir el estado de E4 saltándose ishikawa/state, que es quien descarta
// los campos de autoridad del servidor (closure, rootCauses, pendingRootMatch…).
//
// La corrección NO duplica la lógica de cada etapa: el endpoint genérico deja de aceptar
// las etapas que ya tienen una ruta propia con su fusión protegida, y cada ruta propia
// sigue siendo la única puerta de su etapa.
//
// Autoridad por etapa (dónde se hace cumplir):
//   E0  plan_case_contexts, no plan_stage_states. Gate en context/confirm (hasMinimum).
//   E1  el reporte vive en plan_stage_artifacts; validate recalcula el score entero.
//   E2  sin campos del servidor hoy. pendingEvidence ES autoridad de facto y NO está
//       protegido todavía: ver la nota al final.
//   E3  minIdeas -> MIN_BRAINSTORM_IDEAS en brainstormFlow.ts; nunca se lee del estado.
//   E4  closure, rejectedWhyAttempts, reformulateWhy (por subcausa), rootCauses y
//       pendingRootMatch (del estado) -> ishikawaStateMerge.withServerFieldsFrom;
//       minCategories, minMainCausesPerCategory, minSubCausesPerMain, maxWhyDepth y
//       minRootCandidates -> ishikawaStateMerge.applyStage4Rules (STAGE4_RULES).
//   E5  sin campos del servidor en el estado: pareto/validate re-deriva roots,
//       selectedRoots y criticalRoots contra ishikawa_final antes de decidir.
//   E6-E9 sin campos del servidor: validate recalcula cada regla sobre el contenido.
//   E10 evaluation y versionNumber -> los escribe final_doc/assistant en la base y el
//       guardado del cliente los descarta (withStoredFinalDocAuthority).

export type PlanStageNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

// Etapas cuyo estado puede escribirse por el endpoint genérico. Son exactamente las que
// el cliente guarda por ahí (chat/page.tsx: saveGenericStageState(6..10)). Las demás
// tienen ruta propia y deben pasar por ella.
export const GENERIC_STATE_WRITE_STAGES: readonly PlanStageNumber[] = [6, 7, 8, 9, 10];

// Etapas cuyo estado de trabajo puede borrarse por el endpoint genérico. Son las que el
// cliente limpia al avanzar (chat/page.tsx: clearStageState(2..9)). E0 y E1 no guardan
// estado de trabajo aquí, y E10 guarda la evaluación escrita por el servidor: borrarla
// dejaría reintentar la versión 1 con otra nota.
export const GENERIC_STATE_DELETE_STAGES: readonly PlanStageNumber[] = [2, 3, 4, 5, 6, 7, 8, 9];

// Ruta propia de cada etapa que no pasa por el endpoint genérico.
const DEDICATED_STATE_ROUTE: Readonly<Record<number, string>> = {
  0: "/api/plans/context",
  1: "/api/plans/productivity/state",
  2: "/api/plans/foda/state",
  3: "/api/plans/brainstorm/state",
  4: "/api/plans/ishikawa/state",
  5: "/api/plans/pareto/state",
};

export function canWriteStageStateGenerically(stage: number): boolean {
  return (GENERIC_STATE_WRITE_STAGES as readonly number[]).includes(stage);
}

export function canDeleteStageStateGenerically(stage: number): boolean {
  return (GENERIC_STATE_DELETE_STAGES as readonly number[]).includes(stage);
}

export function dedicatedStateRouteFor(stage: number): string | null {
  return DEDICATED_STATE_ROUTE[stage] ?? null;
}

// Mensaje de rechazo del endpoint genérico, con la ruta propia cuando la hay.
export function describeGenericWriteRejection(stage: number): string {
  const route = dedicatedStateRouteFor(stage);

  return route
    ? `El estado de la Etapa ${stage} se guarda por ${route}, no por esta ruta.`
    : `Esta ruta no guarda el estado de la Etapa ${stage}.`;
}

// ---------------------------------------------------------------------------
// Etapa 10: campos de autoridad del servidor
// ---------------------------------------------------------------------------

// evaluation lo produce el LLM dentro de final_doc/assistant y versionNumber lo deriva el
// servidor de los artefactos ya guardados. Los dos deciden si el plan se cierra
// (final_doc/validate), así que no pueden venir del cuerpo de la petición.
export const FINAL_DOC_SERVER_KEYS = ["evaluation", "versionNumber"] as const;

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Devuelve `incoming` con los campos de autoridad de E10 tomados de `stored`. Lo que traiga
// el cliente en esos campos se descarta; si `stored` no los tiene, quedan ausentes y el
// normalizador aplica su valor por defecto.
export function withStoredFinalDocAuthority(incoming: unknown, stored: unknown): LooseRecord {
  const out: LooseRecord = isRecord(incoming) ? { ...incoming } : {};

  for (const key of FINAL_DOC_SERVER_KEYS) {
    if (isRecord(stored) && stored[key] !== undefined) out[key] = stored[key];
    else delete out[key];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Pendiente conocido
// ---------------------------------------------------------------------------
// E2: foda/validate rechaza si state.pendingEvidence está puesto, pero ese campo lo manda
// el cliente (foda/state lo acepta dentro de FodaStateSchema) y borrarlo salta el gate de
// evidencia. Protegerlo de verdad exige que foda/assistant lo escriba en la base, como hace
// ishikawa/assistant con los suyos; es un cambio de diseño de E2 y queda fuera de esta
// tanda. El mínimo de 3 ítems por cuadrante sigue aplicándose igual.
