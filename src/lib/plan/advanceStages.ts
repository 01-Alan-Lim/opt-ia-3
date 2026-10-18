// src/lib/plan/advanceStages.ts
//
// Referencia académica entre los avances de la cohorte (cohort_events ADVANCE 1-3) y las etapas
// del plan. Es la misma que el flujo ya le comunica al estudiante:
// - context/confirm: confirmar E0 "habilita Avance 1";
// - pareto/validate: al cerrar E5, "Ya puedes continuar al Avance 2";
// - planning/validate: al cerrar E8, "se completa el Avance 2. Luego sigue el Avance 3: Etapa 9".
// E10 queda fuera de los tres avances. Sin I/O.
//
// Es una REFERENCIA, no una regla de cumplimiento: la base no registra si un estudiante cumplió
// un avance ni qué tenía que entregar en su fecha.

import type { PlanStageNumber } from "./stageArtifacts";

export type AdvanceIndex = 1 | 2 | 3;

export type AdvanceStageRange = { from: PlanStageNumber; to: PlanStageNumber };

export const ADVANCE_INDEXES: readonly AdvanceIndex[] = [1, 2, 3];

export const ADVANCE_REFERENCE_STAGES: Readonly<Record<AdvanceIndex, AdvanceStageRange>> = {
  1: { from: 1, to: 5 },
  2: { from: 6, to: 8 },
  3: { from: 9, to: 9 },
};

export function isAdvanceIndex(value: number | null): value is AdvanceIndex {
  return value === 1 || value === 2 || value === 3;
}

// Mismo texto que el recordatorio de Google Calendar ("OPT-IA • Avance N").
export function advanceLabel(index: AdvanceIndex): string {
  return `Avance ${index}`;
}
