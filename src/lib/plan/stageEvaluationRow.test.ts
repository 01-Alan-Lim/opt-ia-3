import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PLAN_STAGE_EVALUATION_COLUMNS, buildStageEvaluationRow } from "./stageEvaluationRow";

// Columnas reales de public.plan_stage_evaluations (information_schema). status y payload_json
// no existen: eran las que hacían fallar el insert de E4-E8.
assert.deepEqual(
  [...PLAN_STAGE_EVALUATION_COLUMNS],
  [
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
  ]
);
const VALID_COLUMNS: ReadonlySet<string> = new Set(PLAN_STAGE_EVALUATION_COLUMNS);
assert.equal(VALID_COLUMNS.has("status"), false);
assert.equal(VALID_COLUMNS.has("payload_json"), false);

// Etapa, artefacto final y rúbrica de cada ruta de validación de E4-E8.
const CASES = [
  {
    route: "ishikawa",
    stage: 4,
    artifactType: "ishikawa_final",
    rubric: { estructura: 30, trazabilidad_5pq: 40, calidad_claridad: 30 },
  },
  {
    route: "pareto",
    stage: 5,
    artifactType: "pareto_final",
    rubric: { criterios_ponderaciones: 40, priorizacion_final: 60 },
  },
  {
    route: "objectives",
    stage: 6,
    artifactType: "objectives_final",
    rubric: { coherencia_trazabilidad: 40, claridad_redaccion: 30, especificidad_medibilidad: 30 },
  },
  {
    route: "improvement",
    stage: 7,
    artifactType: "improvement_final",
    rubric: { coherencia_trazabilidad: 40, impacto_factibilidad: 30, medicion_control: 30 },
  },
  {
    route: "planning",
    stage: 8,
    artifactType: "planning_final",
    rubric: { factibilidad_tiempo: 40, secuencia_dependencias: 30, seguimiento_evidencia: 30 },
  },
] as const;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";

for (const testCase of CASES) {
  // Evaluación con la forma que devuelve Gemini: campos extra incluidos.
  const evaluation = {
    total_score: 82.5,
    total_label: "Adecuado",
    detail: { a: 80, b: 85 },
    feedback: "Retroalimentación de prueba.",
    mejoras: ["Mejora 1", "Mejora 2"],
  };
  const before = structuredClone(evaluation);

  const row = buildStageEvaluationRow({
    userId: USER_ID,
    chatId: CHAT_ID,
    stage: testCase.stage,
    artifactType: testCase.artifactType,
    artifactId: ARTIFACT_ID,
    periodKey: "2026-10",
    rubric: testCase.rubric,
    evaluation,
  });

  for (const key of Object.keys(row)) {
    assert.ok(VALID_COLUMNS.has(key), `${testCase.route}: ${key} no es columna de la tabla`);
  }
  assert.equal("status" in row, false, `${testCase.route}: no debe mandar status`);
  assert.equal("payload_json" in row, false, `${testCase.route}: no debe mandar payload_json`);

  // version, created_at e id quedan con el default de la tabla (1, now(), gen_random_uuid()).
  assert.equal("version" in row, false);
  assert.equal("created_at" in row, false);
  assert.equal("id" in row, false);

  assert.deepEqual(row, {
    user_id: USER_ID,
    chat_id: CHAT_ID,
    stage: testCase.stage,
    artifact_type: testCase.artifactType,
    artifact_id: ARTIFACT_ID,
    period_key: "2026-10",
    rubric_json: testCase.rubric,
    result_json: evaluation,
    total_score: 82.5,
    total_label: "Adecuado",
  });

  // La evaluación de Gemini va entera y sin tocar a result_json.
  assert.equal(row.result_json, evaluation);
  assert.deepEqual(evaluation, before);
}

// ishikawa y pareto pueden no tener chat (chatId ?? stateChatId ?? null): chat_id admite null.
{
  const row = buildStageEvaluationRow({
    userId: USER_ID,
    chatId: null,
    stage: 5,
    artifactType: "pareto_final",
    artifactId: ARTIFACT_ID,
    periodKey: "2026-10",
    rubric: { criterios_ponderaciones: 40, priorizacion_final: 60 },
    evaluation: { total_score: 0, total_label: "Deficiente" },
  });
  assert.equal(row.chat_id, null);
  assert.equal(row.total_score, 0);
  assert.equal(row.total_label, "Deficiente");
}

// Cada ruta de E4-E8 inserta su evaluación con buildStageEvaluationRow y ya no menciona
// payload_json. Lectura del código fuente: las rutas importan Supabase y no se pueden cargar aquí.
for (const testCase of CASES) {
  const file = path.join(process.cwd(), "src", "app", "api", "plans", testCase.route, "validate", "route.ts");
  const source = readFileSync(file, "utf8");

  const inserts = source.match(/\.from\("plan_stage_evaluations"\)\s*\.insert\(/g) ?? [];
  assert.equal(inserts.length, 1, `${testCase.route}: se esperaba un solo insert de evaluación`);
  assert.match(
    source,
    /\.from\("plan_stage_evaluations"\)\s*\.insert\(\s*buildStageEvaluationRow\(\{/,
    `${testCase.route}: el insert debe usar buildStageEvaluationRow`
  );
  assert.equal(source.includes("payload_json"), false, `${testCase.route}: menciona payload_json`);
  assert.match(source, new RegExp(`const STAGE = ${testCase.stage};`));
  assert.match(source, new RegExp(`const FinalType = "${testCase.artifactType}";`));
}

console.log("stageEvaluationRow tests passed");
