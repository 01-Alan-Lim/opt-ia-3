import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { callParetoAssistant, persistMessageDB, type PersistMessageInput } from "../../app/chat/_lib/advisorApi";
import type { IshikawaState } from "../../app/chat/_lib/advisorTransitions";
import { appendAssistantMessage, type AppendAssistantDeps } from "../../app/chat/_lib/appendAssistantMessage";
import { handleFodaTurn } from "../../app/chat/_lib/turns/fodaTurn";
import { handleIshikawaTurn } from "../../app/chat/_lib/turns/ishikawaTurn";
import { handleParetoTurn } from "../../app/chat/_lib/turns/paretoTurn";
import { handleProgressTurn } from "../../app/chat/_lib/turns/progressTurn";
import type { AdvisorTurnDeps, PlanContextStatus } from "../../app/chat/_lib/turns/types";
import { formatAssistantMessageForReadability, softenAssistantLeadInChat } from "../chat/assistantFormat";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import { decideMessageWrite, parsePersistMessageBody } from "../chat/messageWritePolicy";
import { readSignedAssistantReply, type SignedAssistantReply } from "../chat/signedAssistantReply";
import type { Message } from "../types";
import type { FodaState, ParetoState, ProgressState } from "./advisorStates";

// Guardado de las respuestas del asesor con su recibo (R1). Comprueba que:
//   - el recibo llega intacto desde la respuesta de la ruta hasta el cuerpo de POST /api/messages,
//     junto al texto original, mientras content sigue siendo el texto formateado de siempre;
//   - solo lo lleva el mensaje que vino de esa respuesta, en el chat de la petición: los
//     mensajes locales, los textos distintos y los guardados en otro chat van sin recibo;
//   - cada mensaje se guarda una sola vez y los turnos mantienen su orden de siempre;
//   - /api/messages exige el recibo para assistant (las pruebas de la ruta están en
//     messagesRoute.test.ts).
// Sin red ni Supabase ni Gemini: fetch se reemplaza en este proceso.

const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";
const AUTH = { Authorization: "Bearer token-de-prueba" };
const RECEIPT = "ar1.eyJ2IjoxLCJjIjoiMzMzMyJ9.firma-de-prueba_-";
const TEST_KEY = loadAssistantReceiptKey({
  ASSISTANT_RECEIPT_SECRET: Buffer.from("opt-ia: clave de prueba del transporte de recibos").toString("base64"),
});

type Json = Record<string, unknown>;
type Call = [name: string, args: unknown[]];

// ---------------- fetch simulado ----------------
const sent: Array<{ url: string; body: Json }> = [];
let routeReply: Json = {};
let onRouteCall: () => void = () => undefined;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? "{}")) as Json;
  sent.push({ url, body });
  if (url === "/api/messages") {
    return Response.json({ ok: true, data: { message: { id: "m1", role: body.role, content: body.content } } });
  }
  if (url.startsWith("/api/plans/") && url.endsWith("/assistant")) {
    onRouteCall();
    return Response.json(routeReply);
  }
  throw new Error("destino no esperado en la prueba: " + url);
};

const messageBodies = () => sent.filter((s) => s.url === "/api/messages").map((s) => s.body);

// ---------------- appendAssistant con dependencias de prueba ----------------
function appendHarness(mode: "general" | "plan_mejora", chatId: string | null) {
  const shown: Message[] = [];
  const persisted: PersistMessageInput[] = [];
  const deps: AppendAssistantDeps = {
    modeRef: { current: mode },
    chatIdRef: { current: chatId },
    setMessages: (update) => {
      const next = update([...shown]);
      shown.splice(0, shown.length, ...next);
    },
    persistMessageDB: async (input) => {
      persisted.push(input);
      return { ok: true };
    },
  };
  return { deps, shown, persisted };
}

