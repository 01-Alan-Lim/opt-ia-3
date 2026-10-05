import assert from "node:assert/strict";

import {
  ADVANCE_INDEXES,
  ADVANCE_REFERENCE_STAGES,
  advanceLabel,
  isAdvanceIndex,
} from "./advanceStages";

// Referencia que el flujo comunica al estudiante: Avance 1 = E1-E5, Avance 2 = E6-E8,
// Avance 3 = E9. E0 (la habilita) y E10 quedan fuera.
assert.deepEqual([...ADVANCE_INDEXES], [1, 2, 3]);
assert.deepEqual(ADVANCE_REFERENCE_STAGES, {
  1: { from: 1, to: 5 },
  2: { from: 6, to: 8 },
  3: { from: 9, to: 9 },
});

// Rangos contiguos y sin solaparse.
for (const index of ADVANCE_INDEXES) {
  const range = ADVANCE_REFERENCE_STAGES[index];
  assert.ok(range.from <= range.to);
  if (index > 1) {
    const previous = ADVANCE_REFERENCE_STAGES[(index - 1) as 1 | 2];
    assert.equal(range.from, previous.to + 1);
  }
}
const covered = ADVANCE_INDEXES.flatMap((index) => {
  const { from, to } = ADVANCE_REFERENCE_STAGES[index];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
});
assert.deepEqual(covered, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(covered.includes(0), false);
assert.equal(covered.includes(10), false);

assert.equal(isAdvanceIndex(1), true);
assert.equal(isAdvanceIndex(3), true);
assert.equal(isAdvanceIndex(0), false);
assert.equal(isAdvanceIndex(4), false);
assert.equal(isAdvanceIndex(null), false);

assert.equal(advanceLabel(2), "Avance 2");

console.log("advanceStages tests passed");
