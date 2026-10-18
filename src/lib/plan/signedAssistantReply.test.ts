import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  callBrainstormAssistant,
  callFinalDocAssistant,
  callFodaAssistant,
  callImprovementAssistant,
  callObjectivesAssistant,
  callParetoAssistant,
  callPlanningAssistant,
  callProductivityAssistant,
  callProgressAssistant,
} from "../../app/chat/_lib/advisorApi";
import type {
  FodaState,
  ImprovementState,
  ObjectivesState,
  ParetoState,
  PlanningState,
  ProgressState,
} from "./advisorStates";
import type { BrainstormState } from "./brainstormFlow";
import {
  attachSignedReply,
  readSignedAssistantReply,
  type SignedAssistantReply,
} from "../chat/signedAssistantReply";

// Transporte de recibos en el navegador (R1): las llamadas a las rutas assistant devuelven,
// junto al payload de siempre, el recibo tal cual llegó, atado al texto exacto y al chat que se
// envió. El cliente no verifica ni fabrica recibos. Sin red: fetch se reemplaza en este proceso.

const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";
const AUTH = { Authorization: "Bearer token-de-prueba" };
const RECEIPT = "ar1.eyJ2IjoxfQ.firma-de-prueba";
const MESSAGE = "Entendido, Ana: según tu cronograma 1. Revisa la causa 2. Mide el tiempo";

type Json = Record<string, unknown>;

let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
let fetchCalls = 0;

globalThis.fetch = async (): Promise<Response> => {
  fetchCalls++;
  return new Response(JSON.stringify(nextResponse.body), {
    status: nextResponse.status,
    headers: { "content-type": "application/json" },
  });
};

const paretoState: ParetoState = {
  roots: [],
  selectedRoots: [],
  criteria: [],
  criticalRoots: [],
  criticalEffectPercent: null,
  criticalJustification: null,
  step: "select_roots",
};
const fodaState: FodaState = { currentQuadrant: "F", items: { F: [], D: [], O: [], A: [] }, pendingEvidence: null };
const brainstormState: BrainstormState = { step: "choose_strategy", strategy: null, problem: null, ideas: [], minIdeas: 10 };
const objectivesState: ObjectivesState = { generalObjective: "", specificObjectives: [], linkedCriticalRoots: [], step: "general" };
const improvementState: ImprovementState = {
  stageIntroDone: false,
  step: "discover",
  focus: { chosenRoot: null, chosenObjective: null },
  initiatives: [],
  lastSummary: null,
};
const planningState: PlanningState = {
  stageIntroDone: false,
  step: "time_window",
  time: { studentWeeks: null, courseCutoffDate: null, effectiveWeeks: null, notes: null },
  plan: { weekly: [], milestones: [], risks: [] },
  lastSummary: null,
};
const progressState: ProgressState = {
  step: "intro",
  reportText: null,
  progressPercent: null,
  measurementNote: null,
  summary: null,
  updatedAtLocal: null,
};

type Result = { ok: boolean; payload: unknown; signedReply: SignedAssistantReply | null };

const ROUTES: Array<{ name: string; run: (chatId: string | null) => Promise<Result> }> = [
  {
    name: "productivity",
    run: (c) => callProductivityAssistant(AUTH, { studentMessage: "__START__", prodStep: 1, prodDraft: {}, caseContext: null }, c, "h"),
  },
  { name: "foda", run: (c) => callFodaAssistant(AUTH, { studentMessage: "sigo", fodaState, caseContext: null }, c, "h") },
  {
    name: "brainstorm",
    run: (c) =>
      callBrainstormAssistant(
        AUTH,
        { studentMessage: "FO", brainstormState, caseContext: null, stage1Summary: null, fodaSummary: null },
        c,
        "h",
      ),
  },
  { name: "pareto", run: (c) => callParetoAssistant(AUTH, { studentMessage: "sigo", paretoState, caseContext: null }, c, "h") },
  {
    name: "objectives",
    run: (c) => callObjectivesAssistant(AUTH, { studentMessage: "sigo", objectivesState, caseContext: null }, c, "h"),
  },
  {
    name: "improvement",
    run: (c) => callImprovementAssistant(AUTH, { studentMessage: "sigo", improvementState, caseContext: null }, c, "h"),
  },
  {
    name: "planning",
    run: (c) => callPlanningAssistant(AUTH, { studentMessage: "sigo", planningState, caseContext: null }, c, "h"),
  },
  { name: "progress", run: (c) => callProgressAssistant(AUTH, { studentMessage: "sigo", progressState }, c, "h") },
  {
    name: "final_doc",
    run: (c) =>
      callFinalDocAssistant(AUTH, { fileName: "plan.pdf", storagePath: "plans/x/plan.pdf", extractedText: "texto" }, c, "h"),
  },
];

