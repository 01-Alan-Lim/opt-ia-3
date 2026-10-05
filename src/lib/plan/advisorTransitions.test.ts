import assert from "node:assert/strict";

import {
  asRecordOrNull,
  readCriticalRootsFromValidation,
  readNextStageFromValidation,
  shouldPreserveAdvisorStateOnRefreshFailure,
} from "../../app/chat/_lib/advisorTransitions";

// Caracterización de las piezas puras de las transiciones del asesor
// (src/app/chat/_lib/advisorTransitions.ts). Vive aquí porque el runner solo recorre src/lib/plan.

{
  // La etapa siguiente la autoriza el servidor en next.toStage; el cliente solo acepta 3-10.
  assert.equal(readNextStageFromValidation(null), null);
  assert.equal(readNextStageFromValidation(undefined), null);
  assert.equal(readNextStageFromValidation({}), null);
  assert.equal(readNextStageFromValidation({ next: null }), null);
  assert.equal(readNextStageFromValidation({ next: { toStage: 3 } }), 3);
  assert.equal(readNextStageFromValidation({ next: { toStage: 10 } }), 10);
  // E1->E2 no pasa por aquí, y fuera de rango o con otro tipo no hay transición.
  assert.equal(readNextStageFromValidation({ next: { toStage: 2 } }), null);
  assert.equal(readNextStageFromValidation({ next: { toStage: 11 } }), null);
  assert.equal(readNextStageFromValidation({ next: { toStage: "4" as unknown as number } }), null);
}

{
  // Causas críticas de Pareto: recortadas, sin vacías y sin repetir (sin distinguir mayúsculas).
  assert.deepEqual(readCriticalRootsFromValidation(null), []);
  assert.deepEqual(readCriticalRootsFromValidation({ final: { criticalRoots: null } }), []);
  assert.deepEqual(
    readCriticalRootsFromValidation({
      final: { criticalRoots: [" A ", "a", "", null as unknown as string, "B"], selectedRoots: ["Z"] },
    }),
    ["A", "B"]
  );
}

{
  // Si /active-stage falla, solo se conserva el estado local con una etapa > 0 y un fallo temporal.
  assert.equal(shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: null, status: 500 }), false);
  assert.equal(shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 0, status: 500 }), false);
  assert.equal(shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 4, status: 500 }), true);
  assert.equal(shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 4, status: 503 }), true);
  assert.equal(
    shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 4, status: 401, errorCode: "AUTH_UPSTREAM_TIMEOUT" }),
    true
  );
  assert.equal(shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 4, status: 404 }), false);
  assert.equal(
    shouldPreserveAdvisorStateOnRefreshFailure({ currentStage: 4, status: 401, errorCode: "UNAUTHORIZED" }),
    false
  );
}

{
  const record = { stage: 4 };
  assert.equal(asRecordOrNull(record), record);
  assert.equal(asRecordOrNull([]), null);
  assert.equal(asRecordOrNull(null), null);
  assert.equal(asRecordOrNull("x"), null);
  assert.equal(asRecordOrNull(0), null);
}

console.log("advisorTransitions tests passed");
