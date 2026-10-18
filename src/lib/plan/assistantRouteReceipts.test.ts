import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { verifyAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import {
  approvedProfile,
  installFetchStub,
  prepareRouteTestEnv,
  routeRequest,
  type RouteStubState,
} from "./assistantRouteHarness";

// Recibos en las rutas assistant que reciben chatId (R1, paso 3). Se ejecutan las rutas
// reales contra Supabase y Gemini simulados (sin red, escrituras rechazadas), con una clave de
// prueba. Lo que se comprueba:
//   - qué rutas están envueltas y cuáles no (brainstorm, foda y productivity quedan fuera);
//   - una respuesta real del servidor (fija o generada por el modelo) sale con un recibo que
//     verifica el texto EXACTO emitido, el usuario de la sesión y el chat;
//   - errores, chat ajeno, falta de la etapa previa y fallos del modelo salen igual y sin
//     recibo;
//   - el adaptador no repite la llamada al modelo;
//   - pareto sin chatId sigue funcionando sin comprobar chat y sin recibo.

const SECRET = Buffer.from("opt-ia: secreto de recibos de rutas, solo pruebas").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_CHAT = "44444444-4444-4444-8444-444444444444";
const COHORT = "66666666-6666-4666-8666-666666666666";

const PROGRESS_ASK_REPORT =
  "Perfecto. Ahora sí cuéntame brevemente qué actividades lograste ejecutar hasta hoy respecto a tu cronograma. Puede ser algo simple, por ejemplo: qué sí hiciste, qué quedó pendiente o si hubo algún desvío.";

const state: RouteStubState = {
  user: { id: USER, email: "ana.prueba@estudiante.test" },
  profile: approvedProfile(USER, COHORT),
  cohortActive: true,
  chatOwners: { [CHAT]: USER, [FOREIGN_CHAT]: OTHER_USER },
  artifact: null,
  geminiReplies: [],
};

const progressState = {
  step: "intro",
  reportText: null,
  progressPercent: null,
  measurementNote: null,
  summary: null,
  updatedAtLocal: null,
};

const paretoState = {
  roots: [],
  selectedRoots: [],
  criteria: [],
  criticalRoots: [],
  criticalEffectPercent: null,
  criticalJustification: null,
  step: "select_roots",
};

const planningArtifact = {
  payload: { activities: [{ name: "Capacitación del personal", week: 1 }] },
  chat_id: CHAT,
  period_key: "2026-10",
  updated_at: "2026-10-10T12:00:00Z",
};

const WRAPPED = ["final_doc", "improvement", "ishikawa", "objectives", "pareto", "planning", "progress"];
const NOT_YET = ["brainstorm", "foda", "productivity"];

type Json = Record<string, unknown>;

function routeSource(stage: string): string {
  return readFileSync(path.join("src", "app", "api", "plans", stage, "assistant", "route.ts"), "utf8");
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

  // Qué rutas están envueltas.
  for (const stage of WRAPPED) {
    const code = routeSource(stage);
    assert.ok(
      code.includes("export const POST = withAssistantReceipt(handlePost, assistantReceiptServerDeps);"),
      `${stage} envuelta`,
    );
    assert.ok(!/export async function POST/.test(code), `${stage}: un solo POST exportado`);
  }
  for (const stage of NOT_YET) {
    assert.ok(!routeSource(stage).includes("withAssistantReceipt"), `${stage} todavía sin recibos`);
  }

  const stub = installFetchStub(state);
  const progress = await import("../../app/api/plans/progress/assistant/route");
  const finalDoc = await import("../../app/api/plans/final_doc/assistant/route");
  const pareto = await import("../../app/api/plans/pareto/assistant/route");
  const ishikawa = await import("../../app/api/plans/ishikawa/assistant/route");

  async function callProgress(body: unknown, token: string | null = "token-de-prueba") {
    stub.reset();
    const res = await progress.POST(routeRequest("/api/plans/progress/assistant", body, token));
    const text = await res.text();
    return { res, text, json: JSON.parse(text) as Json };
  }

  // 1) Respuesta fija del servidor (sin modelo): recibo sobre ese texto exacto.
  state.artifact = planningArtifact;
  const fixed = await callProgress({ chatId: CHAT, studentMessage: "ok", progressState });
  assert.equal(fixed.res.status, 200);
  const fixedData = fixed.json.data as Json;
  assert.deepEqual(Object.keys(fixed.json), ["ok", "data"]);
  assert.deepEqual(Object.keys(fixedData), ["assistantMessage", "updates", "assistantReceipt"]);
  assert.equal(fixedData.assistantMessage, PROGRESS_ASK_REPORT);
  assert.equal((fixedData.updates as Json).action, "ask_report");
  assert.equal(verify(fixedData.assistantReceipt, PROGRESS_ASK_REPORT), "OK");
  assert.equal(verify(fixedData.assistantReceipt, PROGRESS_ASK_REPORT, FOREIGN_CHAT), "CHAT_MISMATCH");
  assert.equal(verify(fixedData.assistantReceipt, PROGRESS_ASK_REPORT, CHAT, OTHER_USER), "USER_MISMATCH");
  assert.equal(stub.geminiCalls(), 0);

  // 2) Respuesta generada por el modelo: la ruta la procesa (quita "Entendido," y el nombre) y
  //    el recibo firma el texto ya emitido, no el crudo del modelo. Una sola llamada a Gemini.
  const rawModelMessage =
    "Entendido, Ana, registré la capacitación como avance parcial. ¿Qué porcentaje del cronograma estimas que llevas?";
  state.geminiReplies = [
    JSON.stringify({
      assistantMessage: rawModelMessage,
      updates: {
        nextState: { ...progressState, step: "clarify", reportText: "Capacitación del personal realizada" },
        action: "ask_clarify",
      },
    }),
  ];
  const generated = await callProgress({
    chatId: CHAT,
    studentMessage: "Terminé la capacitación del personal y quedó pendiente la medición",
    progressState,
  });
  assert.equal(generated.res.status, 200);
  const generatedData = generated.json.data as Json;
  const emitted = String(generatedData.assistantMessage);
  assert.notEqual(emitted, rawModelMessage, "la ruta transforma el texto del modelo");
  assert.equal(verify(generatedData.assistantReceipt, emitted), "OK");
  assert.equal(verify(generatedData.assistantReceipt, rawModelMessage), "CONTENT_MISMATCH");
  assert.equal(stub.geminiCalls(), 1, "el adaptador no repite la llamada al modelo");

  // 3) Respuestas fallidas: idénticas y sin recibo.
  const anonymous = await callProgress({ chatId: CHAT, studentMessage: "ok", progressState }, null);
  assert.equal(anonymous.res.status, 401);
  assert.deepEqual(anonymous.json, { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." });

  const foreign = await callProgress({ chatId: FOREIGN_CHAT, studentMessage: "ok", progressState });
  assert.equal(foreign.res.status, 403);
  assert.deepEqual(foreign.json, { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." });

  state.artifact = null;
  const noStage8 = await callProgress({ chatId: CHAT, studentMessage: "ok", progressState });
  assert.equal(noStage8.res.status, 400);
  assert.deepEqual(noStage8.json, {
    ok: false,
    code: "BAD_REQUEST",
    message: "Para iniciar Etapa 9 necesitas Etapa 8 (Planificación) validada.",
  });
  state.artifact = planningArtifact;

  state.geminiReplies = ["sin json", "tampoco json"];
  const modelFailure = await callProgress({
    chatId: CHAT,
    studentMessage: "Terminé la capacitación del personal",
    progressState,
  });
  assert.equal(modelFailure.res.status, 500);
  assert.deepEqual(modelFailure.json, { ok: false, code: "INTERNAL", message: "LLM no devolvió JSON válido.", detail: null });
  assert.equal(stub.geminiCalls(), 2, "intento y reparación de la ruta, nada más");
  for (const failed of [anonymous, foreign, noStage8, modelFailure]) {
    assert.ok(!failed.text.includes("assistantReceipt"), "ninguna respuesta fallida lleva recibo");
  }

  // 4) final_doc y pareto con chat ajeno: su comprobación previa sigue igual, sin recibo y
  //    sin llamar al modelo.
  stub.reset();
  const finalDocForeign = await finalDoc.POST(
    routeRequest("/api/plans/final_doc/assistant", {
      chatId: FOREIGN_CHAT,
      fileName: "plan.pdf",
      storagePath: "plans/prueba/plan.pdf",
      extractedText: "Texto extraído del documento final del plan de mejora. ".repeat(3),
    }),
  );
  assert.equal(finalDocForeign.status, 403);
  assert.deepEqual(await finalDocForeign.json(), { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." });
  assert.equal(stub.geminiCalls(), 0);

  stub.reset();
  const paretoForeign = await pareto.POST(
    routeRequest("/api/plans/pareto/assistant", { chatId: FOREIGN_CHAT, studentMessage: "Elijo la causa 1", paretoState }),
  );
  assert.equal(paretoForeign.status, 403);
  assert.deepEqual(await paretoForeign.json(), { ok: false, code: "FORBIDDEN", message: "No tienes acceso a este chat." });
  assert.ok(!stub.tables().includes("plan_stage_states"), "pareto no lee estado de un chat ajeno");
  assert.equal(stub.geminiCalls(), 0);

  // 5) pareto admite chatId null: no se comprueba chat, la ruta sigue y no hay recibo.
  stub.reset();
  state.geminiReplies = [
    JSON.stringify({ assistantMessage: "Indícame qué causas raíz quieres priorizar.", updates: { nextState: paretoState, action: "ask_roots" } }),
  ];
  const paretoNoChat = await pareto.POST(
    routeRequest("/api/plans/pareto/assistant", { chatId: null, studentMessage: "Quiero empezar Pareto", paretoState }),
  );
  const paretoNoChatText = await paretoNoChat.text();
  assert.notEqual(paretoNoChat.status, 403);
  assert.notEqual(paretoNoChat.status, 404);
  assert.ok(!stub.tables().includes("chats"), "sin chatId no se consulta chats");
  assert.ok(!paretoNoChatText.includes("assistantReceipt"), "sin chatId no hay recibo");

  // 6) ishikawa envuelta: el error de sesión sale igual.
  stub.reset();
  const ishikawaAnonymous = await ishikawa.POST(routeRequest("/api/plans/ishikawa/assistant", { chatId: CHAT }, null));
  assert.equal(ishikawaAnonymous.status, 401);
  assert.ok(!(await ishikawaAnonymous.text()).includes("assistantReceipt"));
  assert.equal(stub.calls.length, 0);

  assert.equal(stub.writes.length, 0, "ninguna petición escribe en Supabase");
  stub.restore();
}

main()
  .then(() => console.log("assistantRouteReceipts tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
