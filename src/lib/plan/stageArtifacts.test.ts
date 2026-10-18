import assert from "node:assert/strict";

import {
  FINAL_ARTIFACT_BY_STAGE,
  FINAL_DOC_FINAL_ARTIFACT_TYPE,
  FINAL_DOC_VERSION_ARTIFACT_TYPES,
  RESUME_GATE_BY_STAGE,
} from "./stageArtifacts";

// RESUME_GATE_BY_STAGE se movió tal cual desde activeStage.ts: mismo contenido que tenía.
assert.deepEqual(RESUME_GATE_BY_STAGE, {
  2: { requiredStage: 1, artifactType: "productivity_report" },
  3: { requiredStage: 2, artifactType: "foda_analysis" },
  4: { requiredStage: 3, artifactType: "brainstorm_ideas" },
  5: { requiredStage: 4, artifactType: "ishikawa_final" },
  6: { requiredStage: 5, artifactType: "pareto_final" },
  7: { requiredStage: 6, artifactType: "objectives_final" },
  8: { requiredStage: 7, artifactType: "improvement_final" },
  9: { requiredStage: 8, artifactType: "planning_final" },
  10: { requiredStage: 9, artifactType: "progress_final" },
});

// Artefacto final de E1-E10: E1-E9 derivados de RESUME_GATE_BY_STAGE, E10 = final_doc_final.
assert.deepEqual(
  [...FINAL_ARTIFACT_BY_STAGE],
  [
    [1, "productivity_report"],
    [2, "foda_analysis"],
    [3, "brainstorm_ideas"],
    [4, "ishikawa_final"],
    [5, "pareto_final"],
    [6, "objectives_final"],
    [7, "improvement_final"],
    [8, "planning_final"],
    [9, "progress_final"],
    [10, "final_doc_final"],
  ]
);
assert.equal(FINAL_DOC_FINAL_ARTIFACT_TYPE, "final_doc_final");
assert.deepEqual(FINAL_DOC_VERSION_ARTIFACT_TYPES, { 1: "final_doc_v1", 2: "final_doc_v2" });
// E0 no tiene artefacto final: se cierra con el contexto del caso confirmado.
assert.equal(FINAL_ARTIFACT_BY_STAGE.has(0), false);

console.log("stageArtifacts tests passed");
