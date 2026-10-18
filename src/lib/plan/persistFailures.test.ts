import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import { persistMessageDB, type PersistMessageInput, type PersistMessageResult } from "../../app/chat/_lib/advisorApi";
import {
  blocksChat,
  classifyPersistFailure,
  describePersistFailures,
  dismissRejected,
  queueBehind,
  recordFailure,
  retryPending,
  withClientMessageId,
  type PersistFailure,
} from "../../app/chat/_lib/persistFailures";
import { signAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import { approvedProfile, prepareRouteTestEnv } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";

// Guardado fallido (R1-E): nunca se pierde en silencio, se distingue el error temporal del de
// sesión y del rechazo, la cola respeta el orden por chat y el reintento (manual) no duplica
// mensajes. Sin red: la ruta real /api/messages contra Supabase simulado en memoria.

const SECRET = Buffer.from("opt-ia: secreto de recibos para reintentos, solo pruebas").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const CHAT_A = "33333333-3333-4333-8333-333333333333";
const CHAT_B = "44444444-4444-4444-8444-444444444444";
const AUTH = { Authorization: "Bearer token-de-prueba" };

let seq = 0;
const newId = () => `id-${++seq}`;
const failed = (status: number, code: string | null = null): Extract<PersistMessageResult, { ok: false }> => ({
  ok: false,
  status,
  code,
  message: null,
  data: null,
});
const okResult: PersistMessageResult = { ok: true, status: 200, duplicate: false, data: null };
const msg = (chatId: string, content: string): PersistMessageInput => ({ chatId, role: "advisor", content, clientMessageId: content });

const state: MessageStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, "88888888-8888-4888-8888-888888888888"),
  cohortActive: true,
  chats: { [CHAT_A]: { client_id: USER, mode: "plan_mejora" }, [CHAT_B]: { client_id: USER, mode: "plan_mejora" } },
  messages: [],
  schema: "m2",
  contexts: {},
};

