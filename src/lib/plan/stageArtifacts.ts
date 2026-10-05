// src/lib/plan/stageArtifacts.ts
//
// Artefacto final de cada etapa del plan: la fila de plan_stage_artifacts que, con status
// "validated", cierra la etapa. Sin I/O: lo usan la reanudación de etapas (activeStage.ts) y
// el panel docente (src/lib/teacher/dashboard).

export type PlanStageNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type StageResumeGate = { requiredStage: number; artifactType: string };

// Para retomar una etapa hace falta la anterior cerrada con su artefacto final validado.
// Se movió tal cual desde activeStage.ts, que lo sigue usando igual.
export const RESUME_GATE_BY_STAGE: Partial<Record<PlanStageNumber, StageResumeGate>> = {
  2: { requiredStage: 1, artifactType: "productivity_report" },
  3: { requiredStage: 2, artifactType: "foda_analysis" },
  4: { requiredStage: 3, artifactType: "brainstorm_ideas" },
  5: { requiredStage: 4, artifactType: "ishikawa_final" },
  6: { requiredStage: 5, artifactType: "pareto_final" },
  7: { requiredStage: 6, artifactType: "objectives_final" },
  8: { requiredStage: 7, artifactType: "improvement_final" },
  9: { requiredStage: 8, artifactType: "planning_final" },
  10: { requiredStage: 9, artifactType: "progress_final" },
};

// La Etapa 10 cierra con final_doc_final validado (finalDocStore.ts: alreadyClosed).
// final_doc_v1 y final_doc_v2 son las entregas previas (final_doc/validate), en borrador.
export const FINAL_DOC_FINAL_ARTIFACT_TYPE = "final_doc_final";
export const FINAL_DOC_VERSION_ARTIFACT_TYPES = {
  1: "final_doc_v1",
  2: "final_doc_v2",
} as const;

// Artefacto final de E1-E10. E1-E9 salen de RESUME_GATE_BY_STAGE (la etapa requerida y su
// artefacto), así que no hay un segundo mapeo que mantener; E10 sale de final_doc_final.
export const FINAL_ARTIFACT_BY_STAGE: ReadonlyMap<number, string> = new Map([
  ...Object.values(RESUME_GATE_BY_STAGE).flatMap((gate) =>
    gate ? [[gate.requiredStage, gate.artifactType] as const] : []
  ),
  [10, FINAL_DOC_FINAL_ARTIFACT_TYPE] as const,
]);
