import assert from "node:assert/strict";

import {
  MIN_BRAINSTORM_IDEAS,
  mergeBrainstormState,
  resolveBrainstormStep,
  sanitizeBrainstormState,
} from "./brainstormFlow";
import { mergeClientIshikawaState, STAGE4_RULES } from "./ishikawaStateMerge";
import {
  canDeleteStageStateGenerically,
  canWriteStageStateGenerically,
  dedicatedStateRouteFor,
  describeGenericWriteRejection,
  withStoredFinalDocAuthority,
} from "./stageAuthority";
import { mergeStageState } from "./stageState";
import type { IshikawaState } from "./ishikawaTree";

// Campos de autoridad del servidor por etapa: un valor forjado en el cuerpo de la petición
// NO se persiste. Lógica pura, sin I/O; son las mismas funciones que usan las rutas.
//
// La forja de closure, rejectedWhyAttempts y reformulateWhy (E4) ya está cubierta en
// ishikawaServerFields.test.ts; aquí se cubre el resto: el registro de raíces, las reglas
// de E4, el mínimo de E3, la evaluación de E10 y qué etapas admite el endpoint genérico.

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord {
  assert.ok(typeof value === "object" && value !== null, "se esperaba un objeto");
  return value as LooseRecord;
}

function buildIshikawaState(): IshikawaState {
  return {
    problem: { text: "Demoras en el despacho de pedidos" },
    categories: [
      {
        id: "cat_metodo",
        name: "Método",
        mainCauses: [
          {
            id: "mc_conteo",
            name: "Conteo manual de inventario",
            subCauses: [
              {
                id: "sc_procedimiento",
                name: "No hay procedimiento escrito de conteo",
                whys: ["Nadie lo redactó cuando se abrió el almacén"],
              },
            ],
          },
        ],
      },
    ],
    minCategories: STAGE4_RULES.minCategories,
    minMainCausesPerCategory: STAGE4_RULES.minMainCausesPerCategory,
    minSubCausesPerMain: STAGE4_RULES.minSubCausesPerMain,
    maxWhyDepth: STAGE4_RULES.maxWhyDepth,
    cursor: null,
  };
}

function buildIdeas(count: number) {
  return Array.from({ length: count }, (_, index) => ({ text: `Causa número ${index + 1}` }));
}

