import assert from "node:assert/strict";

import type { NextRequest } from "next/server";

import {
  approvedProfile,
  installFetchStub,
  prepareRouteTestEnv,
  routeRequest,
  type RouteStubState,
} from "./assistantRouteHarness";

// chatId opcional en las rutas assistant de E1–E3 (productivity, foda y brainstorm). Su lógica
// no depende del chat; el chatId sirve para verificar propiedad y, más adelante, firmar. Se
// ejecutan las rutas reales contra Supabase y Gemini simulados (sin red, escrituras
// rechazadas). Lo que se comprueba:
//   - con chatId propio la ruta responde igual que sin chatId;
//   - con chatId ajeno o inexistente corta con 403/404, en el formato de error de cada ruta,
//     justo después de la sesión y el gate y antes de leer el perfil o llamar al modelo;
//   - sin chatId o con null no se consulta chats y la ruta funciona como antes;
//   - un chatId que no es UUID es un cuerpo inválido, como cualquier otro campo;
//   - sesión y gate académico no cambian.

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_CHAT = "44444444-4444-4444-8444-444444444444";
const MISSING_CHAT = "55555555-5555-4555-8555-555555555555";
const COHORT = "66666666-6666-4666-8666-666666666666";

const state: RouteStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, COHORT),
  cohortActive: true,
  chatOwners: { [CHAT]: USER, [FOREIGN_CHAT]: OTHER_USER },
  artifact: null,
  geminiReplies: [],
};

type Json = Record<string, unknown>;

type RouteCase = {
  name: string;
  path: string;
  post: (req: NextRequest) => Promise<Response>;
  body: Json;
  // Respuesta del modelo para las llamadas que llegan a Gemini (null: la ruta no lo llama).
  geminiReply: string | null;
  // Formato de error propio de la ruta.
  err: (code: string, message: string) => Json;
  invalidBodyMessage: string;
  gateCode: string;
};

const items = (prefix: string) => [1, 2, 3].map((n) => ({ text: `${prefix} ${n}`, evidence: `Evidencia ${prefix} ${n}` }));

function stripReceipt(json: Json): Json {
  const data = json.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return json;
  const { assistantReceipt: _receipt, ...rest } = data as Json;
  void _receipt;
  return { ...json, data: rest };
}