const formatted = (raw: string) => formatAssistantMessageForReadability(softenAssistantLeadInChat(raw));
const signed = (assistantMessage: string, assistantReceipt = RECEIPT, chatId = CHAT) =>
  readSignedAssistantReply(true, { assistantMessage, assistantReceipt }, chatId);

// ---------------- turnos con dependencias de prueba ----------------
// Los valores de estado salen de `state`; cualquier otra dependencia registra la llamada y
// falla si no tiene implementación, así se ve qué usa cada turno y en qué orden.
function turnDeps(state: Record<string, unknown>, impl: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const recorder = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    const fn = impl[name];
    if (!fn) throw new Error("dependencia no esperada: " + name);
    return fn(...args);
  };
  const group = new Proxy({}, { get: (_target, name) => recorder(String(name)) });
  const stateGroup = new Proxy(state, {
    get: (target, name) => (typeof name === "string" && name in target ? target[name] : recorder(String(name))),
  });
  const deps = { state: stateGroup, api: group, chat: group, flow: group } as unknown as AdvisorTurnDeps;
  return { deps, calls };
}

const names = (calls: Call[]) => calls.map(([name]) => name);
const appends = (calls: Call[]) => calls.filter(([name]) => name === "appendAssistant").map(([, args]) => args);

const ctx: PlanContextStatus = { ok: true, status: "confirmed", exists: true, chatId: CHAT, contextJson: {}, contextText: null };
const paretoState: ParetoState = {
  roots: ["Falta de mantenimiento"],
  selectedRoots: ["Falta de mantenimiento"],
  criteria: [],
  criticalRoots: [],
  criticalEffectPercent: null,
  criticalJustification: null,
  step: "define_criteria",
};

