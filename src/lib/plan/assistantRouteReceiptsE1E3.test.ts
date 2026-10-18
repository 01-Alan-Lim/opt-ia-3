import assert from "node:assert/strict";

import { verifyAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import {
  approvedProfile,
  installFetchStub,
  prepareRouteTestEnv,
  routeRequest,
  type RouteStubState,
} from "./assistantRouteHarness";

// Recibos en las rutas assistant de E1–E3 (productivity, foda y brainstorm). Rutas reales
// contra Supabase y Gemini simulados (sin red, escrituras rechazadas), con clave de prueba.
//
// Un recibo prueba que el servidor EMITIÓ ese texto para ese usuario y ese chat, no que lo
// haya escrito el modelo. Por eso se separan tres casos:
//   - texto del modelo tal cual (productivity) o transformado por la ruta (brainstorm cambia
//     [nombre] por el nombre): el recibo vale para el texto emitido, no para el crudo;
//   - texto fijo del servidor sin llamar al modelo (foda, avance determinista);
//   - texto fijo del servidor tras un fallo del modelo (productivity sin JSON válido).
// Además: sin chatId no hay recibo, los errores salen sin recibo y el adaptador no repite la
// llamada al modelo.

const SECRET = Buffer.from("opt-ia: secreto de recibos E1-E3, solo para pruebas").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_CHAT = "44444444-4444-4444-8444-444444444444";
const COHORT = "66666666-6666-4666-8666-666666666666";

const FODA_COMPLETE =
  "✅ El FODA ya está completo en sus 4 cuadrantes. Ahora corresponde validarlo para pasar a la siguiente etapa.";
const PRODUCTIVITY_FALLBACK =
  "No pude interpretar bien tu respuesta. ¿Puedes decirlo en una frase corta (con números si aplica)?";

const state: RouteStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, COHORT),
  cohortActive: true,
  chatOwners: { [CHAT]: USER, [FOREIGN_CHAT]: OTHER_USER },
  artifact: null,
  geminiReplies: [],
};

type Json = Record<string, unknown>;

const items = (prefix: string) => [1, 2, 3].map((n) => ({ text: `${prefix} ${n}`, evidence: `Evidencia ${prefix} ${n}` }));
const completeFoda = {
  currentQuadrant: "A",
  items: { F: items("Fortaleza"), D: items("Debilidad"), O: items("Oportunidad"), A: items("Amenaza") },
  pendingEvidence: null,
};

function productivityReply(message: string): string {
  return JSON.stringify({
    assistantMessage: message,
    updates: {
      step: 1,
      patch: { unit_type: null, unit_reason: null, period: null, income_bs: null, income_line: null },
      addCosts: [],
    },
    control: { needsClarification: false, doneWithStage: false },
    signals: { uncertainty: 0.1, confusion: 0, confidence_extract: 0.9 },
  });
}

