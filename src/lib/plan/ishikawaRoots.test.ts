import assert from "node:assert/strict";

import { deriveRootCauses, describeRootBranch } from "./ishikawaRoots";

// Conteo de causas raíz a partir del registro (Paso C, Fase C). Datos ficticios.

const closureFor = (rootId: string | null, reviewed = true) => ({
  reviewed,
  at: "2026-01-01T00:00:00.000Z",
  verdict: "actionable",
  origin: "system",
  rootId,
});

const path = (subCauseId: string, text: string) => ({
  categoryId: "cat_metodo",
  mainCauseId: "mc1",
  subCauseId,
  text,
});

const state = {
  categories: [
    {
      id: "cat_metodo",
      name: "Método",
      mainCauses: [
        {
          id: "mc1",
          name: "Demoras en caja",
          subCauses: [
            { id: "sc1", name: "Cobro lento", whys: ["A", "B", "Raíz revisada"], closure: closureFor("r1") },
            { id: "sc2", name: "Filas largas", whys: ["C", "Raíz abandonada"] },
            { id: "sc3", text: "Subcausa sin porqués" },
            { id: "sc4", name: "Causa", whys: [] }, // marcador vacío: no es raíz
            // Misma raíz que sc1 en otra rama: cuenta una vez, con dos ramas.
            { id: "sc5", name: "Duplicada", whys: [{ text: "raíz  revisada" }], closure: closureFor("r1") },
            { id: "sc6", name: "Reabierta", whys: ["Raíz reabierta"], closure: closureFor(null, false) },
            // Revisada pero sin entrada válida en el registro: no cuenta y queda pendiente.
            { id: "sc7", name: "Sin registro", whys: ["Raíz huérfana"], closure: closureFor("r_falta") },
          ],
        },
      ],
    },
  ],
  rootCauses: [
    {
      id: "r1",
      canonicalText: "Raíz revisada",
      normalizedText: "raíz revisada",
      occurrences: [path("sc1", "Raíz revisada"), path("sc5", "raíz  revisada")],
      distinctFrom: [],
    },
    // Entrada vieja que apunta a una rama que ya no existe: sale al conciliar.
    {
      id: "r_vieja",
      canonicalText: "Raíz vieja",
      normalizedText: "raíz vieja",
      occurrences: [path("sc_borrada", "Raíz vieja")],
      distinctFrom: ["r1"],
    },
  ],
};

{
  // Con cierre revisado obligatorio: cuenta el registro, cada raíz una vez.
  const summary = deriveRootCauses(state, { requireReviewedClosure: true });
  assert.deepEqual(summary.roots, ["Raíz revisada"]);
  assert.equal(summary.entries.length, 1);
  assert.equal(summary.entries[0].occurrences, 2);
  assert.deepEqual(summary.entries[0].branches, [
    "Método → Demoras en caja → Cobro lento",
    "Método → Demoras en caja → Duplicada",
  ]);
  assert.deepEqual(
    summary.pendingBranches.map((branch) => branch.root),
    ["Raíz abandonada", "Subcausa sin porqués", "Raíz reabierta", "Raíz huérfana"]
  );
  assert.equal(describeRootBranch(summary.pendingBranches[0]), "Método → Demoras en caja → Filas largas");
}

{
  // Sin la exigencia (modo anterior): cada texto distinto cuenta, con el criterio del registro.
  const summary = deriveRootCauses(state, { requireReviewedClosure: false });
  assert.deepEqual(summary.roots, [
    "Raíz revisada",
    "Raíz abandonada",
    "Subcausa sin porqués",
    "Raíz reabierta",
    "Raíz huérfana",
  ]);
  assert.equal(summary.entries[0].occurrences, 2);
  assert.deepEqual(summary.pendingBranches, []);
}

{
  // Por defecto rige REQUIRE_REVIEWED_CLOSURE (true).
  assert.deepEqual(deriveRootCauses(state).roots, ["Raíz revisada"]);
}

{
  // Estados de antes del registro (sin rootCauses): nada cuenta aunque tengan porqués.
  const legacy = { ...state, rootCauses: undefined };
  assert.deepEqual(deriveRootCauses(legacy).roots, []);
  assert.equal(deriveRootCauses(legacy).pendingBranches.length, 6);
}

{
  // Estados sin tipar o incompletos no rompen.
  const malformed: unknown[] = [
    null,
    undefined,
    "x",
    42,
    {},
    { categories: "x" },
    { categories: [null, { mainCauses: [{ subCauses: [7] }] }] },
    { categories: [], rootCauses: "x" },
  ];

  for (const value of malformed) {
    assert.deepEqual(deriveRootCauses(value).roots, []);
  }
}

console.log("ishikawaRoots tests passed");
