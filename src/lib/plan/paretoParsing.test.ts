import assert from "node:assert/strict";

import {
  applyCriterionEntriesToCriteria,
  applyWeightsToCriteria,
  isLikelyParetoCauseOrProblemList,
  mergeParetoCriteriaMonotonic,
  mergeParetoStringListMonotonic,
  parseCriticalRootsFromParetoMessage,
  parseParetoCriterionEntries,
  type ParetoCriterionLike,
} from "./paretoParsing";

let idCounter = 0;
const createId = () => `criterion-${++idCounter}`;

function criteria(names: string[]): ParetoCriterionLike[] {
  return names.map((name, index) => ({ id: `existing-${index + 1}`, name }));
}

{
  const entries = parseParetoCriterionEntries(
    "1 criterio: Método de trabajo. (6)\n2 criterio: Tiempo perdido. (10)\n3 criterio: Impacto operativo. (8)"
  );

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Método de trabajo", "Tiempo perdido", "Impacto operativo"]
  );
  assert.deepEqual(
    entries.map((entry) => entry.weight),
    [6, 10, 8]
  );
}

{
  const message =
    "Generación de productos defectuosos, Variabilidad de tiempos de producción, Bajo nivel de producción";

  assert.deepEqual(parseParetoCriterionEntries(message), []);
  assert.equal(isLikelyParetoCauseOrProblemList(message), true);
}

{
  const entries = parseParetoCriterionEntries(
    "Mis criterios son impacto operativo, facilidad de implementación y costo"
  );

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["impacto operativo", "facilidad de implementación", "costo"]
  );
}

{
  const entries = parseParetoCriterionEntries(
    "los criterios Método de trabajo (peso 7), Impacto en información (peso 9) y Trazabilidad de datos (peso 10)"
  );

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Método de trabajo", "Impacto en información", "Trazabilidad de datos"]
  );
  assert.deepEqual(
    entries.map((entry) => entry.weight),
    [7, 9, 10]
  );
}

{
  const current = criteria([
    "Método de trabajo",
    "Impacto en información",
    "Trazabilidad de datos",
  ]);
  const weighted = applyWeightsToCriteria(current, "los pesos son 7, 9 y 10");

  assert.deepEqual(
    weighted.map((criterion) => criterion.weight),
    [7, 9, 10]
  );
}

{
  const entries = parseParetoCriterionEntries(
    "1 criterio: Método de trabajo. (6)\n2 criterio: Tiempo perdido. (10)\n3 criterio: Impacto operativo. (8)"
  );
  const parsed = applyCriterionEntriesToCriteria([], entries, { createId });

  assert.deepEqual(
    parsed.map((criterion) => criterion.weight),
    [6, 10, 8]
  );
}

{
  assert.deepEqual(
    parseParetoCriterionEntries(
      "Las causas críticas son: falta de capacitación, ausencia de mantenimiento, falta de estandarización"
    ),
    []
  );
}

{
  const parsed = parseCriticalRootsFromParetoMessage(
    "Las causas críticas son: falta de capacitación, ausencia de mantenimiento, falta de estandarización"
  );

  assert.equal(parsed.isDelivery, true);
  assert.deepEqual(parsed.roots, [
    "falta de capacitación",
    "ausencia de mantenimiento",
    "falta de estandarización",
  ]);
}

{
  const persisted = criteria(["Método de trabajo", "Tiempo perdido"]);
  const incoming = criteria([
    "Método de trabajo",
    "Tiempo perdido",
    "Impacto operativo",
  ]);

  const merged = mergeParetoCriteriaMonotonic(persisted, incoming, { createId });

  assert.deepEqual(
    merged.map((criterion) => criterion.name),
    ["Método de trabajo", "Tiempo perdido", "Impacto operativo"]
  );
}

{
  assert.deepEqual(mergeParetoStringListMonotonic(["A", "B"], []), ["A", "B"]);
}

{
  const weighted = applyWeightsToCriteria(
    [
      { id: "1", name: "Método de trabajo", weight: 6 },
      { id: "2", name: "Tiempo perdido", weight: 10 },
      { id: "3", name: "Impacto operativo", weight: 8 },
    ],
    "Cambia el peso de Tiempo perdido a 7"
  );

  assert.deepEqual(
    weighted.map((criterion) => criterion.weight),
    [6, 7, 8]
  );
}

console.log("paretoParsing tests passed");