async function main() {
  // ---------------- Clasificación ----------------
  for (const status of [0, 408, 425, 429, 500, 502, 503]) assert.equal(classifyPersistFailure(status), "temporary", String(status));
  assert.equal(classifyPersistFailure(401), "session");
  for (const status of [400, 403, 404, 409, 413]) assert.equal(classifyPersistFailure(status), "rejected", String(status));

  // ---------------- Clave de idempotencia fija ----------------
  const user = withClientMessageId({ chatId: CHAT_A, role: "user", content: "Hola" }, () => "k-1");
  assert.deepEqual(user, { chatId: CHAT_A, role: "user", content: "Hola", clientMessageId: "k-1" });
  assert.equal(withClientMessageId(user, () => "k-2"), user, "no cambia una clave ya puesta");
  const assistant: PersistMessageInput = { chatId: CHAT_A, role: "assistant", serverReply: { assistantMessage: "x", assistantReceipt: "r" } };
  assert.equal(withClientMessageId(assistant, () => "k-3"), assistant, "assistant se deduplica por recibo");

  // ---------------- Cola por chat y reintento en orden ----------------
  let list: PersistFailure[] = [];
  list = recordFailure(list, msg(CHAT_A, "A1"), failed(0, "NETWORK"), newId);
  assert.ok(blocksChat(list, CHAT_A));
  assert.ok(!blocksChat(list, CHAT_B), "otro chat no espera");
  list = queueBehind(list, msg(CHAT_A, "A2"), newId);
  list = recordFailure(list, msg(CHAT_B, "B1"), failed(503, "SCHEMA_NOT_READY"), newId);
  list = queueBehind(list, msg(CHAT_A, "A3"), newId);
  list = recordFailure(list, msg(CHAT_A, "R1"), failed(403, "ASSISTANT_RECEIPT_INVALID"), newId);
  assert.deepEqual(list.map((f) => f.kind), ["temporary", "queued", "temporary", "queued", "rejected"]);

  const sentOrder: string[] = [];
  const remaining = await retryPending(list, async (input) => {
    const content = input.role === "assistant" ? "" : input.content;
    sentOrder.push(content);
    return content === "A2" ? failed(502) : okResult;
  });
  assert.deepEqual(sentOrder, ["A1", "A2", "B1"], "en orden; A3 espera detrás de A2; el rechazado no se reintenta");
  assert.deepEqual(remaining.map((f) => [f.input.chatId === CHAT_A ? "A" : "B", f.kind]), [
    ["A", "temporary"],
    ["A", "queued"],
    ["A", "rejected"],
  ]);
  assert.deepEqual(dismissRejected(remaining).map((f) => f.kind), ["temporary", "queued"]);

  // ---------------- Aviso ----------------
  assert.equal(describePersistFailures([]), null);
  const one = describePersistFailures(recordFailure([], msg(CHAT_A, "x"), failed(0), newId));
  assert.deepEqual(one, {
    pendingText: "1 mensaje no se guardó todavía en el historial. Sigue visible aquí, pero si recargas antes de guardarlos no aparecerán.",
    rejectedText: null,
    canRetry: true,
    canDismiss: false,
  });
  const session = describePersistFailures(recordFailure(recordFailure([], msg(CHAT_A, "x"), failed(401), newId), msg(CHAT_A, "y"), failed(0), newId));
  assert.ok(session?.pendingText?.startsWith("Tu sesión expiró. 2 mensajes no se guardaron"));
  const rejectedOnly = describePersistFailures(recordFailure([], msg(CHAT_A, "x"), failed(403), newId));
  assert.deepEqual(rejectedOnly, {
    pendingText: null,
    rejectedText: "1 mensaje no se pudo guardar en el historial: el servidor los rechazó.",
    canRetry: false,
    canDismiss: true,
  });

  // ---------------- De punta a punta: respuesta perdida y reintento sin duplicar ----------------
  prepareRouteTestEnv({ ASSISTANT_RECEIPT_SECRET: SECRET });
  const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
  assert.ok(keyStatus.ok);
  const stub = installMessageStub(state);
  const route = await import("../../app/api/messages/route");
  const supabaseFetch = globalThis.fetch;
  let loseResponses = false;
  let networkDown = false;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/messages") return supabaseFetch(input, init);
    if (networkDown) throw new TypeError("Failed to fetch");
    const res = await route.POST(
      new NextRequest("https://opt-ia.test/api/messages", { method: init?.method, headers: init?.headers, body: String(init?.body ?? "") }),
    );
    // El servidor guardó, pero la respuesta no llega al navegador.
    if (loseResponses) throw new TypeError("Failed to fetch");
    return res;
  };
  const send = (input: PersistMessageInput) => persistMessageDB(AUTH, input);

  // Red caída: no lanza, vuelve como fallo temporal y no se guarda nada.
  networkDown = true;
  const down = await send(withClientMessageId({ chatId: CHAT_A, role: "user", content: "Hola" }, () => crypto.randomUUID()));
  assert.deepEqual(down, { ok: false, status: 0, code: "NETWORK", message: null, data: null });
  assert.equal(state.messages.length, 0);
  networkDown = false;

  // Se guardó pero la respuesta se perdió: el reintento recibe la misma fila (duplicate).
  loseResponses = true;
  const advisorInput = withClientMessageId({ chatId: CHAT_A, role: "advisor", content: "✅ Ya tenemos suficientes causas." }, () => crypto.randomUUID());
  const content = "¿Qué porcentaje del cronograma llevas?";
  const assistantInput: PersistMessageInput = {
    chatId: CHAT_A,
    role: "assistant",
    serverReply: { assistantMessage: content, assistantReceipt: signAssistantReceipt(keyStatus.key, { userId: USER, chatId: CHAT_A, content }) },
  };
  let pending: PersistFailure[] = [];
  for (const input of [advisorInput, assistantInput]) {
    const r = await send(input);
    assert.ok(!r.ok && r.status === 0);
    pending = recordFailure(pending, input, r as Extract<PersistMessageResult, { ok: false }>, newId);
  }
  assert.equal(state.messages.length, 2, "el servidor sí guardó");
  loseResponses = false;

  const results: PersistMessageResult[] = [];
  const left = await retryPending(pending, async (input) => {
    const r = await send(input);
    results.push(r);
    return r;
  });
  assert.equal(left.length, 0, "todo quedó guardado");
  assert.ok(results.every((r) => r.ok && r.duplicate), "el reintento no crea otro mensaje");
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.messages.map((m) => m.role), ["advisor", "assistant"]);

  // Rechazo (recibo de otro chat): se informa como rechazado y no se reintenta.
  const foreign: PersistMessageInput = { chatId: CHAT_B, role: "assistant", serverReply: assistantInput.serverReply };
  const rejected = await send(foreign);
  assert.ok(!rejected.ok && rejected.status === 403 && rejected.code === "ASSISTANT_RECEIPT_INVALID");
  assert.equal(classifyPersistFailure(rejected.status), "rejected");

  globalThis.fetch = supabaseFetch;
  stub.restore();

  // ---------------- Código: un único punto de guardado, sin reintentos automáticos ----------------
  const page = readFileSync(path.join("src", "app", "chat", "page.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(page.includes("const request = withClientMessageId(input, () => crypto.randomUUID());"));
  assert.ok(page.includes('role: "user", content: text, clientMessageId: userMessage.id'));
  assert.equal(page.match(/persistFailures\.retry\(/g)?.length, 1, "solo el botón Reintentar reintenta");
  assert.ok(page.includes("onRetry={() => void persistFailures.retry(sendMessageToHistory)}"));
  assert.equal(page.match(/advisorApi\.persistMessageDB\(/g)?.length, 1, "un solo punto de envío");
  assert.ok(page.indexOf("<PersistFailureNotice") < page.indexOf("<MessageInput"), "el aviso va sobre el campo de texto");
}

main()
  .then(() => console.log("persistFailures tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