async function main() {
  prepareRouteTestEnv({ ASSISTANT_RECEIPT_SECRET: SECRET });
  const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
  assert.ok(keyStatus.ok);
  const key = keyStatus.key;
  const verify = (receipt: unknown, content: string, chatId = CHAT, userId = USER) => {
    const r = verifyAssistantReceipt(key, receipt, { userId, chatId, content });
    return r.ok ? "OK" : r.reason;
  };

  const stub = installFetchStub(state);
  const productivity = await import("../../app/api/plans/productivity/assistant/route");
  const foda = await import("../../app/api/plans/foda/assistant/route");
  const brainstorm = await import("../../app/api/plans/brainstorm/assistant/route");

  async function post(
    handler: (req: ReturnType<typeof routeRequest>) => Promise<Response>,
    path: string,
    body: Json,
    replies: string[] = [],
    token: string | null = "token-de-prueba",
  ) {
    stub.reset();
    state.geminiReplies = [...replies];
    const res = await handler(routeRequest(path, body, token));
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Json };
  }

  // 1) productivity: texto del modelo emitido sin cambios, con recibo; una sola llamada.
  const modelText = "Empecemos por la unidad de medida: ¿tu productividad será monetaria o física?";
  const prod = await post(productivity.POST, "/api/plans/productivity/assistant",
    { chatId: CHAT, studentMessage: "__START__", prodStep: 1, prodDraft: {} }, [productivityReply(modelText)]);
  assert.equal(prod.status, 200);
  const prodData = prod.json.data as Json;
  assert.equal(prodData.assistantMessage, modelText);
  assert.equal(verify(prodData.assistantReceipt, modelText), "OK");
  assert.equal(verify(prodData.assistantReceipt, modelText, FOREIGN_CHAT), "CHAT_MISMATCH");
  assert.equal(verify(prodData.assistantReceipt, modelText, CHAT, OTHER_USER), "USER_MISMATCH");
  assert.equal(stub.geminiCalls(), 1, "el adaptador no repite la llamada al modelo");

  // 2) productivity: el modelo no devuelve JSON y la ruta responde un texto fijo. Se firma
  //    porque el servidor lo emitió, aunque no lo haya escrito el modelo.
  const fallback = await post(productivity.POST, "/api/plans/productivity/assistant",
    { chatId: CHAT, studentMessage: "Es monetaria", prodStep: 1, prodDraft: {} }, ["respuesta sin json"]);
  assert.equal(fallback.status, 200);
  const fallbackData = fallback.json.data as Json;
  assert.equal(fallbackData.assistantMessage, PRODUCTIVITY_FALLBACK);
  assert.equal(verify(fallbackData.assistantReceipt, PRODUCTIVITY_FALLBACK), "OK");
  assert.equal(stub.geminiCalls(), 1);

  // 3) foda: avance determinista, sin modelo. Texto fijo firmado; meta se conserva.
  const fodaFixed = await post(foda.POST, "/api/plans/foda/assistant",
    { chatId: CHAT, studentMessage: "continuemos", fodaState: completeFoda });
  assert.equal(fodaFixed.status, 200);
  assert.deepEqual(Object.keys(fodaFixed.json), ["ok", "data", "meta"]);
  const fodaData = fodaFixed.json.data as Json;
  assert.deepEqual(Object.keys(fodaData), ["assistantMessage", "updates", "assistantReceipt"]);
  assert.equal(fodaData.assistantMessage, FODA_COMPLETE);
  assert.equal(verify(fodaData.assistantReceipt, FODA_COMPLETE), "OK");
  assert.equal((fodaFixed.json.meta as Json).reason, "DETERMINISTIC_QUADRANT_ADVANCE");
  assert.equal(stub.geminiCalls(), 0);

  // 4) brainstorm: la ruta cambia [nombre] por el nombre; el recibo vale para lo emitido.
  const rawBrainstorm = "¡Bien, [nombre]! La estrategia FO usa tus fortalezas para aprovechar oportunidades. ¿Por qué la eliges?";
  const brain = await post(brainstorm.POST, "/api/plans/brainstorm/assistant",
    { chatId: CHAT, studentMessage: "Prefiero la estrategia FO", brainstormState: {} },
    [JSON.stringify({
      assistantMessage: rawBrainstorm,
      updates: {
        nextState: { step: "choose_strategy", strategy: { type: "FO" }, problem: null, ideas: [], minIdeas: 10 },
        action: "set_strategy",
      },
    })]);
  assert.equal(brain.status, 200);
  const brainData = brain.json.data as Json;
  const emitted = String(brainData.assistantMessage);
  assert.ok(emitted.startsWith("¡Bien, Ana!"), "la ruta sustituye el placeholder");
  assert.equal(verify(brainData.assistantReceipt, emitted), "OK");
  assert.equal(verify(brainData.assistantReceipt, rawBrainstorm), "CONTENT_MISMATCH");
  assert.equal(stub.geminiCalls(), 1);

  // 5) Sin chatId (clientes que no lo envían) o con null: respuesta normal, sin recibo y sin
  //    consultar chats.
  for (const chatId of [undefined, null]) {
    const withChat = chatId === undefined ? {} : { chatId };
    const prodNoChat = await post(productivity.POST, "/api/plans/productivity/assistant",
      { ...withChat, studentMessage: "__START__", prodStep: 1, prodDraft: {} }, [productivityReply(modelText)]);
    const fodaNoChat = await post(foda.POST, "/api/plans/foda/assistant",
      { ...withChat, studentMessage: "continuemos", fodaState: completeFoda });
    for (const r of [prodNoChat, fodaNoChat]) {
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes("assistantReceipt"), "sin chatId no hay recibo");
    }
    assert.ok(!stub.tables().includes("chats"));
  }

  // 6) Errores: sin recibo y con el formato de siempre.
  const foreign = await post(foda.POST, "/api/plans/foda/assistant",
    { chatId: FOREIGN_CHAT, studentMessage: "continuemos", fodaState: completeFoda });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.json, { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat.", detail: null });
  const anonymous = await post(brainstorm.POST, "/api/plans/brainstorm/assistant",
    { chatId: CHAT, studentMessage: "Prefiero FO", brainstormState: {} }, [], null);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.json, { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." });
  const modelDown = await post(brainstorm.POST, "/api/plans/brainstorm/assistant",
    { chatId: CHAT, studentMessage: "Prefiero FO", brainstormState: {} }, ["sin json"]);
  assert.equal(modelDown.status, 500);
  assert.deepEqual(modelDown.json, { ok: false, code: "INTERNAL", message: "La IA no devolvió un JSON válido para Etapa 3." });
  for (const r of [foreign, anonymous, modelDown]) {
    assert.ok(!r.text.includes("assistantReceipt"), "ninguna respuesta fallida lleva recibo");
  }

  assert.equal(stub.writes.length, 0, "ninguna petición escribe en Supabase");
  stub.restore();
}

main()
  .then(() => console.log("assistantRouteReceiptsE1E3 tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
