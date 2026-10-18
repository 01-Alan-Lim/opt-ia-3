import assert from "node:assert/strict";

import {
  answerPendingRootMatch,
  interpretPendingRootReply,
  isAboutPendingRootQuestion,
  resolveBranchRoot,
  resolveDeferredRootQuestion,
  type RootMatcher,
  type RootPath,
} from "./ishikawaRootRegistry";
import { parsePendingRootMatch, parseRootRegistry, type IshikawaState } from "./ishikawaTree";
import { MAX_WHY_DEPTH } from "./rootCauseLimits";

// Tanda 3, Fase 4: la pregunta de causa raíz repetida no traba la conversación. Si mientras
// está abierta se cierra otra rama con una raíz parecida, no se pisa la pregunta: esa raíz
// queda como nueva y se compara cuando el estudiante responda. Gemini simulado; datos
// ficticios.

const NOW = "2026-03-01T12:00:00.000Z";
const ROOT_A = "No existe un procedimiento para planificar turnos según la demanda";
const ROOT_B = "Falta un procedimiento para planificar los turnos según la demanda";
const ROOT_C = "No hay un procedimiento para planificar los turnos según la demanda del día";

const path = (subCauseId: string): RootPath => ({ categoryId: "cat_metodo", mainCauseId: "mc_turnos", subCauseId });

function buildState(): IshikawaState {
  const closed = (id: string, root: string) => ({
    id,
    name: `Subcausa ${id}`,
    whys: ["Primer porqué de la rama", "Segundo porqué de la rama", root],
    closure: { reviewed: true, at: NOW, verdict: "actionable" as const, origin: "system" as const, rootId: null },
  });

  return {
    problem: { text: "Demoras en la entrega de pedidos" },
    categories: [
      {
        id: "cat_metodo",
        name: "Método",
        mainCauses: [
          {
            id: "mc_turnos",
            name: "Turnos mal distribuidos",
            subCauses: [closed("sc_a", ROOT_A), closed("sc_b", ROOT_B), closed("sc_c", ROOT_C)],
          },
        ],
      },
    ],
    minCategories: 3,
    minMainCausesPerCategory: 2,
    minSubCausesPerMain: 1,
    maxWhyDepth: MAX_WHY_DEPTH,
    cursor: { categoryId: "cat_metodo", mainCauseId: "mc_turnos" },
  };
}

// La IA propone que la raíz nueva (clave) es la misma que otra ya registrada (valor).
function scriptedMatcher(proposals: ReadonlyMap<string, string>) {
  const calls: string[] = [];
  const matcher: RootMatcher = async ({ newRoot, candidates }) => {
    calls.push(newRoot);
    const target = proposals.get(newRoot);
    const match = candidates.find((candidate) => candidate.text === target);
    return { sameAs: match?.id ?? null, reason: match ? "Describen la misma falla." : "" };
  };
  return { matcher, calls };
}

let counter = 0;
const newId = () => `root_${++counter}`;

async function main() {
  const { matcher, calls } = scriptedMatcher(
    new Map([
      [ROOT_B, ROOT_A],
      [ROOT_C, ROOT_A],
    ])
  );
  let state = buildState();

  const a = await resolveBranchRoot({ state, path: path("sc_a"), now: NOW, newId }, matcher);
  assert.equal(a.kind, "new");
  state = a.nextState;

  const b = await resolveBranchRoot({ state, path: path("sc_b"), now: NOW, newId, canAsk: true }, matcher);
  assert.equal(b.kind, "question");
  state = b.nextState;
  assert.equal(calls.length, 1);

  // Con la pregunta abierta, otra raíz parecida no consulta a la IA ni pisa la pregunta.
  const c = await resolveBranchRoot({ state, path: path("sc_c"), now: NOW, newId, canAsk: false }, matcher);
  assert.equal(c.kind, "new");
  assert.equal(c.kind === "new" ? c.deferred : undefined, true);
  state = c.nextState;
  assert.equal(calls.length, 1);
  assert.equal(parsePendingRootMatch(state.pendingRootMatch)?.subCauseId, "sc_b");
  assert.equal(parseRootRegistry(state.rootCauses).find((entry) => entry.canonicalText === ROOT_C)?.recheck, true);

  // El estudiante responde "no": B queda distinta de A.
  const answered = answerPendingRootMatch(state, "no");
  assert.equal(answered.kind, "kept_distinct");
  state = answered.nextState;
  assert.equal(parsePendingRootMatch(state.pendingRootMatch), null);

  // Ahora se compara C (una consulta): la IA la ve igual a A y se le pregunta al estudiante.
  const deferred = await resolveDeferredRootQuestion({ state, now: NOW }, matcher);
  assert.equal(deferred.kind, "question");
  if (deferred.kind !== "question") return;
  assert.equal(calls.length, 2);
  assert.equal(deferred.entry.canonicalText, ROOT_C);
  assert.equal(deferred.candidate.canonicalText, ROOT_A);
  state = deferred.nextState;
  assert.equal(parsePendingRootMatch(state.pendingRootMatch)?.subCauseId, "sc_c");
  assert.equal(parseRootRegistry(state.rootCauses).find((entry) => entry.canonicalText === ROOT_C)?.recheck, undefined);

  // Con una pregunta abierta no se busca otra.
  assert.equal((await resolveDeferredRootQuestion({ state, now: NOW }, matcher)).kind, "none");

  // "Sí": C se une a A. Ninguna raíz queda por revisar ni se vuelve a consultar.
  const merged = answerPendingRootMatch(state, "yes");
  assert.equal(merged.kind, "merged");
  if (merged.kind === "merged") assert.equal(merged.entry.occurrences.length, 2);
  assert.equal((await resolveDeferredRootQuestion({ state: merged.nextState, now: NOW }, matcher)).kind, "none");
  assert.equal(calls.length, 2);

  // Sí/no a la pregunta pendiente cuando no traba la conversación: solo cuentan un sí o un no
  // explícitos o una frase sobre "la misma"/"distintas".
  const expectReply = (text: string, expected: "yes" | "no" | "unclear") =>
    assert.equal(interpretPendingRootReply(text), expected, text);

  expectReply("sí", "yes");
  expectReply("Sí, es la misma", "yes");
  expectReply("es la misma causa", "yes");
  expectReply("claro", "yes");
  expectReply("no", "no");
  expectReply("no.", "no");
  expectReply("No, son distintas", "no");
  expectReply("son diferentes", "no");
  expectReply("ok", "unclear"); // un "ok" no aprueba una fusión
  expectReply("dale", "unclear");
  expectReply("no lo sé", "unclear");
  expectReply("tal vez", "unclear");
  expectReply("No hay registro de temperatura", "unclear"); // es la respuesta a un porqué
  expectReply("Sí hay un encargado pero no revisa", "unclear");
  expectReply("¿son la misma causa?", "unclear"); // una pregunta no aprueba una fusión

  assert.equal(isAboutPendingRootQuestion("¿son la misma causa?"), true);
  assert.equal(isAboutPendingRootQuestion("No hay registro"), false);
}

main()
  .then(() => console.log("ishikawaRootDeferred tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