async function main() {
  // ================= 1) Cuerpo de POST /api/messages =================
  {
    sent.length = 0;
    await persistMessageDB(AUTH, { chatId: CHAT, role: "user", content: "Hola" });
    await persistMessageDB(AUTH, { chatId: CHAT, role: "assistant", content: "Texto local" });
    await persistMessageDB(AUTH, {
      chatId: CHAT,
      role: "assistant",
      content: "Texto formateado",
      serverReply: { assistantMessage: "Texto original", assistantReceipt: RECEIPT },
    });
    // Un serverReply con role "user" o con campos de más no sale tal cual.
    await persistMessageDB(AUTH, {
      chatId: CHAT,
      role: "user",
      content: "Hola",
      serverReply: { assistantMessage: "x", assistantReceipt: RECEIPT },
    });
    const withExtra = { assistantMessage: "Texto original", assistantReceipt: RECEIPT, chatId: OTHER_CHAT, verified: true };
    await persistMessageDB(AUTH, { chatId: CHAT, role: "assistant", content: "Texto", serverReply: withExtra });

    assert.deepEqual(messageBodies(), [
      { chatId: CHAT, role: "user", content: "Hola" },
      { chatId: CHAT, role: "assistant", content: "Texto local" },
      {
        chatId: CHAT,
        role: "assistant",
        content: "Texto formateado",
        serverReply: { assistantMessage: "Texto original", assistantReceipt: RECEIPT },
      },
      { chatId: CHAT, role: "user", content: "Hola" },
      { chatId: CHAT, role: "assistant", content: "Texto", serverReply: { assistantMessage: "Texto original", assistantReceipt: RECEIPT } },
    ]);
    // Sin recibo, el cuerpo es exactamente el de antes (mismo orden de campos).
    assert.equal(
      JSON.stringify(messageBodies()[1]),
      JSON.stringify({ chatId: CHAT, role: "assistant", content: "Texto local" }),
    );
  }

  // ================= 2) /api/messages exige y lee el recibo =================
  {
    // El cuerpo que arma el cliente pasa el esquema con serverReply intacto.
    const withReceipt = {
      chatId: CHAT,
      role: "assistant",
      content: "Texto formateado",
      serverReply: { assistantMessage: "Texto original", assistantReceipt: RECEIPT },
    };
    const parsed = parsePersistMessageBody(withReceipt);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.body, withReceipt, "no descarta el recibo");
    const decide = (body: Parameters<typeof decideMessageWrite>[0]["body"]) =>
      decideMessageWrite({ userId: USER, body, chat: { ownerId: USER, mode: "plan_mejora" }, gate: { ok: true }, receiptKey: () => TEST_KEY });
    // Un recibo que no firmó este servidor no sirve.
    const forged = decide(parsed.body);
    assert.ok(!forged.ok && forged.code === "ASSISTANT_RECEIPT_INVALID");
    // assistant sin recibo ya no se guarda.
    const bare = parsePersistMessageBody({ chatId: CHAT, role: "assistant", content: "Sin recibo" });
    assert.ok(bare.ok);
    const unsigned = decide(bare.body);
    assert.ok(!unsigned.ok && unsigned.code === "ASSISTANT_RECEIPT_REQUIRED");
    // system sigue rechazado.
    assert.ok(!parsePersistMessageBody({ chatId: CHAT, role: "system", content: "x" }).ok);
  }

  // ================= 3) appendAssistant =================
  {
    // Texto transformado: se pinta y se guarda formateado (como siempre); el recibo viaja con
    // el original exacto que firmó el servidor.
    const raw = "Entendido, Ana, registré tu avance: 1. Capacitación del personal 2. Medición de tiempos";
    const display = formatted(raw);
    assert.notEqual(display, raw, "el ejemplo sí se transforma");
    const reply = signed(raw);
    const h = appendHarness("plan_mejora", CHAT);
    await appendAssistantMessage(h.deps, raw, reply);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].role, "assistant");
    assert.equal(h.shown[0].content, display, "se ve igual que antes");
    assert.equal(h.persisted.length, 1, "un solo guardado");
    assert.deepEqual(h.persisted[0], {
      chatId: CHAT,
      role: "assistant",
      content: display,
      serverReply: { assistantMessage: raw, assistantReceipt: RECEIPT },
    });
    assert.equal(h.persisted[0].serverReply?.assistantReceipt, reply?.assistantReceipt, "recibo intacto");
  }
  {
    // Mensaje local: sin recibo, igual que antes.
    const h = appendHarness("plan_mejora", CHAT);
    await appendAssistantMessage(h.deps, "✅ Ya tenemos suficientes causas.");
    assert.deepEqual(h.persisted, [{ chatId: CHAT, role: "assistant", content: "✅ Ya tenemos suficientes causas." }]);
  }
  {
    // Un mensaje local no toma el recibo de otra respuesta, aunque se lo pasen.
    const h = appendHarness("plan_mejora", CHAT);
    const other = signed("Indícame qué causas raíz quieres priorizar.");
    await appendAssistantMessage(h.deps, "⚠️ Indícame qué causas raíz quieres priorizar.", other);
    await appendAssistantMessage(h.deps, "Indícame qué causas raíz quieres priorizar. ", other);
    assert.equal(h.persisted.length, 2);
    for (const p of h.persisted) assert.ok(!("serverReply" in p), "texto distinto: sin recibo");
  }
  {
    // Dos respuestas con el mismo texto y recibos distintos: cada guardado lleva el suyo.
    const h = appendHarness("plan_mejora", CHAT);
    await appendAssistantMessage(h.deps, "¿Seguimos?", signed("¿Seguimos?", "ar1.uno.a"));
    await appendAssistantMessage(h.deps, "¿Seguimos?", signed("¿Seguimos?", "ar1.dos.b"));
    assert.deepEqual(
      h.persisted.map((p) => p.serverReply?.assistantReceipt),
      ["ar1.uno.a", "ar1.dos.b"],
    );
  }
  {
    // Cambio de chat antes de guardar: se guarda en el chat activo (como siempre), sin el
    // recibo del anterior.
    const h = appendHarness("plan_mejora", OTHER_CHAT);
    await appendAssistantMessage(h.deps, "¿Seguimos?", signed("¿Seguimos?"));
    assert.deepEqual(h.persisted, [{ chatId: OTHER_CHAT, role: "assistant", content: "¿Seguimos?" }]);
  }
  {
    // Sin chat activo: se pinta y no se guarda; en modo general, sin formato ni guardado.
    const noChat = appendHarness("plan_mejora", null);
    await appendAssistantMessage(noChat.deps, "Entendido, Ana, sigamos.", signed("Entendido, Ana, sigamos."));
    assert.equal(noChat.shown[0].content, formatted("Entendido, Ana, sigamos."));
    assert.equal(noChat.persisted.length, 0);

    const general = appendHarness("general", CHAT);
    await appendAssistantMessage(general.deps, "Entendido, Ana, sigamos.", signed("Entendido, Ana, sigamos."));
    assert.equal(general.shown[0].content, "Entendido, Ana, sigamos.");
    assert.equal(general.persisted.length, 0);
  }
  {
    // Contenido que no es texto: se serializa como antes y no lleva recibo.
    const h = appendHarness("plan_mejora", CHAT);
    await appendAssistantMessage(h.deps, { a: 1 }, signed('{"a":1}'));
    await appendAssistantMessage(h.deps, null, signed("x"));
    assert.equal(h.persisted[0].content, '{"a":1}');
    assert.ok(!("serverReply" in h.persisted[0]), "sin texto de la ruta no hay recibo");
    assert.ok(!("serverReply" in h.persisted[1]));
  }
  {
    // Formato visual sin cambios para textos de etapas reales.
    for (const raw of [
      "Perfecto, Ana. Ahora sí cuéntame qué actividades lograste ejecutar.",
      "✅ El FODA ya está completo en sus 4 cuadrantes.\n👉 Ahora corresponde validarlo.",
      "Tus causas: 1. Falta de capacitación 2. Máquinas sin mantenimiento\nAhora elige una.",
      "**Versión 1**: objetivo general redactado",
    ]) {
      const h = appendHarness("plan_mejora", CHAT);
      await appendAssistantMessage(h.deps, raw, signed(raw));
      assert.equal(h.shown[0].content, formatted(raw));
      assert.equal(h.persisted[0].content, formatted(raw));
      assert.equal(h.persisted[0].serverReply?.assistantMessage, raw);
    }
  }

  // ================= 4) Turnos: el recibo va solo con la respuesta de la ruta =================
  {
    // E5 Pareto en curso: el texto del servidor con su recibo; mismo orden de siempre.
    const reply = signed("Define el primer criterio.");
    const { deps, calls } = turnDeps({}, {
      callParetoAssistant: async () => ({
        ok: true,
        payload: { assistantMessage: "Define el primer criterio.", updates: { nextState: paretoState } },
        signedReply: reply,
      }),
      setParetoState: () => undefined,
      saveParetoState: async () => ({ ok: true }),
      appendAssistant: async () => undefined,
    });
    await handleParetoTurn(deps, { text: "Sigamos", ctx, effectiveChatId: CHAT, advisorChatId: CHAT, paretoState });
    assert.deepEqual(names(calls), ["callParetoAssistant", "setParetoState", "saveParetoState", "appendAssistant"]);
    const [args] = appends(calls);
    assert.equal(args.length, 2);
    assert.equal(args[0], "Define el primer criterio.");
    assert.equal(args[1], reply, "el mismo objeto de la respuesta");
  }
  {
    // E5 Pareto cerrado: respuesta con recibo y, si no se prepara E6, aviso local sin recibo.
    const reply = signed("Pareto listo.");
    const { deps, calls } = turnDeps({}, {
      callParetoAssistant: async () => ({
        ok: true,
        payload: { assistantMessage: "Pareto listo.", updates: { nextState: { ...paretoState, step: "done" } } },
        signedReply: reply,
      }),
      setParetoState: () => undefined,
      saveParetoState: async () => ({ ok: true }),
      validatePareto: async () => ({ ok: true, payload: { valid: true } }),
      appendAssistant: async () => undefined,
      applyBackendAdvisorAdvance: async () => false,
    });
    await handleParetoTurn(deps, { text: "Listo", ctx, effectiveChatId: CHAT, advisorChatId: CHAT, paretoState });
    assert.deepEqual(names(calls), [
      "callParetoAssistant",
      "setParetoState",
      "saveParetoState",
      "validatePareto",
      "appendAssistant",
      "applyBackendAdvisorAdvance",
      "appendAssistant",
    ]);
    const [server, local] = appends(calls);
    assert.deepEqual(server, ["Pareto listo.", reply]);
    assert.equal(local.length, 1, "aviso local sin recibo");
    assert.match(String(local[0]), /^✅ La Etapa 5 quedó validada/);
  }
  {
    // Error de la ruta: mensaje local sin recibo.
    const { deps, calls } = turnDeps({}, {
      callParetoAssistant: async () => ({ ok: false, payload: { ok: false }, signedReply: null }),
      appendAssistant: async () => undefined,
    });
    await handleParetoTurn(deps, { text: "Sigamos", ctx, effectiveChatId: CHAT, advisorChatId: CHAT, paretoState });
    assert.deepEqual(appends(calls).map((a) => a.length), [1]);
  }
  {
    // E2 FODA completo: respuesta con recibo; validación y aviso local sin recibo.
    const fodaState: FodaState = { currentQuadrant: "A", items: { F: [], D: [], O: [], A: [] }, pendingEvidence: null };
    const reply = signed("FODA completo.");
    const { deps, calls } = turnDeps({}, {
      callFodaAssistant: async () => ({
        ok: true,
        payload: { assistantMessage: "FODA completo.", updates: { nextState: fodaState, action: "complete" } },
        signedReply: reply,
      }),
      appendAssistant: async () => undefined,
      setFodaState: () => undefined,
      saveFodaState: async () => ({ ok: true }),
      validateFoda: async () => ({ ok: true, payload: {} }),
      applyBackendAdvisorAdvance: async () => false,
    });
    await handleFodaTurn(deps, { text: "continuemos", ctx, advisorChatId: CHAT, fodaState });
    assert.deepEqual(names(calls), [
      "callFodaAssistant",
      "appendAssistant",
      "setFodaState",
      "saveFodaState",
      "validateFoda",
      "applyBackendAdvisorAdvance",
      "appendAssistant",
    ]);
    const [server, local] = appends(calls);
    assert.deepEqual(server, ["FODA completo.", reply]);
    assert.equal(local.length, 1);
  }
  {
    // E9 Avances: respuesta con recibo.
    const progressState: ProgressState = {
      step: "report",
      reportText: null,
      progressPercent: null,
      measurementNote: null,
      summary: null,
      updatedAtLocal: null,
    };
    const reply = signed("¿Qué porcentaje llevas?");
    const { deps, calls } = turnDeps({}, {
      callProgressAssistant: async () => ({
        ok: true,
        payload: { assistantMessage: "¿Qué porcentaje llevas?", updates: { nextState: progressState, action: "ask_clarify" } },
        signedReply: reply,
      }),
      setProgressState: () => undefined,
      saveProgressState: async () => ({ ok: true }),
      appendAssistant: async () => undefined,
    });
    await handleProgressTurn(deps, { text: "Terminé la capacitación", effectiveChatId: CHAT, advisorChatId: CHAT, progressState });
    assert.deepEqual(names(calls), ["callProgressAssistant", "setProgressState", "saveProgressState", "appendAssistant"]);
    assert.deepEqual(appends(calls), [["¿Qué porcentaje llevas?", reply]]);
  }
  {
    // E4 Ishikawa: respuesta con recibo y, si se ofrece cerrar, la oferta local sin recibo.
    const ishikawaState: IshikawaState = {
      problem: { text: "Demoras en la entrega de pedidos" },
      categories: [],
      minCategories: 4,
      minMainCausesPerCategory: 2,
      minSubCausesPerMain: 2,
      maxWhyDepth: 5,
      minRootCandidates: 3,
    };
    const ui = { branchJustClosed: false, offerStageClose: true, awaitingWhy: false, awaitingRootMatch: false };
    const reply = signed("Ubiqué la causa en Máquina. ¿Por qué ocurre?");
    const { deps, calls } = turnDeps(
      { brainstormState: null, chatIdRef: { current: CHAT }, ishikawaClosePending: false, messagesRef: { current: [] } },
      {
        buildRecentMessagesForIshikawa: () => [],
        callIshikawaAssistant: async () => ({
          ok: true,
          assistantMessage: "Ubiqué la causa en Máquina. ¿Por qué ocurre?",
          nextState: ishikawaState,
          ui,
          signedReply: reply,
        }),
        setIshikawaState: () => undefined,
        saveIshikawaState: async () => ({ ok: true }),
        appendAssistant: async () => undefined,
        shouldOfferIshikawaStageClose: () => true,
        setIshikawaClosePending: () => undefined,
      },
    );
    await handleIshikawaTurn(deps, {
      effectiveIshikawaState: ishikawaState,
      effectiveChatId: CHAT,
      text: "La máquina se detiene por falta de mantenimiento preventivo",
      advisorChatId: CHAT,
      ctx,
      lastReport: { ok: false, payload: null },
    });
    assert.deepEqual(names(calls), [
      "buildRecentMessagesForIshikawa",
      "callIshikawaAssistant",
      "setIshikawaState",
      "saveIshikawaState",
      "appendAssistant",
      "shouldOfferIshikawaStageClose",
      "setIshikawaClosePending",
      "appendAssistant",
    ]);
    const [server, local] = appends(calls);
    assert.deepEqual(server, ["Ubiqué la causa en Máquina. ¿Por qué ocurre?", reply]);
    assert.equal(local.length, 1, "la oferta de cierre es local");
  }

  // ================= 5) De punta a punta en el cliente =================
  // Respuesta de la ruta (fetch) -> advisorApi -> turno -> appendAssistant -> cuerpo de
  // POST /api/messages, con las piezas reales.
  async function paretoEndToEnd(chatIdRef: { current: string | null }) {
    sent.length = 0;
    const raw = "Entendido, Ana: 1. Tiempo de espera 2. Costo de reproceso";
    routeReply = {
      ok: true,
      data: { assistantMessage: raw, updates: { nextState: paretoState, action: "ask_weights" }, assistantReceipt: RECEIPT },
    };
    const appendDeps: AppendAssistantDeps = {
      modeRef: { current: "plan_mejora" },
      chatIdRef,
      setMessages: () => undefined,
      persistMessageDB: (input) => persistMessageDB(AUTH, input),
    };
    const { deps } = turnDeps({}, {
      callParetoAssistant: (input) =>
        callParetoAssistant(AUTH, input as Parameters<typeof callParetoAssistant>[1], chatIdRef.current, "historial"),
      setParetoState: () => undefined,
      saveParetoState: async () => ({ ok: true }),
      appendAssistant: (content, reply) =>
        appendAssistantMessage(appendDeps, content, reply as SignedAssistantReply | null | undefined),
    });
    await handleParetoTurn(deps, { text: "Sigamos", ctx, effectiveChatId: CHAT, advisorChatId: CHAT, paretoState });
    return { raw, bodies: messageBodies(), routeCalls: sent.filter((s) => s.url.endsWith("/assistant")) };
  }
  {
    const chatIdRef = { current: CHAT as string | null };
    const { raw, bodies, routeCalls } = await paretoEndToEnd(chatIdRef);
    assert.equal(routeCalls.length, 1, "una sola llamada a la ruta (y al modelo)");
    assert.equal(routeCalls[0].body.chatId, CHAT);
    assert.deepEqual(bodies, [
      {
        chatId: CHAT,
        role: "assistant",
        content: formatted(raw),
        serverReply: { assistantMessage: raw, assistantReceipt: RECEIPT },
      },
    ]);
  }
  {
    // El estudiante cambia de chat mientras espera la respuesta: se guarda donde se guardaba
    // (el chat activo), pero sin el recibo, que era del chat anterior.
    const chatIdRef = { current: CHAT as string | null };
    onRouteCall = () => {
      chatIdRef.current = OTHER_CHAT;
    };
    const { raw, bodies } = await paretoEndToEnd(chatIdRef);
    onRouteCall = () => undefined;
    assert.deepEqual(bodies, [{ chatId: OTHER_CHAT, role: "assistant", content: formatted(raw) }]);
  }

  // ================= 6) Código: cada recibo sale de su propia respuesta =================
  const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
  const turnsDir = path.join("src", "app", "chat", "_lib", "turns");
  const sources: Array<[string, string]> = readdirSync(turnsDir)
    .filter((f) => f.endsWith("Turn.ts"))
    .map((f) => [f, read(turnsDir, f)]);
  const page = read("src", "app", "chat", "page.tsx");
  sources.push(["page.tsx", page]);

  const expected: Record<string, string[]> = {
    "brainstormTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "fodaTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "improvementTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "ishikawaTurn.ts": [
      "appendAssistant(ai.assistantMessage, ai.signedReply)",
      "appendAssistant(assistant.assistantMessage, assistant.signedReply)",
    ],
    "objectivesTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "paretoTurn.ts": [
      "appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)",
      "appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)",
    ],
    "planningTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "productivityTurn.ts": ["appendAssistant(a.assistantMessage, assistant.signedReply)"],
    "progressTurn.ts": ["appendAssistant(assistant.payload.assistantMessage, assistant.signedReply)"],
    "page.tsx": ["appendAssistant(a.payload.assistantMessage, a.signedReply)"],
  };
  let withReply = 0;
  for (const [file, code] of sources) {
    const found = code.match(/appendAssistant\([^()]*\.signedReply\)/g) ?? [];
    assert.deepEqual(found, expected[file] ?? [], `${file}: llamadas con recibo`);
    withReply += found.length;
    // Ninguna respuesta de ruta se pinta sin su recibo.
    assert.ok(!/appendAssistant\((?:\w+\.)+assistantMessage\)/.test(code), `${file}: respuesta sin recibo`);
  }
  assert.equal(withReply, 12, "11 en los turnos y 1 en page.tsx (final_doc)");
  // productivity: a es el payload de la misma respuesta.
  assert.ok(read(turnsDir, "productivityTurn.ts").includes("const a = assistant.payload;"));
  // final_doc: a es la respuesta de callFinalDocAssistant.
  assert.ok(/const a = await callFinalDocAssistant\(/.test(page));

  // page.tsx delega en appendAssistantMessage y ya no da formato por su cuenta.
  assert.ok(
    page.includes(
      "await appendAssistantMessage({ modeRef, chatIdRef, setMessages, persistMessageDB }, content, reply);",
    ),
  );
  assert.ok(!page.includes("softenAssistantLeadInChat") && !page.includes("formatAssistantMessageForReadability"));
  // Un solo guardado por mensaje.
  assert.equal(read("src", "app", "chat", "_lib", "appendAssistantMessage.ts").match(/persistMessageDB\(/g)?.length, 1);
  // Las transiciones solo emiten textos locales: no reciben ni pasan recibos.
  assert.ok(!read("src", "app", "chat", "_lib", "advisorTransitions.ts").includes("signedReply"));
  assert.ok(read("src", "app", "chat", "_lib", "advisorTransitions.ts").includes("appendAssistant: (content: unknown) => Promise<void>;"));
}

main()
  .then(() => console.log("assistantReplyPersist tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
