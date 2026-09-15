import assert from "node:assert/strict";

import {
  resolveCloseConfirmation,
  resolveFastPathWhyTurn,
  type BranchJudge,
} from "./ishikawaBranchFlow";
import { deriveRootCauses } from "./ishikawaRoots";
import { resolveBranchRoot } from "./ishikawaRootRegistry";
import {
  compactIshikawaState,
  hydrateServerFields,
  mergeAssistantIshikawaState,
  mergeClientIshikawaState,
  serverFieldsFingerprint,
} from "./ishikawaStateMerge";
import {
  cloneIshikawaState,
  IshikawaStateInputSchema,
  type BranchClosure,
  type IshikawaState,
  type IshikawaSubCause,
} from "./ishikawaTree";
import { MAX_WHY_DEPTH, REJECTED_WHY_ATTEMPTS_LIMIT } from "./rootCauseLimits";
import type { LlmActionabilityVerdict } from "./whyQuality";

// Autoridad del servidor sobre closure, rejectedWhyAttempts y reformulateWhy (Paso C, Fase A).
// Simula las escrituras de la fila de E4 con las mismas funciones puras que usan las rutas:
// ishikawa/assistant rehidrata de la base (hydrateServerFields) y escribe antes de responder
// (mergeAssistantIshikawaState); ishikawa/state guarda lo del cliente
// (mergeClientIshikawaState); el GET recarga (compactIshikawaState). Datos ficticios.

const NOW = "2026-03-01T12:00:00.000Z";
const CAT_ID = "cat_metodo";
const MC_ID = "mc_inventario";
const SC_ID = "sc_conteo";

const WHYS = [
  "Los conteos se hacen a mano",
  "El encargado no conoce el procedimiento de conteo",
  "Nadie definió quién actualiza el registro de inventario",
];

const ACTIONABLE: LlmActionabilityVerdict = {
  actionable: true,
  reason: "La empresa puede asignar ese responsable.",
};

