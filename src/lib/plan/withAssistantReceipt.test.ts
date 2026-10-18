import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { verifyAssistantReceipt } from "../chat/assistantReceipt";
import {
  loadAssistantReceiptKey,
  type AssistantReceiptKeyStatus,
} from "../chat/assistantReceiptConfig";
import {
  ASSISTANT_RECEIPT_FIELD,
  withAssistantReceipt,
  type AssistantReceiptDeps,
  type AssistantReceiptSkipReason,
} from "../chat/withAssistantReceipt";

// Adaptador que añade recibos a las respuestas de /api/plans/*/assistant (R1, paso 2).
// Sin Supabase, sin Gemini y sin red: la sesión, la propiedad del chat y la clave llegan
// como dependencias simuladas. El secreto es solo de prueba y se genera aquí.

const SECRET = Buffer.from("opt-ia: secreto de recibos solo para pruebas 2026").toString("base64");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);
const REPLY = "Bien. Ahora ordena tus causas por **frecuencia**: ¿cuál ocurre más seguido?";

const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
assert.ok(keyStatus.ok, "el secreto de prueba debe ser válido");
const KEY = keyStatus.key;

type Calls = { authenticate: number; isChatOwner: number; skips: AssistantReceiptSkipReason[] };

function makeDeps(overrides: Partial<AssistantReceiptDeps> = {}): { deps: AssistantReceiptDeps; calls: Calls } {
  const calls: Calls = { authenticate: 0, isChatOwner: 0, skips: [] };
  const deps: AssistantReceiptDeps = {
    authenticate: async () => {
      calls.authenticate++;
      return USER;
    },
    isChatOwner: async (userId, chatId) => {
      calls.isChatOwner++;
      return userId === USER && chatId === CHAT;
    },
    getKey: (): AssistantReceiptKeyStatus => keyStatus,
    now: () => NOW,
    onSkip: (reason) => calls.skips.push(reason),
    ...overrides,
  };
  return { deps, calls };
}

function request(body: unknown, raw = false): Request {
  return new Request("https://opt-ia.test/api/plans/pareto/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer token-de-prueba" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

// Handler de prueba: lee el cuerpo como haría la ruta real y responde lo indicado.
function handlerReturning(payload: unknown, init: ResponseInit = {}, seen: unknown[] = []) {
  return async (req: Request): Promise<Response> => {
    seen.push(await req.json().catch(() => "(cuerpo ilegible)"));
    return Response.json(payload, init);
  };
}

async function run(
  payload: unknown,
  body: unknown = { chatId: CHAT, studentMessage: "Mis causas son demoras y errores" },
  overrides: Partial<AssistantReceiptDeps> = {},
  init: ResponseInit = {},
) {
  const { deps, calls } = makeDeps(overrides);
  const seen: unknown[] = [];
  let original: Response | null = null;
  const inner = handlerReturning(payload, init, seen);
  const wrapped = withAssistantReceipt(async (req: Request) => {
    original = await inner(req);
    return original;
  }, deps);
  const out = await wrapped(request(body));
  return { out, original: original as Response | null, calls, seen };
}

function verify(receipt: unknown, content = REPLY, userId = USER, chatId = CHAT): string {
  const result = verifyAssistantReceipt(KEY, receipt, { userId, chatId, content }, { now: NOW });
  return result.ok ? "OK" : result.reason;
}

function receiptModuleImportsFromClient(): string[] {
  const found: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".test.ts")) continue;
      const rel = full.split(path.sep).join("/");
      const code = readFileSync(full, "utf8");
      if (!/(withAssistantReceipt|assistantReceiptConfig|assistantReceiptServerDeps)["']/.test(code)) continue;
      if (/^\s*["']use client["']/m.test(code) || rel.startsWith("src/app/chat/") || rel.startsWith("src/components/")) {
        found.push(rel);
      }
    }
  })("src");
  return found;
}

