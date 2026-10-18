import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { persistMessageDB } from "../../app/chat/_lib/advisorApi";
import { appendAssistantMessage, type AppendAssistantDeps } from "../../app/chat/_lib/appendAssistantMessage";
import { signAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import { historySpeaker } from "../chat/messageProvenance";
import { readSignedAssistantReply } from "../chat/signedAssistantReply";
import type { Message } from "../types";
import { approvedProfile, prepareRouteTestEnv } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";
import { lastAssistantIsStage0Prompt } from "./stage0Context";

// De punta a punta (R1): appendAssistant del navegador -> persistMessageDB -> POST /api/messages
// real -> tabla messages en memoria, y la recarga con GET /api/messages. Sin red, sin Supabase
// real, sin Gemini. Comprueba que:
//   - la respuesta firmada queda como assistant con exactamente el texto que se ve;
//   - los textos locales (E0, transiciones) quedan como advisor y se ven igual;
//   - un reintento del mismo mensaje no lo duplica;
//   - tras recargar, el historial vuelve en orden con su procedencia y E0 sigue reconociendo su
//     última pregunta.

const SECRET = Buffer.from("opt-ia: secreto de recibos de punta a punta, solo pruebas").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";
const AUTH = { Authorization: "Bearer token-de-prueba" };

const state: MessageStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, "88888888-8888-4888-8888-888888888888"),
  cohortActive: true,
  chats: { [CHAT]: { client_id: USER, mode: "plan_mejora" } },
  messages: [],
  schema: "m2",
  contexts: {},
};

async function main() {
  prepareRouteTestEnv({ ASSISTANT_RECEIPT_SECRET: SECRET });
  const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
  assert.ok(keyStatus.ok);
  const key = keyStatus.key;

  const stub = installMessageStub(state);
  const route = await import("../../app/api/messages/route");
  // El navegador llama a /api/messages con una URL relativa: aquí va a la ruta real.
  const supabaseFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/messages") {
      return route.POST(
        new NextRequest("https://opt-ia.test/api/messages", { method: init?.method, headers: init?.headers, body: String(init?.body ?? "") }),
      );
    }
    return supabaseFetch(input, init);
  };

  const shown: Message[] = [];
  const results: unknown[] = [];
  const deps: AppendAssistantDeps = {
    modeRef: { current: "plan_mejora" },
    chatIdRef: { current: CHAT },
    setMessages: (update) => {
      shown.splice(0, shown.length, ...update([...shown]));
    },
    persistMessageDB: async (input) => {
      const r = await persistMessageDB(AUTH, input);
      results.push(r);
      return r;
    },
  };
  const serverReply = (content: string) =>
    readSignedAssistantReply(true, { assistantMessage: content, assistantReceipt: signAssistantReceipt(key, { userId: USER, chatId: CHAT, content }) }, CHAT);

  // E0 (textos locales), E1 (respuesta de la ruta), transición local.
  const e0Prompt = "**1/3** ¿Cuál es el sector o rubro de la empresa?";
  await appendAssistantMessage(deps, e0Prompt);
  await persistMessageDB(AUTH, { chatId: CHAT, role: "user", content: "Panadería artesanal" });
  const reply = "Entendido, Ana: 1. Unidad monetaria 2. Periodo mensual. ¿Cuáles fueron tus ingresos?";
  await appendAssistantMessage(deps, reply, serverReply(reply));
  await appendAssistantMessage(deps, "✅ Ya tenemos suficientes causas.\n¿Pasamos a Ishikawa?");

  assert.ok(results.every((r) => (r as { ok: boolean }).ok === true), JSON.stringify(results));
  assert.deepEqual(state.messages.map((m) => m.role), ["advisor", "user", "assistant", "advisor"]);
  // Lo guardado es exactamente lo que se ve.
  const advisorSide = state.messages.filter((m) => m.role !== "user");
  assert.deepEqual(advisorSide.map((m) => m.content), shown.map((m) => m.content));
  assert.deepEqual(shown.map((m) => m.role), ["advisor", "assistant", "advisor"]);
  const assistantRow = state.messages[2];
  assert.ok(assistantRow.receipt_nonce, "verificado con recibo");
  assert.equal(state.messages[0].client_message_id, shown[0].id, "clave de idempotencia = id del mensaje");

  // Reintento del mismo texto local (misma clave) y del mismo recibo: sin duplicados.
  const n = state.messages.length;
  await persistMessageDB(AUTH, { chatId: CHAT, role: "advisor", content: shown[0].content, clientMessageId: shown[0].id });
  const sameReply = serverReply(reply);
  assert.ok(sameReply);
  const once = await persistMessageDB(AUTH, { chatId: CHAT, role: "assistant", serverReply: sameReply });
  const twice = await persistMessageDB(AUTH, { chatId: CHAT, role: "assistant", serverReply: sameReply });
  assert.equal(state.messages.length, n + 1, "solo el recibo nuevo agrega una fila");
  assert.deepEqual((twice.data as { duplicate: boolean }).duplicate, true);
  assert.deepEqual((once.data as { message: unknown }).message, (twice.data as { message: unknown }).message);

  // Recarga: GET devuelve el historial en orden con su procedencia.
  const res = await route.GET(new NextRequest(`https://opt-ia.test/api/messages?chatId=${CHAT}`, { headers: AUTH }));
  const reloaded = ((await res.json()) as { data: { messages: Message[] } }).data.messages;
  assert.deepEqual(reloaded.slice(0, 4).map((m) => m.role), ["advisor", "user", "assistant", "advisor"]);
  assert.deepEqual(reloaded.slice(0, 4).map((m) => m.content), state.messages.slice(0, 4).map((m) => m.content));
  assert.deepEqual(reloaded.slice(0, 4).map((m) => historySpeaker(m.role)), ["PLATFORM_GUIDE", "STUDENT", "ASSISTANT", "PLATFORM_GUIDE"]);
  // E0 tras recargar: su pregunta (advisor) sigue siendo "la última del asesor".
  assert.equal(lastAssistantIsStage0Prompt(reloaded.slice(0, 2)), true);

  globalThis.fetch = supabaseFetch;
  stub.restore();
}

main()
  .then(() => console.log("advisorPersistEndToEnd tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
