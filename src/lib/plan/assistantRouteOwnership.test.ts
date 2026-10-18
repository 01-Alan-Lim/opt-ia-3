import assert from "node:assert/strict";

import type { NextRequest } from "next/server";

import {
  approvedProfile,
  installFetchStub,
  prepareRouteTestEnv,
  routeRequest,
  type RouteStubState,
} from "./assistantRouteHarness";

// Propiedad del chat en las rutas assistant de E6–E9 (improvement, objectives, planning y
// progress). Se ejecutan las rutas reales contra un Supabase y un Gemini simulados: sin red,
// sin base real y sin llamadas al modelo. Lo que se comprueba:
//   - el chat se verifica DESPUÉS de la sesión y del gate académico, y ANTES de leer
//     artefactos, leer el perfil para el prompt o llamar al modelo;
//   - un chat ajeno o inexistente corta con 403/404 y el formato de error de la ruta;
//   - el propietario pasa la comprobación y la ruta sigue como antes;
//   - las respuestas de error originales (sesión, gate, cuerpo inválido) no cambian;
//   - ninguna petición escribe en Supabase.

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

type RouteCase = {
  name: string;
  path: string;
  post: (req: NextRequest) => Promise<Response>;
  body: (chatId: unknown) => Record<string, unknown>;
  invalidBodyMessage: string;
};

function withoutChatId(body: Record<string, unknown>): Record<string, unknown> {
  const { chatId: _omitted, ...rest } = body;
  void _omitted;
  return rest;
}

async function main() {
  prepareRouteTestEnv();
  const stub = installFetchStub(state);

  const improvement = await import("../../app/api/plans/improvement/assistant/route");
  const objectives = await import("../../app/api/plans/objectives/assistant/route");
  const planning = await import("../../app/api/plans/planning/assistant/route");
  const progress = await import("../../app/api/plans/progress/assistant/route");

  const cases: RouteCase[] = [
    {
      name: "improvement",
      path: "/api/plans/improvement/assistant",
      post: improvement.POST,
      body: (chatId) => ({ chatId, studentMessage: "Propongo estandarizar el despacho", improvementState: {} }),
      invalidBodyMessage: "Body inválido.",
    },
    {
      name: "objectives",
      path: "/api/plans/objectives/assistant",
      post: objectives.POST,
      body: (chatId) => ({
        chatId,
        studentMessage: "Reducir las demoras de despacho",
        objectivesState: { generalObjective: "", specificObjectives: [], linkedCriticalRoots: [], step: "general" },
      }),
      invalidBodyMessage: "Payload inválido.",
    },
    {
      name: "planning",
      path: "/api/plans/planning/assistant",
      post: planning.POST,
      body: (chatId) => ({ chatId, studentMessage: "La capacitación va en la semana 1", planningState: {} }),
      invalidBodyMessage: "Body inválido.",
    },
    {
      name: "progress",
      path: "/api/plans/progress/assistant",
      post: progress.POST,
      body: (chatId) => ({
        chatId,
        studentMessage: "Terminé la capacitación del personal",
        progressState: {
          step: "intro",
          reportText: null,
          progressPercent: null,
          measurementNote: null,
          summary: null,
          updatedAtLocal: null,
        },
      }),
      invalidBodyMessage: "Body inválido.",
    },
  ];

  async function call(route: RouteCase, body: unknown, token: string | null = "token-de-prueba") {
    stub.reset();
    const res = await route.post(routeRequest(route.path, body, token));
    return { res, json: (await res.json()) as Record<string, unknown> };
  }

  for (const route of cases) {
    // Chat ajeno: 403 justo después de comprobar el chat; nada se lee ni se genera después.
    const foreign = await call(route, route.body(FOREIGN_CHAT));
    assert.equal(foreign.res.status, 403, `${route.name}: chat ajeno`);
    assert.deepEqual(foreign.json, { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." });
    assert.deepEqual(stub.tables(), ["profiles", "cohorts", "chats"], `${route.name}: el chat se comprueba antes de actuar`);
    assert.equal(stub.geminiCalls(), 0, `${route.name}: sin llamadas al modelo`);

    // Chat inexistente: 404 en el mismo punto.
    const missing = await call(route, route.body(MISSING_CHAT));
    assert.equal(missing.res.status, 404, `${route.name}: chat inexistente`);
    assert.deepEqual(missing.json, { ok: false, code: "NOT_FOUND", message: "Chat no encontrado." });
    assert.deepEqual(stub.tables(), ["profiles", "cohorts", "chats"]);
    assert.equal(stub.geminiCalls(), 0);

    // Propietario: pasa la comprobación y la ruta sigue con su lógica de siempre (aquí se
    // detiene más adelante por el estado o por la etapa previa, sin artefactos simulados).
    const owner = await call(route, route.body(CHAT));
    assert.notEqual(owner.json.code, "FORBIDDEN", `${route.name}: el dueño no se bloquea`);
    assert.notEqual(owner.json.code, "NOT_FOUND", `${route.name}: el dueño no se bloquea`);
    const tables = stub.tables();
    assert.deepEqual(tables.slice(0, 3), ["profiles", "cohorts", "chats"], `${route.name}: orden sesión -> gate -> chat`);
    assert.equal(tables.indexOf("chats"), 2, `${route.name}: nada se lee antes de comprobar el chat`);
    assert.equal(stub.geminiCalls(), 0);

    // chatId obligatorio: sin él, el mismo 400 de antes y sin consultar chats.
    const noChat = await call(route, withoutChatId(route.body(CHAT)));
    assert.equal(noChat.res.status, 400, `${route.name}: chatId ausente`);
    assert.deepEqual(noChat.json, { ok: false, code: "BAD_REQUEST", message: route.invalidBodyMessage });
    assert.ok(!stub.tables().includes("chats"));
    const nullChat = await call(route, route.body(null));
    assert.equal(nullChat.res.status, 400, `${route.name}: chatId null`);
    assert.ok(!stub.tables().includes("chats"));

    // Sin sesión: el 401 de siempre, sin tocar Supabase.
    const anonymous = await call(route, route.body(CHAT), null);
    assert.equal(anonymous.res.status, 401, `${route.name}: sin sesión`);
    assert.deepEqual(anonymous.json, { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." });
    assert.equal(stub.calls.length, 0);

    // Gate académico: un registro pendiente se corta antes de mirar el chat.
    state.profile = { ...approvedProfile(USER, COHORT), registration_status: "pending" };
    const pending = await call(route, route.body(FOREIGN_CHAT));
    state.profile = approvedProfile(USER, COHORT);
    assert.equal(pending.res.status, 403, `${route.name}: gate académico`);
    assert.deepEqual(pending.json, {
      ok: false,
      code: "PENDING_APPROVAL",
      message: "Tu registro está pendiente de aprobación.",
    });
    assert.ok(!stub.tables().includes("chats"), `${route.name}: el gate va antes que el chat`);
  }

  assert.equal(stub.writes.length, 0, "ninguna petición escribe en Supabase");
  stub.restore();
}

main()
  .then(() => console.log("assistantRouteOwnership tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