function main() {
  // --- Endpoint genérico: qué etapas admite -----------------------------------------
  // /api/plans/stage-state corre con service role, así que ninguna policy lo detiene. Solo
  // debe aceptar las etapas que el cliente guarda por ahí (6 a 10). Las etapas 0 a 5 tienen
  // ruta propia, y esa ruta es la que protege sus campos de autoridad.
  {
    for (const stage of [6, 7, 8, 9, 10]) {
      assert.equal(canWriteStageStateGenerically(stage), true, `E${stage} debería escribirse aquí`);
    }

    for (const stage of [0, 1, 2, 3, 4, 5]) {
      assert.equal(canWriteStageStateGenerically(stage), false, `E${stage} NO debería escribirse aquí`);
      assert.ok(
        dedicatedStateRouteFor(stage),
        `E${stage} debe declarar su ruta propia para poder explicar el rechazo`
      );
      assert.match(describeGenericWriteRejection(stage), /\/api\/plans\//);
    }

    // El agujero concreto que se cierra: escribir el estado de E4 sin pasar por
    // ishikawa/state, que es quien descarta closure, rootCauses y pendingRootMatch.
    assert.equal(canWriteStageStateGenerically(4), false);
    assert.equal(dedicatedStateRouteFor(4), "/api/plans/ishikawa/state");

    // Borrado: solo el estado de trabajo que el cliente limpia al avanzar (2 a 9).
    for (const stage of [2, 3, 4, 5, 6, 7, 8, 9]) {
      assert.equal(canDeleteStageStateGenerically(stage), true, `E${stage} se limpia al avanzar`);
    }

    // E10 queda fuera: guarda la evaluación escrita por el servidor y borrarla permitiría
    // volver a entregar la versión 1 hasta sacar una nota que cierre el plan.
    for (const stage of [0, 1, 10]) {
      assert.equal(canDeleteStageStateGenerically(stage), false, `E${stage} no se borra aquí`);
    }
  }

  // --- E3: minIdeas forjado no baja el mínimo ---------------------------------------
  {
    const forged = sanitizeBrainstormState({
      strategy: { type: "FO" },
      problem: { text: "Demoras en el despacho de pedidos" },
      ideas: buildIdeas(3),
      minIdeas: 3,
    });

    assert.equal(forged.minIdeas, MIN_BRAINSTORM_IDEAS);
    assert.notEqual(forged.step, "review", "con 3 causas no se puede cerrar E3");

    // Tampoco por la fusión del guardado.
    const merged = mergeBrainstormState(
      { strategy: { type: "FO" }, problem: { text: "Demoras" }, ideas: buildIdeas(3) },
      { minIdeas: 3 }
    );
    assert.equal(merged.minIdeas, MIN_BRAINSTORM_IDEAS);

    // Ni subiéndolo para trabar a otro estudiante.
    assert.equal(sanitizeBrainstormState({ minIdeas: 999 }).minIdeas, MIN_BRAINSTORM_IDEAS);

    // Con el mínimo real sí cierra.
    const complete = sanitizeBrainstormState({
      strategy: { type: "FO" },
      problem: { text: "Demoras en el despacho de pedidos" },
      ideas: buildIdeas(MIN_BRAINSTORM_IDEAS),
    });
    assert.equal(complete.step, "review");

    // resolveBrainstormStep ya no acepta un mínimo por parámetro.
    assert.equal(
      resolveBrainstormStep({
        strategy: { type: "FO" },
        problem: { text: "Demoras" },
        ideas: buildIdeas(MIN_BRAINSTORM_IDEAS - 1),
      }),
      "generate_causes"
    );
  }

  // --- E4: registro de raíces y reglas forjados no se persisten ---------------------
  {
    const stored = buildIshikawaState();

    const forgedIncoming = {
      ...buildIshikawaState(),
      // Registro inventado: 10 raíces sin ninguna rama cerrada detrás.
      rootCauses: Array.from({ length: 10 }, (_, index) => ({
        id: `root_${index}`,
        canonicalText: `Causa raíz inventada ${index}`,
        occurrences: [],
        distinctFrom: [],
      })),
      pendingRootMatch: null,
      // Reglas rebajadas para cerrar la etapa con una sola categoría.
      minCategories: 1,
      minMainCausesPerCategory: 1,
      minSubCausesPerMain: 0,
      maxWhyDepth: 99,
    };

    const saved = asRecord(mergeClientIshikawaState(stored, forgedIncoming, stored));

    assert.deepEqual(saved.rootCauses, [], "un registro de raíces forjado no se guarda");
    assert.equal(saved.pendingRootMatch, null);
    assert.equal(saved.minCategories, STAGE4_RULES.minCategories);
    assert.equal(saved.minMainCausesPerCategory, STAGE4_RULES.minMainCausesPerCategory);
    assert.equal(saved.minSubCausesPerMain, STAGE4_RULES.minSubCausesPerMain);
    assert.equal(saved.maxWhyDepth, STAGE4_RULES.maxWhyDepth);
  }

  // --- E10: la nota y la versión no se forjan ---------------------------------------
  {
    const storedEvaluation = {
      total_score: 41,
      total_label: "Deficiente",
      needs_resubmission: true,
      signals: { inconsistencias_detectadas: ["El objetivo no coincide con el Pareto"] },
    };

    const stored = {
      step: "review",
      versionNumber: 1,
      lastFeedback: "Falta coherencia con la Etapa 5.",
      upload: {
        fileName: "plan.docx",
        storagePath: "planes/plan.docx",
        extractedText: "x".repeat(80),
        uploadedAt: "2026-03-01T12:00:00.000Z",
      },
      extractedSections: null,
      evaluation: storedEvaluation,
    };

    // Cuerpo forjado: nota perfecta, sin observaciones y versión 2 (que cierra siempre).
    const forged = {
      step: "review",
      versionNumber: 2,
      lastFeedback: "otro texto",
      upload: { ...stored.upload, fileName: "plan-v2.docx" },
      evaluation: {
        total_score: 100,
        total_label: "Bien",
        needs_resubmission: false,
        signals: { inconsistencias_detectadas: [] },
      },
    };

    const merged = asRecord(mergeStageState(10, stored, forged));

    assert.deepEqual(merged.evaluation, storedEvaluation, "la evaluación viene de la base");
    assert.equal(merged.versionNumber, 1, "la versión viene de la base");

    // Lo que no es autoridad del servidor sí lo escribe el cliente.
    assert.equal(merged.lastFeedback, "otro texto");
    assert.equal(asRecord(merged.upload).fileName, "plan-v2.docx");

    // Primer guardado (sin nada almacenado): la evaluación forjada tampoco entra.
    const first = asRecord(mergeStageState(10, null, forged));
    assert.equal(first.evaluation, null, "sin evaluación del servidor no hay nota");
    assert.equal(first.versionNumber, 1, "la versión por defecto es 1");

    // Helper puro.
    const stripped = withStoredFinalDocAuthority(forged, stored);
    assert.deepEqual(stripped.evaluation, storedEvaluation);
    assert.equal(stripped.versionNumber, 1);
    assert.equal(withStoredFinalDocAuthority(forged, {}).evaluation, undefined);
    assert.equal(withStoredFinalDocAuthority(forged, {}).versionNumber, undefined);
  }
}

try {
  main();
  console.log("stageAuthority tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
