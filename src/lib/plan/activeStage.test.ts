import assert from "node:assert/strict";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, type RestRow, type RestStubState } from "./restStubHarness";
import { getPeriodKeyLaPaz } from "../time/periodKey";

// Etapa activa del asesor (src/lib/plan/activeStage.ts, la que lee /api/plans/active-stage y
// muestra la barra lateral) contra un Supabase simulado en memoria, sin red. El plan es uno por
// estudiante (plan_case_contexts tiene una fila por user_id): los chats nuevos lo comparten.
// Comprueba que con E0 en borrador la etapa es 0 aunque haya quedado un estado del wizard de E1
// (lo dejaba "Nuevo chat"), que con E0 confirmado es 1 y que las etapas siguientes respetan sus
// puertas (artefacto validado de la anterior).

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHAT_A = "a0000000-0000-4000-8000-000000000001";
const CHAT_B = "b0000000-0000-4000-8000-000000000002";
const PERIOD = getPeriodKeyLaPaz();

const state: RestStubState = {
  user: null,
  tables: { plan_case_contexts: [], plan_stage_states: [], plan_stage_artifacts: [] },
};

function context(status: "draft" | "confirmed", contextJson: Record<string, unknown>, userId = USER): RestRow {
  return { user_id: userId, chat_id: CHAT_A, status, context_json: contextJson, context_text: null, updated_at: "2026-10-18T10:00:00Z" };
}

function artifact(stage: number, artifactType: string, status: string, payload: Record<string, unknown>, userId = USER): RestRow {
  return { user_id: userId, chat_id: CHAT_B, stage, artifact_type: artifactType, period_key: PERIOD, status, payload, updated_at: "2026-10-18T11:00:00Z" };
}

function stageState(stage: number, stateJson: Record<string, unknown>): RestRow {
  return { user_id: USER, chat_id: CHAT_B, stage, state_json: stateJson, updated_at: "2026-10-18T12:00:00Z" };
}

function setTables(tables: Partial<Record<"plan_case_contexts" | "plan_stage_states" | "plan_stage_artifacts", RestRow[]>>) {
  state.tables.plan_case_contexts = tables.plan_case_contexts ?? [];
  state.tables.plan_stage_states = tables.plan_stage_states ?? [];
  state.tables.plan_stage_artifacts = tables.plan_stage_artifacts ?? [];
}

// Lo que dejaba "Nuevo chat" en E0: el wizard de E1 en reposo, en el chat anterior.
const idleWizard = () => artifact(1, "productivity_wizard_state", "draft", { prodStep: 0, prodDraft: {} });

async function main() {
  prepareRouteTestEnv();
  const stub = installRestStub(state);
  const { resolveActivePlanStage } = await import("./activeStage");
  const resolve = async () => {
    const r = await resolveActivePlanStage(USER);
    return { found: r.found, stage: r.stage, source: r.source };
  };

  // Sin nada: E0 sin empezar.
  setTables({});
  assert.deepEqual(await resolve(), { found: false, stage: 0, source: "none" });

  // E0 en borrador, vacío o a medias: Etapa 0.
  setTables({ plan_case_contexts: [context("draft", {})] });
  assert.deepEqual(await resolve(), { found: true, stage: 0, source: "context_draft" });
  setTables({ plan_case_contexts: [context("draft", { sector: "Alimentos" })] });
  const partial = await resolveActivePlanStage(USER);
  assert.deepEqual([partial.stage, partial.stateJson?.sector], [0, "Alimentos"]);

  // El caso observado: E0 en borrador y un wizard de E1 en reposo de "Nuevo chat". Antes: Etapa 1.
  setTables({ plan_case_contexts: [context("draft", { sector: "Alimentos" })], plan_stage_artifacts: [idleWizard()] });
  assert.deepEqual(await resolve(), { found: true, stage: 0, source: "context_draft" });
  // Aunque el wizard tuviera un paso: E1 no empieza sin E0 confirmado.
  setTables({
    plan_case_contexts: [context("draft", {})],
    plan_stage_artifacts: [artifact(1, "productivity_wizard_state", "draft", { prodStep: 2, prodDraft: {} })],
  });
  assert.equal((await resolve()).stage, 0);

  // E0 confirmado: Etapa 1 (por el contexto, o por el wizard si E1 está en curso).
  const confirmed = context("confirmed", { sector: "Alimentos", products: ["Yogur"], process_focus: ["Producción"] });
  setTables({ plan_case_contexts: [confirmed] });
  assert.deepEqual(await resolve(), { found: true, stage: 1, source: "context_confirmed" });
  setTables({
    plan_case_contexts: [confirmed],
    plan_stage_artifacts: [artifact(1, "productivity_wizard_state", "draft", { prodStep: 3, prodDraft: { type: "monetaria" } })],
  });
  const wizard = await resolveActivePlanStage(USER);
  assert.deepEqual([wizard.stage, wizard.source, wizard.stateJson?.prodStep], [1, "artifact", 3]);
  // El resto en reposo con E0 confirmado sigue en Etapa 1 (no reinicia nada).
  setTables({ plan_case_contexts: [confirmed], plan_stage_artifacts: [idleWizard()] });
  assert.equal((await resolve()).stage, 1);

  // Puertas: FODA en curso solo cuenta con E1 validada; sin ella no se salta a Etapa 2.
  const foda = stageState(2, { currentQuadrant: "F", items: { F: [{ text: "x" }], D: [], O: [], A: [] } });
  setTables({ plan_case_contexts: [confirmed], plan_stage_states: [foda] });
  assert.equal((await resolve()).stage, 1, "sin productividad validada no hay Etapa 2");
  setTables({
    plan_case_contexts: [confirmed],
    plan_stage_states: [foda],
    plan_stage_artifacts: [artifact(1, "productivity_report", "validated", { type: "monetaria" })],
  });
  assert.deepEqual(await resolve(), { found: true, stage: 2, source: "stage_state" });

  // El avance es por estudiante: lo de otra cuenta no cuenta.
  setTables({
    plan_case_contexts: [context("draft", {}), context("confirmed", { sector: "Textil" }, OTHER)],
    plan_stage_artifacts: [artifact(1, "productivity_wizard_state", "draft", { prodStep: 2 }, OTHER)],
  });
  assert.equal((await resolve()).stage, 0);

  // Solo lectura: resolver la etapa no escribe nada.
  for (const table of ["plan_case_contexts", "plan_stage_states", "plan_stage_artifacts"]) {
    assert.equal(stub.writes(table), 0, table);
  }

  stub.restore();
  console.log("activeStage tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
