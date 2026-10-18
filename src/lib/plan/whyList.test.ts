import assert from "node:assert/strict";

import { MAX_WHY_DEPTH } from "./rootCauseLimits";
import { dedupeWhys, mergeSubCause, whyToKey } from "./whyList";

{
  // Unión normal: primero lo guardado, luego lo nuevo, sin duplicados (en minúsculas).
  assert.deepEqual(dedupeWhys(["A", "B"], ["b", "C"], MAX_WHY_DEPTH), ["A", "B", "C"]);

  // Estados antiguos con objetos { text } / { id }.
  assert.deepEqual(dedupeWhys([{ text: "Uno" }, { id: "dos" }], ["  Tres "], MAX_WHY_DEPTH), [
    "Uno",
    "dos",
    "Tres",
  ]);
  assert.equal(whyToKey(42), "");

  // Una entrada que no es lista cuenta como vacía.
  assert.deepEqual(dedupeWhys(undefined, "texto", MAX_WHY_DEPTH), []);
}

{
  // Recorte a MAX_WHY_DEPTH (5): se conservan los primeros.
  assert.deepEqual(dedupeWhys(["1", "2", "3", "4"], ["5", "6"], MAX_WHY_DEPTH), [
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
}

{
  const base = {
    id: "sc1",
    text: "Demoras en el despacho",
    whys: ["A", "B", "C"],
    rejectedWhyAttempts: 2,
  };

  // Sin flag: unión; un estado entrante incompleto no borra porqués.
  const union = mergeSubCause(base, { id: "sc1", whys: ["A", "D"] }, MAX_WHY_DEPTH);
  assert.deepEqual(union.whys, ["A", "B", "C", "D"]);
  assert.equal(union.rejectedWhyAttempts, 2);

  // Con whysReplace: la lista entrante es autoritativa y el flag no se persiste.
  const replaced = mergeSubCause(
    base,
    { id: "sc1", whys: ["A", "B", "C corregida"], whysReplace: true, rejectedWhyAttempts: 0 },
    MAX_WHY_DEPTH
  );
  assert.deepEqual(replaced.whys, ["A", "B", "C corregida"]);
  assert.equal("whysReplace" in replaced, false);
  assert.equal(replaced.rejectedWhyAttempts, 0);

  // Con whysReplace también se deduplica y se recorta a 5.
  const capped = mergeSubCause(
    base,
    { id: "sc1", whys: ["1", "2", "2", "3", "4", "5", "6"], whysReplace: true },
    MAX_WHY_DEPTH
  );
  assert.deepEqual(capped.whys, ["1", "2", "3", "4", "5"]);

  // whysReplace: false mantiene la unión y tampoco se persiste.
  const notReplaced = mergeSubCause(base, { id: "sc1", whys: ["D"], whysReplace: false }, MAX_WHY_DEPTH);
  assert.deepEqual(notReplaced.whys, ["A", "B", "C", "D"]);
  assert.equal("whysReplace" in notReplaced, false);

  // Subcausa nueva (sin base) con el flag.
  const created = mergeSubCause({}, { id: "sc2", whys: ["X"], whysReplace: true }, MAX_WHY_DEPTH);
  assert.deepEqual(created.whys, ["X"]);
  assert.equal("whysReplace" in created, false);
}

console.log("whyList tests passed");
