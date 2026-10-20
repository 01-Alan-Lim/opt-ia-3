import assert from "node:assert/strict";

import { approvedProfile, installFetchStub, prepareRouteTestEnv, routeRequest, type RouteStubState } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";

// Validación del servidor en la Etapa 0, sobre las rutas reales y sin red: Gemini y Supabase son
// simulados (assistantRouteHarness, messageRouteHarness).
//   - POST /api/plans/context/interpret: lo que devuelve Gemini se valida con stage0Values.ts
//     (deducciones, nombres de empresas y frases que no son datos no pasan) y un JSON inválido es
//     un error, no una "pregunta".
//   - POST /api/plans/context: rechaza un valor que no es un dato del caso y no escribe nada.
//   - POST /api/plans/context/confirm: confirma solo tres datos válidos; con los datos revisados en
//     el cuerpo, confirma esos.

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";
const COHORT = "88888888-8888-4888-8888-888888888888";

type Json = Record<string, unknown>;

async function interpretRoute() {
  const state: RouteStubState = {
    user: { id: USER, email: "ana.prueba@estudiante.test" },
    profile: approvedProfile(USER, COHORT),
    cohortActive: true,
    chatOwners: { [CHAT]: USER },
    artifact: null,
    geminiReplies: [],
  };
  const stub = installFetchStub(state);
  const route = await import("../../app/api/plans/context/interpret/route");

  const interpret = async (userText: string, gemini: string, step: 1 | 2 | 3 = 1) => {
    state.geminiReplies = [gemini];
    const res = await route.POST(routeRequest("/api/plans/context/interpret", { step, userText, currentContextJson: {} }));
    return { status: res.status, json: (await res.json()) as Json };
  };
  const reply = (body: Json) => JSON.stringify({ confidence: 0.95, needsClarification: false, ...body });

  {
    // Gemini deduce un producto y un área que el estudiante no dijo: no se devuelven.
    const r = await interpret(
      "Somos una panadería del barrio que atiende a los vecinos de la zona",
      reply({ intent: "ANSWER", sector: "Alimentos", products: ["Pan"], process_focus: ["Atención al cliente"] })
    );
    assert.equal(r.status, 200);
    const data = r.json.data as Json;
    assert.equal(data.sector, "Alimentos");
    assert.equal(data.products, undefined);
    assert.equal(data.process_focus, undefined);
    assert.deepEqual(data.rejected, [
      { field: "products", reason: "ungrounded" },
      { field: "process_focus", reason: "ungrounded" },
    ]);
  }
  {
    // El nombre de la empresa como rubro no sale de la ruta; el producto dicho, sí.
    const r = await interpret(
      "Trabajo en ACME Lácteos, que hace lácteos",
      reply({ intent: "ANSWER", sector: "ACME Lácteos", products: ["Lácteos"] })
    );
    const data = r.json.data as Json;
    assert.equal(data.sector, undefined);
    assert.deepEqual(data.products, ["Lácteos"]);
    assert.ok(!JSON.stringify(r.json).includes("ACME"), "la respuesta no repite el nombre");
    assert.deepEqual(data.rejected, [{ field: "sector", reason: "company_name" }]);
  }
  {
    // "Eso es confidencial" leído como rubro: sin datos, sigue siendo una respuesta que hay que aclarar.
    const r = await interpret("Eso es confidencial", reply({ intent: "ANSWER", sector: "Confidencial" }));
    const data = r.json.data as Json;
    assert.equal(data.sector, undefined);
    assert.equal(data.intent, "ANSWER");
    assert.equal(data.needsClarification, true);
    assert.ok((data.confidence as number) <= 0.4);
  }
  {
    // DECLINE pasa tal cual (el turno responde sin guardar).
    const r = await interpret("Todavía no lo decido", reply({ intent: "DECLINE", needsClarification: true, confidence: 0.6 }), 3);
    assert.equal((r.json.data as Json).intent, "DECLINE");
  }
  {
    // Un texto que no es JSON, o un JSON que no cumple el esquema: error, nunca una "pregunta".
    for (const bad of ["Claro, el rubro es alimentos.", JSON.stringify({ sector: "Alimentos" })]) {
      const r = await interpret("Hacemos yogur natural, de frutilla y también queso fresco para supermercados", bad, 2);
      assert.equal(r.status, 502, bad);
      assert.deepEqual(r.json, { ok: false, code: "INTERPRET_UNREADABLE", message: "No se pudo interpretar el mensaje." });
    }
  }
  assert.deepEqual(stub.writes, [], "la ruta no escribe nada");
  stub.restore();
}

