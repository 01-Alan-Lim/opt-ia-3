import assert from "node:assert/strict";

import { signAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import { approvedProfile, prepareRouteTestEnv, routeRequest } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";

// Idempotencia y replay en POST /api/messages (R1-D). La unicidad la imponen los índices de M2
// (aquí, la tabla en memoria con los mismos índices y errores que PostgREST; la garantía real en
// Postgres se prueba en supabase/tests/m2_message_provenance.pglite.mjs). Comprueba:
//   - un recibo produce una fila, aunque llegue repetido o en solicitudes concurrentes, y cada
//     repetición recibe la misma fila con duplicate: true;
//   - el mismo texto con otro recibo (la IA repite una respuesta) sí es otra fila;
//   - un recibo no sirve en otro chat;
//   - reintentos de user/advisor con la misma clave no duplican; la misma clave con otro texto
//     es 409; la clave es por chat.

const SECRET = Buffer.from("opt-ia: secreto de recibos para idempotencia, solo pruebas").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";

const state: MessageStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, "88888888-8888-4888-8888-888888888888"),
  cohortActive: true,
  chats: {
    [CHAT]: { client_id: USER, mode: "plan_mejora" },
    [OTHER_CHAT]: { client_id: USER, mode: "plan_mejora" },
  },
  messages: [],
  schema: "m2",
  contexts: {},
};

type Json = Record<string, unknown>;

async function main() {
  prepareRouteTestEnv({ ASSISTANT_RECEIPT_SECRET: SECRET });
  const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
  assert.ok(keyStatus.ok);
  const key = keyStatus.key;
  const stub = installMessageStub(state);
  const route = await import("../../app/api/messages/route");

  async function post(body: unknown) {
    const res = await route.POST(routeRequest("/api/messages", body));
    return { status: res.status, json: (await res.json()) as Json };
  }
  const messageOf = (r: { json: Json }) => (r.json.data as Json).message as Json;
  const duplicateOf = (r: { json: Json }) => (r.json.data as Json).duplicate;
  const reply = (content: string, chatId = CHAT) => ({
    chatId,
    role: "assistant",
    serverReply: { assistantMessage: content, assistantReceipt: signAssistantReceipt(key, { userId: USER, chatId, content }) },
  });
  const rows = (chatId = CHAT) => state.messages.filter((m) => m.chat_id === chatId);

  // ---------------- Recibo repetido ----------------
  const body = reply("¿Qué porcentaje del cronograma llevas?");
  const first = await post(body);
  const again = await post(body);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200, "la repetición recibe una respuesta coherente");
  assert.equal(duplicateOf(first), false);
  assert.equal(duplicateOf(again), true);
  assert.deepEqual(messageOf(again), messageOf(first), "la misma fila");
  assert.equal(rows().length, 1, "un recibo, una fila");

  // ---------------- Solicitudes concurrentes con el mismo recibo ----------------
  const concurrentBody = reply("Define el primer criterio de Pareto.");
  const results = await Promise.all(Array.from({ length: 5 }, () => post(concurrentBody)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => messageOf(r).id)).size, 1, "todas apuntan a la misma fila");
  assert.equal(results.filter((r) => duplicateOf(r) === false).length, 1, "solo una inserción gana");
  assert.equal(rows().filter((m) => m.content === "Define el primer criterio de Pareto.").length, 1);

  // ---------------- La IA repite el mismo texto: otro recibo, otra fila ----------------
  const repeated = "¿Seguimos?";
  assert.equal((await post(reply(repeated))).status, 200);
  assert.equal((await post(reply(repeated))).status, 200);
  assert.equal(rows().filter((m) => m.content === repeated).length, 2, "no se deduplica por texto");

  // ---------------- Replay en otro chat ----------------
  const before = state.messages.length;
  const replay = await post({ ...body, chatId: OTHER_CHAT });
  assert.equal(replay.status, 403);
  assert.equal(replay.json.code, "ASSISTANT_RECEIPT_INVALID");
  assert.match(String(replay.json.message), /CHAT_MISMATCH/);
  assert.equal(state.messages.length, before);

  // ---------------- Reintentos de user y advisor ----------------
  const clientMessageId = crypto.randomUUID();
  const userBody = { chatId: CHAT, role: "user", content: "Terminé la capacitación", clientMessageId };
  const u1 = await post(userBody);
  const u2 = await post(userBody);
  assert.equal(u1.status, 200);
  assert.equal(u2.status, 200);
  assert.equal(duplicateOf(u2), true);
  assert.equal(messageOf(u2).id, messageOf(u1).id);
  assert.equal(rows().filter((m) => m.client_message_id === clientMessageId).length, 1);

  const advisorId = crypto.randomUUID();
  const advisorBody = { chatId: CHAT, role: "advisor", content: "✅ Ya tenemos suficientes causas.", clientMessageId: advisorId };
  const concurrentAdvisor = await Promise.all([post(advisorBody), post(advisorBody), post(advisorBody)]);
  assert.ok(concurrentAdvisor.every((r) => r.status === 200));
  assert.equal(rows().filter((m) => m.client_message_id === advisorId).length, 1, "reintentos concurrentes, una fila");

  // Misma clave con otro texto u otro role: no es un reintento.
  const n = state.messages.length;
  const conflict = await post({ ...userBody, content: "Otro texto distinto" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.json, { ok: false, code: "CONFLICT", message: "La clave de este mensaje ya se usó para otro mensaje." });
  const roleConflict = await post({ ...userBody, role: "advisor" });
  assert.equal(roleConflict.status, 409);
  assert.equal(state.messages.length, n);

  // La clave es por chat.
  assert.equal((await post({ ...userBody, chatId: OTHER_CHAT })).status, 200);
  assert.equal(rows(OTHER_CHAT).filter((m) => m.client_message_id === clientMessageId).length, 1);

  // Sin clave (navegadores anteriores): se guarda como siempre, sin deduplicar.
  assert.equal((await post({ chatId: CHAT, role: "user", content: "Hola" })).status, 200);
  assert.equal((await post({ chatId: CHAT, role: "user", content: "Hola" })).status, 200);
  assert.equal(rows().filter((m) => m.content === "Hola").length, 2);

  stub.restore();
}

main()
  .then(() => console.log("messagesRouteIdempotency tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
