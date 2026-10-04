import assert from "node:assert/strict";

import {
  applyAssistantPatchToDraft,
  canShowFinalDocUploadButton,
  getObjectivesMissingItems,
  isAdvisorRuntimeStageValue,
  isFinalDocReadyForUpload,
  isFodaComplete,
  isObjectivesReadyForValidation,
  isObjectivesStateLike,
  isProgressReadyForValidation,
  mergeCosts,
  normalizeParetoStateClient,
  sanitizeFodaState,
  type FinalDocState,
  type FodaState,
  type ProgressState,
} from "./advisorStates";

// Caracterización de los modelos de estado E1-E10 tal como quedaron al moverlos desde page.tsx:
// fija lo que hacen HOY, incluida la compatibilidad con estados antiguos y las rarezas ("Hoy:").

function finalDoc(step: FinalDocState["step"]): FinalDocState {
  return {
    step,
    versionNumber: 1,
    lastFeedback: null,
    upload: { fileName: null, storagePath: null, extractedText: null, uploadedAt: null },
  };
}

function progress(reportText: string | null): ProgressState {
  return { step: "report", reportText, progressPercent: null, measurementNote: null, summary: null, updatedAtLocal: null };
}

{
  // sanitizeFodaState: entradas inválidas y estado vacío.
  assert.equal(sanitizeFodaState(null), null);
  assert.equal(sanitizeFodaState("x"), null);
  assert.deepEqual(sanitizeFodaState({}), {
    currentQuadrant: "F",
    pendingEvidence: null,
    items: { F: [], D: [], O: [], A: [] },
  });
}

{
  // sanitizeFodaState: formatos antiguos (string suelto, label/title, support/justification).
  const st = sanitizeFodaState({
    currentQuadrant: "Z",
    pendingEvidence: { quadrant: "D", index: 1 },
    items: {
      F: [
        "  Buena ubicación ",
        { label: "Personal capacitado", support: "encuesta" },
        { title: "Marca", justification: "  " },
        { text: "A", evidence: "  e  ", label: "ignorado" },
        { text: "" },
        5,
        null,
      ],
      D: { text: "no es lista" },
    },
  });
  assert.deepEqual(st, {
    currentQuadrant: "F",
    pendingEvidence: { quadrant: "D", index: 1 },
    items: {
      F: [
        { text: "Buena ubicación" },
        { text: "Personal capacitado", evidence: "encuesta" },
        { text: "Marca" },
        { text: "A", evidence: "e" },
      ],
      D: [],
      O: [],
      A: [],
    },
  });

  // pendingEvidence inválido se descarta.
  assert.equal(sanitizeFodaState({ pendingEvidence: { quadrant: "X", index: 0 } })?.pendingEvidence, null);
  assert.equal(sanitizeFodaState({ pendingEvidence: { quadrant: "O", index: -1 } })?.pendingEvidence, null);
  assert.equal(sanitizeFodaState({ pendingEvidence: { quadrant: "O", index: 1.5 } })?.pendingEvidence, null);
}

{
  // isFodaComplete: 3 por cuadrante y sin evidencia pendiente.
  const three = [{ text: "a" }, { text: "b" }, { text: "c" }];
  const full: FodaState = { currentQuadrant: "A", pendingEvidence: null, items: { F: three, D: three, O: three, A: three } };
  assert.equal(isFodaComplete(full), true);
  assert.equal(isFodaComplete({ ...full, pendingEvidence: { quadrant: "O", index: 0 } }), false);
  assert.equal(isFodaComplete({ ...full, items: { ...full.items, D: three.slice(0, 2) } }), false);
}

{
  // normalizeParetoStateClient: entradas inválidas y estado vacío.
  assert.equal(normalizeParetoStateClient(null), null);
  assert.equal(normalizeParetoStateClient("x"), null);
  assert.deepEqual(normalizeParetoStateClient({}), {
    roots: [],
    selectedRoots: [],
    criteria: [],
    criticalRoots: [],
    criticalEffectPercent: null,
    criticalJustification: null,
    step: "select_roots",
  });
}

{
  // normalizeParetoStateClient: estado antiguo. Raíces deduplicadas sin distinguir mayúsculas,
  // selectedRoots vacío toma todas las raíces, minSelected/maxSelected se ignoran, los 3
  // criterios automáticos sin pesos se descartan y un paso desconocido vuelve a select_roots.
  const st = normalizeParetoStateClient({
    roots: ["A", "a", " B ", "", null],
    selectedRoots: [],
    criticalRoots: ["b", "Z"],
    criteria: [{ name: "Impacto" }, { name: "Frecuencia" }, { name: "Controlabilidad" }],
    step: "weird",
    minSelected: 3,
    maxSelected: 5,
    criticalEffectPercent: "72,5",
    criticalJustification: "  porque   sí ",
  });
  assert.deepEqual(st, {
    roots: ["A", "B"],
    selectedRoots: ["A", "B"],
    criteria: [],
    criticalRoots: ["b"],
    criticalEffectPercent: 72.5,
    criticalJustification: "porque sí",
    step: "select_roots",
  });
}