async function contextRoutes() {
  const state: MessageStubState = {
    user: { id: USER, email: "ana.prueba@estudiante.test" },
    profile: approvedProfile(USER, COHORT),
    cohortActive: true,
    chats: { [CHAT]: { client_id: USER, mode: "plan_mejora" } },
    messages: [],
    schema: "m2",
    contexts: {},
  };
  const stub = installMessageStub(state);
  const context = await import("../../app/api/plans/context/route");
  const confirm = await import("../../app/api/plans/context/confirm/route");

  const post = async (body: unknown) => {
    stub.reset();
    const res = await context.POST(routeRequest("/api/plans/context", body));
    return { status: res.status, json: (await res.json()) as Json };
  };
  const confirmWith = async (body: unknown) => {
    stub.reset();
    const res = await confirm.POST(routeRequest("/api/plans/context/confirm", body));
    return { status: res.status, json: (await res.json()) as Json };
  };
  const stored = () => state.contexts[USER] as Json | undefined;

  // ---------------- POST /api/plans/context ----------------
  for (const contextJson of [
    { sector: "Confidencial" },
    { sector: "No decirlo" },
    { sector: "ACME Lácteos" },
    { products: ["Te dije", "Yogur"] },
    { process_focus: ["Todavía no lo decido"] },
  ]) {
    const r = await post({ contextJson, contextText: "x", chatId: CHAT });
    assert.equal(r.status, 400, JSON.stringify(contextJson));
    assert.equal(r.json.code, "INVALID_CONTEXT_VALUE");
    assert.equal(stub.writes("plan_case_contexts"), 0, "no guarda nada");
    assert.equal(stub.writes("chats"), 0, "ni cambia el título del chat");
  }
  assert.equal(stored(), undefined);

  assert.equal((await post({ contextJson: { sector: "Panadería" }, contextText: "Sector/Rubro: Panadería", chatId: CHAT })).status, 200);
  assert.equal((await post({ contextJson: { products: ["Pan", "Pasteles"] }, contextText: "x", chatId: CHAT })).status, 200);

  // ---------------- POST /api/plans/context/confirm ----------------
  // Sin los tres datos, como siempre.
  const missing = await confirmWith({});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, "BAD_REQUEST");

  // Con los tres datos el borrador NO se confirma solo: sigue en draft.
  assert.equal((await post({ contextJson: { process_focus: ["Producción"] }, contextText: "x", chatId: CHAT })).status, 200);
  assert.equal(stored()?.status, "draft");

  // Un valor viejo que no es un dato (de antes de esta validación): no se confirma.
  (stored()?.context_json as Json).process_focus = ["Quiero Analizar Producción"];
  const legacy = await confirmWith({});
  assert.equal(legacy.status, 400);
  assert.equal(legacy.json.code, "INVALID_CONTEXT_VALUE");
  assert.equal(stored()?.status, "draft");

  // Con los datos que el estudiante revisó en el cuerpo, confirma esos.
  const reviewed = { sector: "Panadería", products: ["Pan", "Pasteles"], process_focus: ["Producción"] };
  const ok = await confirmWith({ contextJson: reviewed });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(stored()?.status, "confirmed");
  assert.deepEqual((stored()?.context_json as Json).process_focus, ["Producción"]);
  assert.equal(((ok.json.data as Json).next as Json).toStage, 1);

  // Los datos revisados también pasan el control: un valor inválido en el cuerpo no se confirma.
  state.contexts[USER] = { ...stored(), status: "draft" };
  const forged = await confirmWith({ contextJson: { ...reviewed, sector: "Prefiero no decirlo" } });
  assert.equal(forged.status, 400);
  assert.equal(forged.json.code, "INVALID_CONTEXT_VALUE");

  stub.restore();
}

async function main() {
  prepareRouteTestEnv();
  await interpretRoute();
  await contextRoutes();
  console.log("stage0ContextRoutes tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
