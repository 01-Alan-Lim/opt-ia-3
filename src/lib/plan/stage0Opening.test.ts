import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import { chatHasMessages, persistMessageDB } from "../../app/chat/_lib/advisorApi";
import {
  createStage0PromptTracker,
  openStage0,
  type Stage0OpeningDeps,
  type Stage0PromptTracker,
} from "../../app/chat/_lib/stage0Opening";
import { handleStage0Turn, type Stage0TurnDeps } from "../../app/chat/_lib/turns/stage0Turn";
import type { PlanContextStatus } from "../../app/chat/_lib/turns/types";
import { approvedProfile, prepareRouteTestEnv } from "./assistantRouteHarness";
import { installMessageStub, type MessageStubState } from "./messageRouteHarness";
import { buildStage0Opening, buildStage0ReviewOpening, readStage0Context, stage0Reminder, stage0ReviewKey } from "./stage0Context";

// Apertura de la Etapa 0 (src/app/chat/_lib/stage0Opening.ts): un solo emisor de la primera
// pregunta. La apertura se guarda con POST /api/messages y el historial se consulta con
// GET /api/messages: las rutas reales sobre una tabla en memoria (messageRouteHarness, sin red ni
// Supabase real). Cubre el inicio normal, la pregunta mostrada una sola vez, el estudiante que
// escribe antes de que llegue la apertura y la recarga de la conversación.

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "33333333-3333-4333-8333-333333333333";
const FAST_CHAT = "44444444-4444-4444-8444-444444444444";
const AUTH = { Authorization: "Bearer token-de-prueba" };

const state: MessageStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, "88888888-8888-4888-8888-888888888888"),
  cohortActive: true,
  chats: {
    [CHAT]: { client_id: USER, mode: "plan_mejora" },
    [FAST_CHAT]: { client_id: USER, mode: "plan_mejora" },
  },
  messages: [],
  schema: "m2",
  contexts: {},
};

const rowsOf = (chatId: string) => state.messages.filter((m) => m.chat_id === chatId);

// Lo que la página hace con la apertura: la muestra como única conversación y la guarda.
function pageDeps(tracker: Stage0PromptTracker, sends: { count: number }, shown: string[]): Stage0OpeningDeps {
  return {
    tracker,
    hasHistory: (chatId) => chatHasMessages(AUTH, chatId),
    studentSendCount: () => sends.count,
    isCurrent: () => true,
    show: async (chatId, text) => {
      shown.push(text);
      const saved = await persistMessageDB(AUTH, { chatId, role: "advisor", content: text, clientMessageId: crypto.randomUUID() });
      assert.equal(saved.ok, true, JSON.stringify(saved));
    },
  };
}

// El turno de E0 con lo mínimo: ninguna de estas conversaciones guarda datos ni llama a Gemini. La
// lectura fresca del contexto devuelve el borrador vacío.
function turnDeps(tracker: Stage0PromptTracker, chatId: string, replies: string[]): Stage0TurnDeps {
  const fail = async (): Promise<never> => {
    throw new Error("este turno no debe guardar, confirmar ni llamar a Gemini");
  };
  return {
    chatId: () => chatId,
    greetingName: "Ana",
    editingField: null,
    setEditingField: () => undefined,
    setStage0Draft: () => undefined,
    setAwaitingStage1Start: () => undefined,
    tracker,
    appendAssistant: async (text) => {
      replies.push(text);
    },
    interpret: fail,
    saveDraft: fail,
    confirm: fail,
    refreshContext: async () => draftCtx(chatId),
    cacheContext: () => undefined,
  };
}

const draftCtx = (chatId: string): PlanContextStatus => ({
  ok: true,
  status: "draft",
  exists: true,
  chatId,
  contextJson: {},
  contextText: null,
});