function buildState(options: { subCauseName?: string; whys?: string[] } = {}): IshikawaState {
  return {
    problem: { text: "Diferencias entre el stock físico y el del sistema" },
    categories: [
      {
        id: CAT_ID,
        name: "Método",
        mainCauses: [
          {
            id: MC_ID,
            name: "Control de inventario deficiente",
            subCauses: [
              {
                id: SC_ID,
                name: options.subCauseName ?? "Diferencias en el conteo de stock",
                whys: options.whys ?? WHYS,
              },
            ],
          },
        ],
      },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: { categoryId: CAT_ID, mainCauseId: MC_ID, subCauseId: SC_ID },
  };
}

function subCause(state: unknown): IshikawaSubCause {
  const typed = state as IshikawaState;
  const found = typed.categories
    .flatMap((cat) => cat.mainCauses)
    .flatMap((mc) => mc.subCauses)
    .find((sc) => sc.id === SC_ID);

  if (!found) throw new Error("falta la subcausa");
  return found;
}

function fixedJudge(verdict: LlmActionabilityVerdict | null): BranchJudge {
  return async () => verdict;
}

const FORGED: BranchClosure = {
  reviewed: true,
  at: NOW,
  verdict: "actionable",
  origin: "student_confirm",
  rootId: null,
};

async function main() {
  // --- (a) Un closure forjado en el cuerpo no persiste ----------------------------
  {
    const stored = buildState(); // lo que hay en la base: rama sin cerrar
    const forged = cloneIshikawaState(stored);
    subCause(forged).closure = FORGED;

    // ishikawa/state: el guardado del cliente descarta el closure y conserva lo almacenado.
    const saved = compactIshikawaState(mergeClientIshikawaState(stored, forged, stored));
    assert.equal(subCause(saved).closure, undefined);
    assert.deepEqual(deriveRootCauses(saved).roots, []);

    // Sin fila previa ni otra fila del usuario tampoco entra.
    const firstSave = compactIshikawaState(mergeClientIshikawaState(null, forged, null));
    assert.equal(subCause(firstSave).closure, undefined);

    // ishikawa/assistant: se rehidrata desde la base antes del gate; el forjado desaparece y
    // el turno no tiene nada que escribir.
    const hydrated = hydrateServerFields(forged, stored);
    assert.equal(subCause(hydrated).closure, undefined);
    assert.equal(serverFieldsFingerprint(hydrated), serverFieldsFingerprint(stored));
  }

  // --- (b) Un closure legítimo persiste y sobrevive a la recarga -------------------
  // --- (c) El cliente guarda sin closure después y lo almacenado sigue ------------
  {
    const stored = buildState();
    const turnState = hydrateServerFields(cloneIshikawaState(stored), stored);

    const closed = await resolveCloseConfirmation({ state: turnState, now: NOW }, fixedJudge(ACTIONABLE));
    assert.equal(closed.kind, "closed");
    if (closed.kind !== "closed") return;
    assert.notEqual(serverFieldsFingerprint(closed.nextState), serverFieldsFingerprint(turnState));

    // La raíz se resuelve contra el registro (primera raíz: nueva, sin consultar a la IA).
    const root = await resolveBranchRoot(
      { state: closed.nextState, path: closed.path, now: NOW, newId: () => "root_1" },
      async () => null
    );
    assert.equal(root.kind, "new");

    // Escritura del asistente antes de responder.
    const written = compactIshikawaState(mergeAssistantIshikawaState(stored, root.nextState));
    assert.equal(subCause(written).closure?.reviewed, true);

    // Recarga (GET).
    const reloaded = compactIshikawaState(written);
    assert.equal(subCause(reloaded).closure?.reviewed, true);
    assert.deepEqual(deriveRootCauses(reloaded).roots, [WHYS[2]]);

    // (c) El cliente guarda un estado sin closure (copia vieja, o lo borró): gana lo almacenado.
    const withoutClosure = cloneIshikawaState(root.nextState);
    delete subCause(withoutClosure).closure;
    const afterClientSave = compactIshikawaState(mergeClientIshikawaState(written, withoutClosure, written));
    assert.deepEqual(subCause(afterClientSave).closure, subCause(written).closure);

    // Tampoco puede "des-cerrarla" mandando reviewed:false.
    const unreviewed = cloneIshikawaState(root.nextState);
    subCause(unreviewed).closure = { ...FORGED, reviewed: false };
    const afterUnreview = compactIshikawaState(mergeClientIshikawaState(written, unreviewed, written));
    assert.equal(subCause(afterUnreview).closure?.reviewed, true);

    // Guardado en un chat nuevo (sin fila propia): los campos salen de la última fila del usuario.
    const migrated = compactIshikawaState(mergeClientIshikawaState(null, withoutClosure, written));
    assert.equal(subCause(migrated).closure?.reviewed, true);
  }

  // --- (d) Un contador forjado no reinicia la escalada -----------------------------
  {
    const stored = buildState({
      subCauseName: "Falta de control de inventario",
      whys: [WHYS[0]],
    });
    subCause(stored).rejectedWhyAttempts = REJECTED_WHY_ATTEMPTS_LIMIT - 1;

    const forged = cloneIshikawaState(stored);
    subCause(forged).rejectedWhyAttempts = 0;

    // Repite la subcausa: el filtro determinista lo rechaza (tautología).
    const repeated = "falta control de inventario";

    const withServerCounter = await resolveFastPathWhyTurn(
      { state: hydrateServerFields(forged, stored), studentMessage: repeated, contextualIntent: null, now: NOW },
      fixedJudge(ACTIONABLE)
    );
    assert.equal(withServerCounter.kind, "escalate");

    // Si se creyera al cuerpo, el contador volvería a empezar y no se escalaría.
    const withForgedCounter = await resolveFastPathWhyTurn(
      { state: forged, studentMessage: repeated, contextualIntent: null, now: NOW },
      fixedJudge(ACTIONABLE)
    );
    assert.equal(withForgedCounter.kind, "blocked");

    // El guardado del cliente tampoco puede reiniciarlo.
    const saved = compactIshikawaState(mergeClientIshikawaState(stored, forged, stored));
    assert.equal(subCause(saved).rejectedWhyAttempts, REJECTED_WHY_ATTEMPTS_LIMIT - 1);

    // reformulateWhy sigue el mismo criterio.
    const forgedFlag = cloneIshikawaState(stored);
    subCause(forgedFlag).reformulateWhy = true;
    assert.equal(subCause(hydrateServerFields(forgedFlag, stored)).reformulateWhy, undefined);
  }

  // --- (e) El esquema de entrada acepta un cursor con ids en null ------------------
  // Hay estados guardados así (el LLM los devuelve al soltar una rama): se normalizan a
  // ausentes en vez de rechazar el guardado y el turno con 400.
  {
    const withNullCursor = { ...buildState(), cursor: { categoryId: null, mainCauseId: null } };
    const parsed = IshikawaStateInputSchema.safeParse(withNullCursor);
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.data.cursor)), {});

    // Los ids del árbol siguen siendo obligatorios.
    const withoutIds = { ...buildState(), categories: [{ name: "Método", mainCauses: [] }] };
    assert.equal(IshikawaStateInputSchema.safeParse(withoutIds).success, false);
  }
}

main()
  .then(() => console.log("ishikawaServerFields tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
