import assert from "node:assert/strict";

import {
  evaluateParetoCut,
  mergeCriticalSelection,
  normalizeEffectPercent,
  type ParetoCutResult,
} from "./paretoCut";

function reasonOf(result: ParetoCutResult) {
  return result.ok ? "ok" : result.reason;
}

function cut(criticalCount: number, selectedCount: number, effectPercent: unknown) {
  return evaluateParetoCut({ criticalCount, selectedCount, effectPercent });
}

{
  // 10/90, 25/75 y 30/70 pasan; 44/55 se rechaza por desbalance débil.
  assert.equal(reasonOf(cut(1, 10, 90)), "ok");
  assert.equal(reasonOf(cut(3, 12, 75)), "ok");
  assert.equal(reasonOf(cut(3, 10, 70)), "ok");
  assert.equal(reasonOf(cut(4, 9, 55)), "weak_imbalance");
}

{
  // 35/55: justo 20 puntos de diferencia.
  assert.equal(reasonOf(cut(7, 20, 55)), "ok");
  assert.equal(reasonOf(cut(5, 10, 80)), "not_minority");
  assert.equal(reasonOf(cut(2, 10, 45)), "not_majority");
  assert.equal(reasonOf(cut(0, 10, 80)), "no_critical");
  assert.equal(reasonOf(cut(2, 10, null)), "no_effect");
  assert.equal(reasonOf(cut(2, 10, 150)), "no_effect");
}

{
  const base = {
    criticalRoots: ["A", "B", "C"],
    criticalEffectPercent: 80,
    criticalJustification: "son las más frecuentes",
  };

  // Una entrega nueva y más corta reemplaza a la anterior y descarta su porcentaje.
  assert.deepEqual(
    mergeCriticalSelection(base, {
      criticalRoots: ["A"],
      criticalEffectPercent: null,
      criticalJustification: null,
    }),
    { criticalRoots: ["A"], criticalEffectPercent: null, criticalJustification: null }
  );

  // La misma lista conserva el porcentaje ya declarado.
  assert.deepEqual(
    mergeCriticalSelection(base, {
      criticalRoots: ["c", "b", "a"],
      criticalEffectPercent: null,
      criticalJustification: null,
    }),
    {
      criticalRoots: ["c", "b", "a"],
      criticalEffectPercent: 80,
      criticalJustification: "son las más frecuentes",
    }
  );

  // Una lista vacía no borra lo guardado.
  assert.deepEqual(
    mergeCriticalSelection(base, {
      criticalRoots: [],
      criticalEffectPercent: null,
      criticalJustification: null,
    }),
    base
  );
}

{
  assert.equal(normalizeEffectPercent("72,5"), 72.5);
  assert.equal(normalizeEffectPercent(0), null);
  assert.equal(normalizeEffectPercent(null), null);
}

console.log("paretoCut tests passed");