async function main() {
  prepareRouteTestEnv();
  const stub = installMessageStub(state);
  const route = await import("../../app/api/messages/route");
  // El navegador llama a /api/messages con una URL relativa: aquí va a la ruta real.
  const supabaseFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/messages" && init?.method === "POST") {
      return route.POST(new NextRequest("https://opt-ia.test/api/messages", { method: "POST", headers: init.headers, body: String(init.body ?? "") }));
    }
    if (url.startsWith("/api/messages?")) {
      return route.GET(new NextRequest(`https://opt-ia.test${url}`, { headers: init?.headers }));
    }
    return supabaseFetch(input, init);
  };

  const opening = buildStage0Opening(1, {}, "Ana");

  // ---------------- 1 y 3. Inicio normal: la apertura sale una vez y queda guardada ----------------
  const tracker = createStage0PromptTracker();
  const sends = { count: 0 };
  const shown: string[] = [];
  const input = {
    chatId: CHAT,
    contextStatus: "draft" as const,
    contextJson: {},
    greetingName: "Ana",
    knownEmpty: false,
    studentSendsAtStart: 0,
  };

  assert.equal(await openStage0(pageDeps(tracker, sends, shown), input), "opened");
  assert.deepEqual(shown, [opening]);
  assert.deepEqual(rowsOf(CHAT).map((m) => [m.role, m.content]), [["advisor", opening]]);

  // El effect vuelve a correr (cambio de modo, otro render): no la repite.
  assert.equal(await openStage0(pageDeps(tracker, sends, shown), input), "already_prompted");
  assert.equal(shown.length, 1);
  assert.equal(rowsOf(CHAT).length, 1);

  // El estudiante pide empezar con la apertura a la vista: recordatorio, no otra pregunta.
  const replies: string[] = [];
  await handleStage0Turn(turnDeps(tracker, CHAT, replies), {
    text: "Quiero comenzar mi Plan de Mejora para mis prácticas empresariales. ¿Cómo empezamos?",
    ctx: draftCtx(CHAT),
  });
  assert.deepEqual(replies, [`¡Ya estamos en marcha! ${stage0Reminder(1)}`]);

  // ---------------- 5. Recarga: el historial ya tiene la apertura ----------------
  const reloaded = createStage0PromptTracker();
  const shownAfterReload: string[] = [];
  assert.equal(await openStage0(pageDeps(reloaded, { count: 0 }, shownAfterReload), input), "has_history");
  assert.deepEqual(shownAfterReload, []);
  assert.equal(rowsOf(CHAT).length, 1, "recargar no agrega otra apertura");
  const historyRes = await route.GET(new NextRequest(`https://opt-ia.test/api/messages?chatId=${CHAT}`, { headers: AUTH }));
  const history = ((await historyRes.json()) as { data: { messages: Array<{ role: string; content: string }> } }).data.messages;
  assert.deepEqual(history.map((m) => [m.role, m.content]), [["advisor", opening]], "la apertura vuelve con el historial");
  // Tras recargar, pedir empezar tampoco trae la bienvenida otra vez.
  const repliesAfterReload: string[] = [];
  await handleStage0Turn(turnDeps(reloaded, CHAT, repliesAfterReload), { text: "¿Cómo empezamos?", ctx: draftCtx(CHAT) });
  assert.deepEqual(repliesAfterReload, [`¡Ya estamos en marcha! ${stage0Reminder(1)}`]);

  // ---------------- 4. Responde antes de que termine la apertura ----------------
  {
    const fastTracker = createStage0PromptTracker();
    const fastSends = { count: 0 };
    const fastShown: string[] = [];
    const deps = pageDeps(fastTracker, fastSends, fastShown);
    // Mientras se consulta el historial, el estudiante envía su mensaje (handleSend suma el envío).
    const slow: Stage0OpeningDeps = {
      ...deps,
      hasHistory: async (chatId) => {
        fastSends.count += 1;
        return deps.hasHistory(chatId);
      },
    };
    const result = await openStage0(slow, { ...input, chatId: FAST_CHAT, studentSendsAtStart: 0 });
    assert.equal(result, "student_first");
    assert.deepEqual(fastShown, []);
    assert.equal(rowsOf(FAST_CHAT).length, 0, "la apertura no sale después del mensaje del estudiante");

    // Su turno responde con la apertura completa (no vio ninguna pregunta), una sola vez.
    const fastReplies: string[] = [];
    await handleStage0Turn(turnDeps(fastTracker, FAST_CHAT, fastReplies), { text: "Quiero comenzar, ¿cómo empezamos?", ctx: draftCtx(FAST_CHAT) });
    assert.deepEqual(fastReplies, [opening]);
    // Si el effect vuelve a correr después, ya no la muestra.
    assert.equal(await openStage0(deps, { ...input, chatId: FAST_CHAT, studentSendsAtStart: fastSends.count }), "already_prompted");
    assert.deepEqual(fastShown, []);
  }

  // ---------------- Casos del effect ----------------
  {
    // Chat recién creado: no consulta el historial.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const noHistory: Stage0OpeningDeps = {
      ...pageDeps(t, { count: 0 }, out),
      hasHistory: async () => {
        throw new Error("un chat recién creado no consulta el historial");
      },
      show: async (_chatId, text) => {
        out.push(text);
      },
    };
    assert.equal(await openStage0(noHistory, { ...input, chatId: "nuevo", knownEmpty: true }), "opened");
    assert.deepEqual(out, [opening]);
  }
  {
    // Historial desconocido (falla GET): no se arriesga a duplicar; el turno del estudiante responde.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const unknown: Stage0OpeningDeps = { ...pageDeps(t, { count: 0 }, out), hasHistory: async () => null };
    assert.equal(await openStage0(unknown, input), "history_unknown");
    assert.deepEqual(out, []);
    assert.equal(t.wasPrompted(CHAT), false);
  }
  {
    // Cambió el chat o el modo mientras esperaba: no se muestra en otro chat.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const moved: Stage0OpeningDeps = { ...pageDeps(t, { count: 0 }, out), hasHistory: async () => false, isCurrent: () => false };
    assert.equal(await openStage0(moved, input), "not_current");
    assert.deepEqual(out, []);
  }
  {
    // E0 confirmado (el plan es uno por estudiante): un chat nuevo no vuelve a abrir E0, ni
    // consulta el historial.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const confirmed: Stage0OpeningDeps = {
      ...pageDeps(t, { count: 0 }, out),
      hasHistory: async () => {
        throw new Error("con E0 confirmado no se consulta");
      },
    };
    const result = await openStage0(confirmed, {
      ...input,
      chatId: "nuevo-confirmado",
      contextStatus: "confirmed",
      contextJson: { sector: "Alimentos", products: ["Yogur"], process_focus: ["Producción"] },
      knownEmpty: true,
    });
    assert.equal(result, "context_confirmed");
    assert.deepEqual(out, []);
  }
  {
    // Retomar a mitad de E0 en un chat sin historial: la apertura reconoce lo registrado.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const resume: Stage0OpeningDeps = {
      ...pageDeps(t, { count: 0 }, out),
      hasHistory: async () => false,
      show: async (_chatId, text) => {
        out.push(text);
      },
    };
    await openStage0(resume, { ...input, chatId: "otro", contextJson: { sector: "Alimentos" } });
    assert.deepEqual(out, [buildStage0Opening(2, { sector: "Alimentos" }, "Ana")]);
  }
  {
    // Los tres datos en borrador y un chat sin historial: la apertura es el resumen para revisar,
    // no la primera pregunta (antes volvía a preguntar el rubro). El turno sabe qué resumen vio.
    const t = createStage0PromptTracker();
    const out: string[] = [];
    const review: Stage0OpeningDeps = {
      ...pageDeps(t, { count: 0 }, out),
      hasHistory: async () => false,
      show: async (_chatId, text) => {
        out.push(text);
      },
    };
    const complete = { sector: "Alimentos", products: ["Yogur"], process_focus: ["Producción"] };
    assert.equal(await openStage0(review, { ...input, chatId: "revision", contextJson: complete }), "opened");
    assert.deepEqual(out, [buildStage0ReviewOpening(readStage0Context(complete), "Ana")]);
    assert.equal(t.reviewShown("revision"), stage0ReviewKey(complete));
    assert.equal(t.reviewShown("otro-chat"), null);
  }

  globalThis.fetch = supabaseFetch;
  stub.restore();
  console.log("stage0Opening tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