async function main() {
  prepareRouteTestEnv();
  const stub = installFetchStub(state);

  const productivity = await import("../../app/api/plans/productivity/assistant/route");
  const foda = await import("../../app/api/plans/foda/assistant/route");
  const brainstorm = await import("../../app/api/plans/brainstorm/assistant/route");

  const plain = (code: string, message: string): Json => ({ ok: false, code, message });
  const withDetail = (code: string, message: string): Json => ({ ok: false, code, message, detail: null });

  const cases: RouteCase[] = [
    {
      name: "productivity",
      path: "/api/plans/productivity/assistant",
      post: productivity.POST,
      body: { studentMessage: "__START__", prodStep: 1, prodDraft: {} },
      geminiReply: JSON.stringify({
        assistantMessage: "Empecemos por la unidad de medida: ¿tu productividad será monetaria o física?",
        updates: {
          step: 1,
          patch: { unit_type: null, unit_reason: null, period: null, income_bs: null, income_line: null },
          addCosts: [],
        },
        control: { needsClarification: false, doneWithStage: false },
        signals: { uncertainty: 0.1, confusion: 0, confidence_extract: 0.9 },
      }),
      err: plain,
      invalidBodyMessage: "Payload inválido.",
      gateCode: "FORBIDDEN",
    },
    {
      name: "foda",
      path: "/api/plans/foda/assistant",
      post: foda.POST,
      body: {
        studentMessage: "continuemos",
        fodaState: {
          currentQuadrant: "A",
          items: { F: items("Fortaleza"), D: items("Debilidad"), O: items("Oportunidad"), A: items("Amenaza") },
          pendingEvidence: null,
        },
      },
      geminiReply: null,
      err: withDetail,
      invalidBodyMessage: "Body inválido.",
      gateCode: "FORBIDDEN",
    },
    {
      name: "brainstorm",
      path: "/api/plans/brainstorm/assistant",
      post: brainstorm.POST,
      body: { studentMessage: "Prefiero la estrategia FO", brainstormState: {} },
      geminiReply: JSON.stringify({
        assistantMessage: "Buena elección: FO usa tus fortalezas para aprovechar oportunidades. ¿Por qué la eliges?",
        updates: {
          nextState: { step: "choose_strategy", strategy: { type: "FO" }, problem: null, ideas: [], minIdeas: 10 },
          action: "set_strategy",
        },
      }),
      err: plain,
      invalidBodyMessage: "Payload inválido.",
      gateCode: "PENDING_APPROVAL",
    },
  ];

  async function call(route: RouteCase, body: Json, token: string | null = "token-de-prueba") {
    stub.reset();
    state.geminiReplies = route.geminiReply ? [route.geminiReply] : [];
    const res = await route.post(routeRequest(route.path, body, token));
    return { status: res.status, json: (await res.json()) as Json };
  }

  for (const route of cases) {
    // Chat ajeno: 403 justo después de la sesión y el gate; no se lee el perfil ni se llama al modelo.
    const foreign = await call(route, { ...route.body, chatId: FOREIGN_CHAT });
    assert.equal(foreign.status, 403, `${route.name}: chat ajeno`);
    assert.deepEqual(foreign.json, route.err("FORBIDDEN", "No tienes acceso a este chat."));
    assert.deepEqual(stub.tables(), ["profiles", "cohorts", "chats"], `${route.name}: el chat se comprueba antes de actuar`);
    assert.equal(stub.geminiCalls(), 0);

    // Chat inexistente: 404 en el mismo punto.
    const missing = await call(route, { ...route.body, chatId: MISSING_CHAT });
    assert.equal(missing.status, 404, `${route.name}: chat inexistente`);
    assert.deepEqual(missing.json, route.err("NOT_FOUND", "Chat no encontrado."));
    assert.deepEqual(stub.tables(), ["profiles", "cohorts", "chats"]);
    assert.equal(stub.geminiCalls(), 0);

    // Chat propio: pasa la comprobación y la ruta responde como siempre.
    const owner = await call(route, { ...route.body, chatId: CHAT });
    assert.equal(owner.status, 200, `${route.name}: dueño del chat`);
    assert.equal(owner.json.ok, true);
    const ownerCalls = [...stub.calls];
    const chatIndex = ownerCalls.findIndex((c) => c.table === "chats");
    assert.equal(stub.tables().indexOf("chats"), 2, `${route.name}: orden sesión -> gate -> chat`);
    const firstModelCall = ownerCalls.findIndex((c) => c.host === "generativelanguage.googleapis.com");
    if (route.geminiReply) {
      assert.ok(firstModelCall > chatIndex, `${route.name}: el modelo se llama después de comprobar el chat`);
    } else {
      assert.equal(firstModelCall, -1, `${route.name}: rama determinista, sin modelo`);
    }

    // Sin chatId (como los clientes actuales) o con null: misma respuesta y sin consultar chats.
    for (const body of [route.body, { ...route.body, chatId: null }]) {
      const noChat = await call(route, body);
      assert.equal(noChat.status, 200, `${route.name}: sin chatId`);
      assert.deepEqual(noChat.json, stripReceipt(owner.json), `${route.name}: misma respuesta con o sin chatId`);
      assert.ok(!stub.tables().includes("chats"), `${route.name}: sin chatId no se consulta chats`);
    }

    // chatId que no es UUID: cuerpo inválido, sin consultar chats.
    const invalid = await call(route, { ...route.body, chatId: "no-es-un-uuid" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.json, route.err("BAD_REQUEST", route.invalidBodyMessage));
    assert.ok(!stub.tables().includes("chats"));

    // Sin sesión: el 401 de siempre, sin tocar Supabase.
    const anonymous = await call(route, { ...route.body, chatId: CHAT }, null);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.json, route.err("UNAUTHORIZED", "Sesión inválida o ausente."));
    assert.equal(stub.calls.length, 0);

    // Gate académico: se corta antes de mirar el chat, con el código de siempre de cada ruta.
    state.profile = { ...approvedProfile(USER, COHORT), registration_status: "pending" };
    const pending = await call(route, { ...route.body, chatId: FOREIGN_CHAT });
    state.profile = approvedProfile(USER, COHORT);
    assert.equal(pending.status, 403);
    assert.deepEqual(pending.json, route.err(route.gateCode, "Tu registro está pendiente de aprobación."));
    assert.ok(!stub.tables().includes("chats"), `${route.name}: el gate va antes que el chat`);
  }

  assert.equal(stub.writes.length, 0, "ninguna petición escribe en Supabase");
  stub.restore();
}

main()
  .then(() => console.log("assistantRouteOptionalChat tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