async function main() {
  // ---------------- Lectura del recibo ----------------
  {
    const data: Json = { assistantMessage: MESSAGE, updates: { action: "x" }, assistantReceipt: RECEIPT };
    const before = JSON.stringify(data);
    const reply = readSignedAssistantReply(true, data, CHAT);
    assert.deepEqual(reply, { chatId: CHAT, assistantMessage: MESSAGE, assistantReceipt: RECEIPT });
    assert.ok(Object.isFrozen(reply), "el metadato no se puede modificar después");
    assert.equal(JSON.stringify(data), before, "no toca la respuesta");
    data.assistantReceipt = "ar1.otro.recibo";
    assert.equal(reply?.assistantReceipt, RECEIPT, "no queda enlazado al objeto de la respuesta");

    assert.equal(readSignedAssistantReply(false, { assistantMessage: MESSAGE, assistantReceipt: RECEIPT }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: RECEIPT }, null), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: RECEIPT }, ""), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: "" }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: 7 }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: { v: 1 } }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: "", assistantReceipt: RECEIPT }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, { assistantMessage: ["x"], assistantReceipt: RECEIPT }, CHAT), null);
    assert.equal(readSignedAssistantReply(true, null, CHAT), null);
    assert.equal(readSignedAssistantReply(true, "texto", CHAT), null);
  }

  // ---------------- Asociación exacta ----------------
  {
    const reply = readSignedAssistantReply(true, { assistantMessage: MESSAGE, assistantReceipt: RECEIPT }, CHAT);
    const attached = attachSignedReply({ content: MESSAGE, chatId: CHAT, reply });
    assert.deepEqual(attached, { attached: true, serverReply: { assistantMessage: MESSAGE, assistantReceipt: RECEIPT } });
    assert.ok(attached.attached && Object.isFrozen(attached.serverReply));

    // Sin normalizar: cualquier diferencia de texto deja el mensaje sin recibo.
    assert.notEqual(MESSAGE.normalize("NFD"), MESSAGE);
    for (const content of [
      `⚠️ ${MESSAGE}`,
      `${MESSAGE} `,
      `${MESSAGE}\n`,
      MESSAGE.toLowerCase(),
      MESSAGE.normalize("NFD"),
      "1. Revisa la causa\n\n2. Mide el tiempo",
    ]) {
      assert.deepEqual(attachSignedReply({ content, chatId: CHAT, reply }), { attached: false, reason: "CONTENT_MISMATCH" });
    }
    // Otro chat: no se reutiliza.
    assert.deepEqual(attachSignedReply({ content: MESSAGE, chatId: OTHER_CHAT, reply }), {
      attached: false,
      reason: "CHAT_MISMATCH",
    });
    // Mensajes locales: sin recibo.
    assert.deepEqual(attachSignedReply({ content: MESSAGE, chatId: CHAT, reply: null }), { attached: false, reason: "NO_RECEIPT" });
    assert.deepEqual(attachSignedReply({ content: MESSAGE, chatId: CHAT, reply: undefined }), {
      attached: false,
      reason: "NO_RECEIPT",
    });

    // Dos respuestas con el mismo texto y recibos distintos: cada una conserva el suyo.
    const first = readSignedAssistantReply(true, { assistantMessage: "¿Seguimos?", assistantReceipt: "ar1.a.uno" }, CHAT);
    const second = readSignedAssistantReply(true, { assistantMessage: "¿Seguimos?", assistantReceipt: "ar1.b.dos" }, CHAT);
    const a = attachSignedReply({ content: "¿Seguimos?", chatId: CHAT, reply: first });
    const b = attachSignedReply({ content: "¿Seguimos?", chatId: CHAT, reply: second });
    assert.ok(a.attached && b.attached);
    assert.equal(a.serverReply.assistantReceipt, "ar1.a.uno");
    assert.equal(b.serverReply.assistantReceipt, "ar1.b.dos");
  }

  // ---------------- Las nueve llamadas de advisorApi ----------------
  for (const route of ROUTES) {
    const data = { assistantMessage: MESSAGE, updates: { nextState: { step: "x" }, action: "y" }, assistantReceipt: RECEIPT };

    // Con chat y recibo: el payload sigue igual y signedReply lleva el recibo intacto.
    nextResponse = { status: 200, body: { ok: true, data } };
    const signed = await route.run(CHAT);
    assert.equal(signed.ok, true, route.name);
    assert.deepEqual(signed.payload, data, `${route.name}: payload sin cambios`);
    assert.deepEqual(signed.signedReply, { chatId: CHAT, assistantMessage: MESSAGE, assistantReceipt: RECEIPT }, route.name);
    assert.equal(signed.signedReply?.assistantMessage, (signed.payload as Json).assistantMessage, `${route.name}: mismo texto`);

    // Sin recibo (clave ausente, chat no verificado, eco del cliente...): como hasta ahora.
    const unsignedData = { assistantMessage: data.assistantMessage, updates: data.updates };
    nextResponse = { status: 200, body: { ok: true, data: unsignedData } };
    const unsigned = await route.run(CHAT);
    assert.deepEqual(unsigned.payload, unsignedData, route.name);
    assert.equal(unsigned.signedReply, null, `${route.name}: sin recibo`);

    // Petición sin chat: aunque llegara un recibo, no se transporta.
    nextResponse = { status: 200, body: { ok: true, data } };
    assert.equal((await route.run(null)).signedReply, null, `${route.name}: sin chat`);

    // Errores: nada que transportar.
    nextResponse = { status: 403, body: { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." } };
    const failed = await route.run(CHAT);
    assert.equal(failed.ok, false);
    assert.equal(failed.signedReply, null, `${route.name}: error`);
    nextResponse = { status: 200, body: { ok: false, data } };
    assert.equal((await route.run(CHAT)).signedReply, null, `${route.name}: ok false`);
  }
  assert.equal(fetchCalls, ROUTES.length * 5, "una petición por llamada, sin reintentos");

  // ---------------- Ishikawa (envoltorio propio en page.tsx) ----------------
  // Solo la respuesta del servidor lleva recibo; los dos textos locales de reserva, no.
  const page = readFileSync(path.join("src", "app", "chat", "page.tsx"), "utf8").replace(/\r\n/g, "\n");
  const start = page.indexOf("async function callIshikawaAssistant(");
  const end = page.indexOf("async function handleStage6NextStepQuestion(");
  assert.ok(start > 0 && end > start);
  const ishikawa = page.slice(start, end);
  assert.equal(ishikawa.match(/signedReply: null/g)?.length, 2, "los textos locales van sin recibo");
  assert.equal(ishikawa.match(/signedReply:/g)?.length, 3);
  assert.ok(ishikawa.includes("signedReply: readSignedAssistantReply(true, data, args.chatId),"));
  assert.ok(ishikawa.includes("const assistantMessage =\n      data?.assistantMessage ?? null;"), "mismo objeto que el texto");
}

main()
  .then(() => console.log("signedAssistantReply tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
