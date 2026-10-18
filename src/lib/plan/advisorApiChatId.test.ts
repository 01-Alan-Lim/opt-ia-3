import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  callBrainstormAssistant,
  callFodaAssistant,
  callProductivityAssistant,
} from "../../app/chat/_lib/advisorApi";

// Cliente HTTP del asesor para E1–E3: envía el chat activo como chatId y nada que identifique
// al usuario (la identidad sale del Bearer en el servidor). La lectura de la respuesta no
// cambia: un assistantReceipt en la respuesta pasa tal cual y no altera el payload. Sin red:
// fetch se reemplaza en este proceso.

const CHAT = "33333333-3333-4333-8333-333333333333";
const AUTH = { Authorization: "Bearer token-de-prueba" };

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const captured: Captured[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  captured.push({ url: String(input), headers, body });
  return new Response(JSON.stringify(nextResponse.body), {
    status: nextResponse.status,
    headers: { "content-type": "application/json" },
  });
};

function lastCall(): Captured {
  const call = captured.at(-1);
  assert.ok(call, "se esperaba una llamada");
  return call;
}

async function main() {
  const okBody = {
    ok: true,
    data: { assistantMessage: "Respuesta del servidor", updates: { action: "x" }, assistantReceipt: "ar1.payload.firma" },
  };

  const calls = [
    {
      name: "productivity",
      url: "/api/plans/productivity/assistant",
      run: (chatId: string | null) =>
        callProductivityAssistant(AUTH, { studentMessage: "__START__", prodStep: 1, prodDraft: {}, caseContext: null }, chatId, "historial"),
      expected: { studentMessage: "__START__", prodStep: 1, prodDraft: {}, caseContext: {}, recentHistory: "historial" },
    },
    {
      name: "foda",
      url: "/api/plans/foda/assistant",
      run: (chatId: string | null) =>
        callFodaAssistant(
          AUTH,
          {
            studentMessage: "continuemos",
            fodaState: { currentQuadrant: "F", items: { F: [], D: [], O: [], A: [] }, pendingEvidence: null },
            caseContext: { rubro: "panadería" },
          },
          chatId,
          "historial",
        ),
      expected: {
        studentMessage: "continuemos",
        fodaState: { currentQuadrant: "F", items: { F: [], D: [], O: [], A: [] }, pendingEvidence: null },
        caseContext: { rubro: "panadería" },
        recentHistory: "historial",
      },
    },
    {
      name: "brainstorm",
      url: "/api/plans/brainstorm/assistant",
      run: (chatId: string | null) =>
        callBrainstormAssistant(
          AUTH,
          {
            studentMessage: "Elijo FO",
            brainstormState: { step: "choose_strategy", strategy: null, problem: null, ideas: [], minIdeas: 10 },
            caseContext: null,
            stage1Summary: null,
            fodaSummary: null,
          },
          chatId,
          "historial",
        ),
      expected: {
        studentMessage: "Elijo FO",
        brainstormState: { step: "choose_strategy", strategy: null, problem: null, ideas: [], minIdeas: 10 },
        caseContext: {},
        stage1Summary: null,
        fodaSummary: null,
        recentHistory: "historial",
      },
    },
  ];

  for (const c of calls) {
    // Con chat activo: lo envía como chatId, junto al resto del cuerpo de siempre.
    nextResponse = { status: 200, body: okBody };
    const result = await c.run(CHAT);
    const sent = lastCall();
    assert.equal(sent.url, c.url, `${c.name}: misma URL`);
    assert.equal(sent.headers.authorization, AUTH.Authorization, `${c.name}: mismo Bearer`);
    assert.deepEqual(sent.body, { chatId: CHAT, ...c.expected }, `${c.name}: cuerpo con chatId`);
    for (const forbidden of ["userId", "user_id", "client_id"]) {
      assert.ok(!(forbidden in sent.body), `${c.name}: no envía ${forbidden}`);
    }
    // La respuesta se lee igual que antes; el recibo, si viene, pasa sin tocarse.
    assert.equal(result.ok, true);
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.assistantMessage, "Respuesta del servidor");
    assert.equal(payload.assistantReceipt, "ar1.payload.firma");

    // Sin chat activo: chatId null explícito, nunca un valor inventado.
    await c.run(null);
    assert.deepEqual(lastCall().body, { chatId: null, ...c.expected }, `${c.name}: sin chat activo`);

    // Error del servidor: ok false, como siempre.
    nextResponse = { status: 403, body: { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." } };
    const failed = await c.run(CHAT);
    assert.equal(failed.ok, false, `${c.name}: error del servidor`);
  }

  // page.tsx pasa el chat activo (chatIdRef) a las tres llamadas, igual que en las demás etapas.
  const page = readFileSync(path.join("src", "app", "chat", "page.tsx"), "utf8");
  for (const fn of ["callProductivityAssistant", "callFodaAssistant", "callBrainstormAssistant"]) {
    assert.ok(
      page.includes(`advisorApi.${fn}(authHeaders, input, chatIdRef.current ?? null, buildRecentHistoryForAssistant(10))`),
      `page.tsx: ${fn} recibe el chat activo`,
    );
  }
}

main()
  .then(() => console.log("advisorApiChatId tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