async function main() {
  // 2xx con data.assistantMessage: se añade el recibo junto al mensaje y verifica el texto
  // exacto, el usuario de la sesión y el chat.
  const dataPayload = {
    ok: true,
    data: { assistantMessage: REPLY, updates: { nextState: { criteria: ["frecuencia"] } }, ui: null },
  };
  const a = await run(dataPayload, { chatId: CHAT, studentMessage: "Mis causas", userId: OTHER_USER });
  assert.equal(a.out.status, 200);
  assert.ok((a.out.headers.get("content-type") ?? "").includes("application/json"));
  const aJson = (await a.out.json()) as { ok: boolean; data: Record<string, unknown> };
  assert.deepEqual(Object.keys(aJson), ["ok", "data"]);
  assert.deepEqual(Object.keys(aJson.data), ["assistantMessage", "updates", "ui", ASSISTANT_RECEIPT_FIELD]);
  const { [ASSISTANT_RECEIPT_FIELD]: receiptA, ...restA } = aJson.data;
  assert.deepEqual({ ok: aJson.ok, data: restA }, dataPayload, "el resto de la respuesta no cambia");
  assert.equal(verify(receiptA), "OK");
  assert.equal(verify(receiptA, REPLY + " "), "CONTENT_MISMATCH");
  assert.equal(verify(receiptA, REPLY, OTHER_USER), "USER_MISMATCH", "el userId del cuerpo se ignora");
  assert.equal(verify(receiptA, REPLY, USER, OTHER_CHAT), "CHAT_MISMATCH");
  assert.deepEqual(a.seen, [{ chatId: CHAT, studentMessage: "Mis causas", userId: OTHER_USER }], "el handler recibe el cuerpo intacto");

  // Forma de final_doc: assistantMessage en la raíz.
  const topPayload = { ok: true, assistantMessage: REPLY, updates: { nextState: {} } };
  const b = await run(topPayload);
  const bJson = (await b.out.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bJson), ["ok", "assistantMessage", "updates", ASSISTANT_RECEIPT_FIELD]);
  assert.equal(verify(bJson[ASSISTANT_RECEIPT_FIELD]), "OK");

  // Estado y cabeceras se conservan.
  const c = await run(dataPayload, undefined, {}, { status: 201, headers: { "x-opt-ia": "1" } });
  assert.equal(c.out.status, 201);
  assert.equal(c.out.headers.get("x-opt-ia"), "1");

  // Sin assistantMessage, vacío o no textual: la respuesta original, intacta.
  for (const payload of [
    { ok: true, data: { updates: {} } },
    { ok: true, data: { assistantMessage: "   " } },
    { ok: true, data: { assistantMessage: 42 } },
  ]) {
    const r = await run(payload);
    assert.equal(r.out, r.original, "misma respuesta, sin tocar");
    assert.deepEqual(r.calls.skips, ["NO_ASSISTANT_MESSAGE"]);
    assert.equal(r.calls.authenticate, 0);
  }

  // Respuestas de error: nunca se firman ni se modifican.
  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    const r = await run({ ok: false, code: "X", message: "fallo", assistantMessage: REPLY }, undefined, {}, { status });
    assert.equal(r.out, r.original);
    assert.equal(r.out.status, status);
    assert.deepEqual(r.calls.skips, ["NOT_SUCCESS"]);
    assert.equal(r.calls.authenticate, 0);
  }
  const failedOk = await run({ ok: false, data: { assistantMessage: REPLY } });
  assert.equal(failedOk.out, failedOk.original, "200 con ok: false no se firma");
  assert.deepEqual(failedOk.calls.skips, ["NOT_SUCCESS"]);

  // 2xx que no es JSON.
  {
    const { deps, calls } = makeDeps();
    const original = new Response(REPLY, { status: 200, headers: { "content-type": "text/plain" } });
    const out = await withAssistantReceipt(async () => original, deps)(request({ chatId: CHAT }));
    assert.equal(out, original);
    assert.deepEqual(calls.skips, ["NOT_JSON"]);
  }

  // Usuario no autenticado (null o error al validar la sesión).
  for (const authenticate of [async () => null, async (): Promise<string | null> => { throw new Error("UNAUTHORIZED"); }]) {
    const r = await run(dataPayload, undefined, { authenticate });
    assert.equal(r.out, r.original);
    assert.deepEqual(r.calls.skips, ["UNAUTHENTICATED"]);
  }

  // Chat ajeno, inexistente o error al comprobarlo.
  for (const isChatOwner of [
    async () => false,
    async (): Promise<boolean> => { throw new Error("db"); },
  ]) {
    const r = await run(dataPayload, undefined, { isChatOwner });
    assert.equal(r.out, r.original);
    assert.deepEqual(r.calls.skips, ["CHAT_NOT_OWNED"]);
  }
  const foreign = await run(dataPayload, { chatId: OTHER_CHAT, studentMessage: "x" });
  assert.equal(foreign.out, foreign.original, "chat de otro usuario según isChatOwner");

  // Sin chatId, chatId inválido o cuerpo que no es JSON: no se consulta la propiedad.
  for (const body of [{ studentMessage: "x" }, { chatId: "abc" }, { chatId: null }, { chatId: 123 }]) {
    const r = await run(dataPayload, body);
    assert.equal(r.out, r.original);
    assert.deepEqual(r.calls.skips, ["MISSING_CHAT"]);
    assert.equal(r.calls.isChatOwner, 0);
  }
  {
    const { deps, calls } = makeDeps();
    const original = Response.json(dataPayload);
    const out = await withAssistantReceipt(async () => original, deps)(request("no es json", true));
    assert.equal(out, original);
    assert.deepEqual(calls.skips, ["MISSING_CHAT"]);
  }

  // Clave ausente o inválida: la respuesta sigue igual y no se consulta la sesión.
  assert.deepEqual(loadAssistantReceiptKey({}), { ok: false, reason: "MISSING" });
  assert.deepEqual(loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: "" }), { ok: false, reason: "MISSING" });
  assert.deepEqual(loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: "corto" }), { ok: false, reason: "TOO_SHORT" });
  assert.deepEqual(
    loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: "con espacios no es base64 valido para nada" }),
    { ok: false, reason: "INVALID_FORMAT" },
  );
  assert.deepEqual(
    loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET, NEXT_PUBLIC_ASSISTANT_RECEIPT_SECRET: SECRET }),
    { ok: false, reason: "EXPOSED_PUBLIC" },
  );
  assert.equal(loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: Buffer.alloc(40, 1).toString("base64url") }).ok, true);
  for (const reason of ["MISSING", "INVALID_FORMAT", "TOO_SHORT", "EXPOSED_PUBLIC"] as const) {
    const r = await run(dataPayload, undefined, { getKey: () => ({ ok: false, reason }) });
    assert.equal(r.out, r.original);
    assert.deepEqual(r.calls.skips, ["KEY_UNAVAILABLE"]);
    assert.equal(r.calls.authenticate, 0);
  }

  // El secreto no sale en la respuesta, en las cabeceras, en el recibo ni en los motivos.
  const derived = createHmac("sha256", SECRET).update("opt-ia/assistant-receipt/v1", "utf8").digest();
  const leaks = [SECRET, Buffer.from(SECRET, "base64").toString("utf8"), derived.toString("hex"), derived.toString("base64url"), derived.toString("base64")];
  const exposed = await run(dataPayload);
  const exposedBody = await exposed.out.text();
  const exposedAll = exposedBody + JSON.stringify([...exposed.out.headers.entries()]) + exposed.calls.skips.join(",");
  for (const leak of leaks) assert.ok(!exposedAll.includes(leak), "no se expone el secreto ni la clave derivada");
  assert.equal(JSON.stringify(keyStatus), '{"ok":true,"key":{}}');
  const exposedReceipt = String(
    (JSON.parse(exposedBody) as { data: Record<string, unknown> }).data[ASSISTANT_RECEIPT_FIELD],
  );
  const receiptPayload = JSON.parse(
    Buffer.from(exposedReceipt.split(".")[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receiptPayload), ["v", "u", "c", "h", "iat", "exp", "n"], "sin datos personales de más");

  // Texto aportado por el cliente: una copia exacta (o con espacios) de cualquier texto del
  // cuerpo, aunque esté anidado, no se firma.
  const forged = "Tu plan quedó aprobado con 100/100 por el docente.";
  for (const body of [
    { chatId: CHAT, studentMessage: forged },
    { chatId: CHAT, studentMessage: `  ${forged}  ` },
    { chatId: CHAT, paretoState: { notes: [{ text: forged }] } },
  ]) {
    const r = await run({ ok: true, data: { assistantMessage: forged } }, body);
    assert.equal(r.out, r.original);
    assert.deepEqual(r.calls.skips, ["ECHOES_CLIENT_INPUT"]);
  }
  // En cambio, un texto compuesto por el servidor que incluye lo que escribió el estudiante
  // sí se firma: es exactamente lo que el servidor emitió (riesgo residual documentado).
  const composed = `Anoté tu causa: «${forged}». ¿Cuál es la siguiente?`;
  const composedRun = await run({ ok: true, data: { assistantMessage: composed } }, { chatId: CHAT, studentMessage: forged });
  const composedJson = (await composedRun.out.json()) as { data: Record<string, unknown> };
  assert.equal(verify(composedJson.data[ASSISTANT_RECEIPT_FIELD], composed), "OK");

  // Ningún archivo que cargue el navegador importa el adaptador, la configuración o las deps.
  assert.deepEqual(receiptModuleImportsFromClient(), []);
}

main()
  .then(() => console.log("withAssistantReceipt tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