{
  // normalizeParetoStateClient: criterios con pesos se conservan (máximo 3), pesos fuera de 1-10
  // se quitan, se respeta el id existente y se genera uno si falta.
  const st = normalizeParetoStateClient({
    roots: ["A"],
    criteria: [
      { id: "c1", name: "Impacto", weight: 8 },
      { name: "Frecuencia", weight: "11" },
      { name: "Controlabilidad" },
      { name: "Cuarto" },
      { name: "  " },
    ],
    step: "excel_work",
  });
  assert.ok(st);
  assert.deepEqual(st.criteria.map((c) => c.name), ["Impacto", "Frecuencia", "Controlabilidad"]);
  assert.deepEqual(st.criteria[0], { id: "c1", name: "Impacto", weight: 8 });
  assert.equal("weight" in st.criteria[1], false);
  assert.equal(typeof st.criteria[1].id === "string" && st.criteria[1].id.length > 0, true);
  assert.equal(st.step, "excel_work");
  // Los críticos se filtran contra las seleccionadas solo si hay alguna.
  assert.deepEqual(normalizeParetoStateClient({ criticalRoots: ["X"] })?.criticalRoots, ["X"]);
}

{
  // Reglas de listo.
  assert.equal(
    isObjectivesReadyForValidation({
      generalObjective: "Reducir mermas del 8% al 4%",
      specificObjectives: ["a", "b", "c"],
      linkedCriticalRoots: ["r1"],
    }),
    true
  );
  assert.equal(
    isObjectivesReadyForValidation({
      generalObjective: "Muy corto aquí",
      specificObjectives: ["a", "b", "c"],
      linkedCriticalRoots: ["r1"],
    }),
    false
  );
  assert.equal(
    isObjectivesReadyForValidation({
      generalObjective: "Reducir mermas del 8% al 4%",
      specificObjectives: ["a", "b", " "],
      linkedCriticalRoots: ["r1"],
    }),
    false
  );

  assert.equal(isProgressReadyForValidation(progress("123456789012")), true);
  assert.equal(isProgressReadyForValidation(progress("12345678901")), false);
  assert.equal(isProgressReadyForValidation(progress(null)), false);

  assert.equal(isFinalDocReadyForUpload(null), false);
  assert.equal(isFinalDocReadyForUpload(finalDoc("await_upload")), true);
  assert.equal(isFinalDocReadyForUpload(finalDoc("needs_v2")), true);
  assert.equal(isFinalDocReadyForUpload(finalDoc("finalized")), false);

  assert.equal(canShowFinalDocUploadButton("general", true, 10, null), false);
  assert.equal(canShowFinalDocUploadButton("plan_mejora", false, 10, null), false);
  assert.equal(canShowFinalDocUploadButton("plan_mejora", true, 9, null), false);
  assert.equal(canShowFinalDocUploadButton("plan_mejora", true, 10, null), true);
  assert.equal(canShowFinalDocUploadButton("plan_mejora", true, 10, finalDoc("finalized")), false);
}

{
  // Etapa activa y objetivos.
  assert.equal(isAdvisorRuntimeStageValue(0), true);
  assert.equal(isAdvisorRuntimeStageValue(10), true);
  assert.equal(isAdvisorRuntimeStageValue(11), false);
  assert.equal(isAdvisorRuntimeStageValue(-1), false);
  assert.equal(isAdvisorRuntimeStageValue(2.5), false);
  assert.equal(isAdvisorRuntimeStageValue("3"), false);
  assert.equal(isAdvisorRuntimeStageValue(null), false);

  const objectives = { generalObjective: "g", specificObjectives: [], linkedCriticalRoots: [], step: "general" };
  assert.equal(isObjectivesStateLike(objectives), true);
  assert.equal(isObjectivesStateLike({ ...objectives, step: "otro" }), false);
  assert.equal(isObjectivesStateLike([]), false);

  assert.deepEqual(getObjectivesMissingItems(null), ["estado guardado de Objetivos"]);
  assert.deepEqual(
    getObjectivesMissingItems({ generalObjective: "corto", specificObjectives: ["a", ""], linkedCriticalRoots: [], step: "general" }),
    ["objetivo general claro", "3 objetivos especificos (1/3)", "vinculo con al menos una causa critica priorizada"]
  );
  assert.deepEqual(
    getObjectivesMissingItems({
      generalObjective: "Reducir mermas del 8% al 4%",
      specificObjectives: ["a", "b", "c"],
      linkedCriticalRoots: ["r1"],
      step: "review",
    }),
    []
  );
}

{
  // Borrador de E1: costos y parche del asistente.
  assert.deepEqual(
    mergeCosts(
      [{ name: "Mano de obra", amount_bs: 100 }],
      [
        { name: "mano de obra", amount_bs: 5 },
        { name: "Energía", amount_bs: 40, note: "aprox" },
        { name: "Agua", amount_bs: 10 },
      ],
      2
    ),
    [
      { name: "Mano de obra", amount_bs: 100 },
      { name: "Energía", amount_bs: 40, note: "aprox" },
    ]
  );
  assert.deepEqual(mergeCosts(null, [{ name: "Agua", amount_bs: 10 }], 4), [{ name: "Agua", amount_bs: 10, note: undefined }]);
  // Hoy: el tope se revisa después de agregar, así que puede pasarse en uno.
  assert.equal(
    mergeCosts([{ name: "A", amount_bs: 1 }, { name: "B", amount_bs: 2 }], [{ name: "C", amount_bs: 3 }], 2).length,
    3
  );

  assert.deepEqual(
    applyAssistantPatchToDraft(
      { line: "Yogurt" },
      { unit_type: "fisica", unit_reason: "  porque  ", period: "2026-02", income_bs: 0, income_line: null }
    ),
    { line: "Yogurt", type: "fisica", unit_reason: "porque", period_key: "2026-02", income_bs: 0 }
  );
  assert.deepEqual(applyAssistantPatchToDraft({ type: "monetaria" }, { unit_type: null, unit_reason: "   " }), {
    type: "monetaria",
  });
}

console.log("advisorStates tests passed");
