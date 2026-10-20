import assert from "node:assert/strict";

import {
  asRecordOrNull,
  createAdvisorTransitions,
  readCriticalRootsFromValidation,
  readNextStageFromValidation,
  shouldPreserveAdvisorStateOnRefreshFailure,
  type AdvisorTransitionDeps,
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

// La etapa activa al cambiar de chat (refreshActiveAdvisorStage): una respuesta que llega cuando
// quien la pidió ya no está vigente no toca la etapa ni los estados locales.
async function refreshCases() {
  type Resolved = Awaited<ReturnType<AdvisorTransitionDeps["persistence"]["getActiveAdvisorStage"]>>;
  const calls: string[] = [];
  let next: Resolved;
  const record = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "activeAdvisorStage") return 0;
        if (name === "getActiveAdvisorStage") return async () => next;
        return (...args: unknown[]) => {
          calls.push(`${String(name)}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        };
      },
    }
  );
  const deps = { state: record, persistence: record, chat: record } as unknown as AdvisorTransitionDeps;
  const resolved = (stage: number, stateJson: Record<string, unknown> | null): Resolved => ({
    ok: true,
    status: 200,
    payload: { found: true, stage, stateJson },
    error: null,
  });

  // Vigente: se aplica la etapa del servidor (E0 en borrador -> 0).
  next = resolved(0, { sector: "Alimentos" });
  assert.equal(await createAdvisorTransitions(deps).refreshActiveAdvisorStage(() => true), 0);
  assert.ok(calls.includes("setActiveAdvisorStage(0)"), calls.join(" "));

  // Ya no vigente (se cambió de chat o de modo mientras se esperaba): no se aplica nada.
  calls.length = 0;
  next = resolved(4, { problem: null });
  assert.equal(await createAdvisorTransitions(deps).refreshActiveAdvisorStage(() => false), null);
  assert.equal(calls.length, 0, calls.join(" "));

  // Sin el callback (otros llamadores) se comporta como antes.
  next = resolved(1, {});
  assert.equal(await createAdvisorTransitions(deps).refreshActiveAdvisorStage(), 1);
  assert.ok(calls.includes("setActiveAdvisorStage(1)"));
}

refreshCases()
  .then(() => console.log("advisorTransitions tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
