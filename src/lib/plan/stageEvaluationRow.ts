// src/lib/plan/stageEvaluationRow.ts
//
// Fila que las validaciones de E4-E8 (ishikawa, pareto, objectives, improvement, planning)
// insertan en plan_stage_evaluations. Sin I/O.
//
// Solo lleva columnas reales de la tabla. Esas rutas mandaban además status y payload_json, que
// no existen: PostgREST rechazaba el insert entero, la ruta lo tomaba como aviso y la etapa se
// validaba sin evaluación. Las validaciones de E4-E8 anteriores a este cambio no tienen fila y
// no se reconstruyen.
// version y created_at no se mandan: quedan con su default (1 y now()), igual que en E2, E3, E9
// y E10.

// Columnas de public.plan_stage_evaluations según el esquema real.
export const PLAN_STAGE_EVALUATION_COLUMNS = [
  "id",
  "user_id",
  "chat_id",
  "stage",
  "artifact_type",
  "artifact_id",
  "period_key",
  "version",
  "rubric_json",
  "result_json",
  "total_score",
  "total_label",
  "created_at",
] as const;

export type PlanStageEvaluationColumn = (typeof PLAN_STAGE_EVALUATION_COLUMNS)[number];

// Evaluación de Gemini ya comprobada por la ruta (total_score numérico). Va entera a result_json.
export type StageEvaluationResult = { total_score: number; total_label: string };

export type StageEvaluationRow = {
  user_id: string;
  chat_id: string | null;
  stage: number;
  artifact_type: string;
  artifact_id: string;
  period_key: string;
  rubric_json: Record<string, number>;
  result_json: StageEvaluationResult;
  total_score: number;
  total_label: string;
};

export function buildStageEvaluationRow(input: {
  userId: string;
  chatId: string | null;
  stage: number;
  artifactType: string;
  artifactId: string;
  periodKey: string;
  rubric: Record<string, number>;
  evaluation: StageEvaluationResult;
}): StageEvaluationRow {
  return {
    user_id: input.userId,
    chat_id: input.chatId,
    stage: input.stage,
    artifact_type: input.artifactType,
    artifact_id: input.artifactId,
    period_key: input.periodKey,
    rubric_json: input.rubric,
    result_json: input.evaluation,
    total_score: input.evaluation.total_score,
    total_label: input.evaluation.total_label,
  };
}
