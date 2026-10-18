import assert from "node:assert/strict";

import { signAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey, type AssistantReceiptKeyStatus } from "../chat/assistantReceiptConfig";
import { formatAdvisorReplyForChat } from "../chat/assistantFormat";
import {
  ADVISOR_CONTENT_MAX,
  CLIENT_MESSAGE_ROLES,
  decideMessageWrite,
  MESSAGE_CONTENT_MAX,
  parsePersistMessageBody,
  type MessageAccessGate,
  type MessageChat,
  type PersistMessageBody,
} from "../chat/messageWritePolicy";

// Política de POST /api/messages (R1). Lógica pura, sin I/O; es la misma función que usa la
// ruta. Cubre roles, dueño, gate académico, tipo de chat y la verificación criptográfica de las
// respuestas assistant: válida, falsificada, vencida, de otro usuario, de otro chat, con el
// texto cambiado, sin recibo y sin clave en el servidor.

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";
const CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const OPEN: MessageAccessGate = { ok: true };
const ADVISOR_CHAT: MessageChat = { ownerId: OWNER, mode: "plan_mejora" };
const GENERAL_CHAT: MessageChat = { ownerId: OWNER, mode: "general" };

const SECRET = Buffer.from("opt-ia: secreto de recibos para la politica de mensajes").toString("base64");
const keyStatus = loadAssistantReceiptKey({ ASSISTANT_RECEIPT_SECRET: SECRET });
assert.ok(keyStatus.ok);
const KEY = keyStatus.key;
const OTHER_KEY_STATUS = loadAssistantReceiptKey({
  ASSISTANT_RECEIPT_SECRET: Buffer.from("otro secreto distinto, de otro entorno, 32+ bytes").toString("base64"),
});
assert.ok(OTHER_KEY_STATUS.ok);
const OTHER_KEY = OTHER_KEY_STATUS.key;
const withKey = (): AssistantReceiptKeyStatus => keyStatus;
const noKey = (): AssistantReceiptKeyStatus => ({ ok: false, reason: "MISSING" });

const NOW = Date.parse("2026-10-18T15:00:00Z");
const ORIGINAL = "Entendido, Ana, registré tu avance: 1. Capacitación 2. Medición de tiempos";

function parse(input: unknown): PersistMessageBody {
  const result = parsePersistMessageBody(input);
  assert.ok(result.ok, "se esperaba un cuerpo válido: " + JSON.stringify(input));
  return result.body;
}
const accepts = (input: unknown) => parsePersistMessageBody(input).ok;

function receipt(overrides: { userId?: string; chatId?: string; content?: string; now?: number; ttlSeconds?: number } = {}) {
  return signAssistantReceipt(
    KEY,
    { userId: overrides.userId ?? OWNER, chatId: overrides.chatId ?? CHAT, content: overrides.content ?? ORIGINAL },
    { now: overrides.now ?? NOW, ttlSeconds: overrides.ttlSeconds },
  );
}

function assistantBody(serverReply?: { assistantMessage: string; assistantReceipt: string }, extra: Record<string, unknown> = {}) {
  return parse({ chatId: CHAT, role: "assistant", content: "lo que diga el cliente", ...(serverReply ? { serverReply } : {}), ...extra });
}

function decide(body: PersistMessageBody, opts: { chat?: MessageChat | null; gate?: MessageAccessGate; key?: () => AssistantReceiptKeyStatus; now?: number } = {}) {
  return decideMessageWrite({
    userId: OWNER,
    body,
    chat: opts.chat === undefined ? ADVISOR_CHAT : opts.chat,
    gate: opts.gate ?? OPEN,
    receiptKey: opts.key ?? withKey,
    now: opts.now ?? NOW,
  });
}

function main() {
  // ---------------- Esquema ----------------
  assert.deepEqual([...CLIENT_MESSAGE_ROLES], ["user", "assistant", "advisor"]);
  for (const forged of ["system", "System", "SYSTEM", "tool", "developer", "model", "", null, 1]) {
    const r = parsePersistMessageBody({ chatId: CHAT, role: forged, content: "Hola" });
    assert.equal(r.ok, false, `role ${String(forged)} debe rechazarse`);
    assert.ok(!r.ok && r.message.startsWith("role no permitido"));
  }
  assert.equal(accepts({ chatId: CHAT, content: "Hola" }), false, "role es obligatorio");
  assert.equal(accepts({ chatId: CHAT, role: "user", content: "" }), false);
  assert.equal(accepts({ chatId: CHAT, role: "user", content: "x".repeat(MESSAGE_CONTENT_MAX) }), true);
  assert.equal(accepts({ chatId: CHAT, role: "user", content: "x".repeat(MESSAGE_CONTENT_MAX + 1) }), false);
  assert.equal(accepts({ chatId: CHAT, role: "advisor", content: "x".repeat(ADVISOR_CONTENT_MAX) }), true);
  assert.equal(accepts({ chatId: CHAT, role: "advisor", content: "x".repeat(ADVISOR_CONTENT_MAX + 1) }), false);
  assert.equal(accepts({ chatId: "no-es-un-uuid", role: "user", content: "Hola" }), false);
  assert.equal(accepts({ chatId: CHAT, role: "user", content: "Hola", clientMessageId: "x" }), false);
  assert.equal(accepts({ chatId: CHAT, role: "assistant", serverReply: { assistantMessage: "x", assistantReceipt: "r".repeat(2049) } }), false);

  // ---------------- user y advisor ----------------
  const localText = "✅ Ya tienes **Etapa 1 (Productividad)** completada y validada.\n\n- Periodo: **2026-10**\n";
  assert.deepEqual(decide(parse({ chatId: CHAT, role: "user", content: "Hola" })), {
    ok: true,
    row: { chat_id: CHAT, role: "user", content: "Hola" },
  });
  assert.deepEqual(decide(parse({ chatId: CHAT, role: "advisor", content: localText, clientMessageId: CLIENT_ID })), {
    ok: true,
    row: { chat_id: CHAT, role: "advisor", content: localText, client_message_id: CLIENT_ID },
  }, "advisor se guarda tal cual, con su clave de idempotencia");
  // user también vale en un chat general; advisor y assistant solo en el del asesor.
  assert.equal(decide(parse({ chatId: CHAT, role: "user", content: "Hola" }), { chat: GENERAL_CHAT }).ok, true);
  for (const body of [parse({ chatId: CHAT, role: "advisor", content: localText }), assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt() })]) {
    assert.deepEqual(decide(body, { chat: GENERAL_CHAT }), {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Solo el chat del asesor admite mensajes del asesor.",
    });
  }

  // ---------------- Dueño y gate ----------------
  const userBody = parse({ chatId: CHAT, role: "user", content: "Hola" });
  assert.deepEqual(decide(userBody, { chat: null }), { ok: false, status: 404, code: "NOT_FOUND", message: "Chat no encontrado" });
  const strangerChat = { ok: false, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat" };
  assert.deepEqual(decide(userBody, { chat: { ownerId: STRANGER, mode: "plan_mejora" } }), strangerChat);
  assert.deepEqual(
    decide(userBody, { chat: { ownerId: STRANGER, mode: "plan_mejora" }, gate: { ok: false, reason: "ACCESS_EXPIRED", message: "expirado" } }),
    strangerChat,
    "el dueño se comprueba antes que el gate",
  );
  for (const reason of ["NEEDS_ONBOARDING", "PENDING_APPROVAL", "COHORT_INACTIVE", "ACCESS_NOT_STARTED", "ACCESS_EXPIRED"] as const) {
    assert.deepEqual(
      decide(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt() }), { gate: { ok: false, reason, message: `m-${reason}` } }),
      { ok: false, status: 403, code: reason, message: `m-${reason}` },
      "sin acceso académico ni un recibo válido sirve",
    );
  }

  // ---------------- assistant: recibo válido ----------------
  const valid = decide(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt() }));
  assert.ok(valid.ok);
  assert.equal(valid.row.role, "assistant");
  assert.equal(valid.row.content, formatAdvisorReplyForChat(ORIGINAL), "content lo formatea el servidor");
  assert.notEqual(valid.row.content, "lo que diga el cliente", "el content del cliente no se usa");
  assert.match(valid.row.receipt_nonce ?? "", /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(valid.row.client_message_id, undefined, "assistant se deduplica por recibo, no por clave del cliente");
  assert.deepEqual(Object.keys(valid.row).sort(), ["chat_id", "content", "receipt_nonce", "role"]);

  // ---------------- assistant: rechazos (nunca se rebaja a advisor) ----------------
  const rejected = (body: PersistMessageBody, opts: Parameters<typeof decide>[1] = {}) => {
    const d = decide(body, opts);
    assert.ok(!d.ok, "debía rechazarse");
    return d;
  };
  const invalid = (reason: string) => ({
    ok: false,
    status: 403,
    code: "ASSISTANT_RECEIPT_INVALID",
    message: `No se pudo verificar la respuesta del asesor (${reason}).`,
    receiptRejection: reason,
  });

  // Sin recibo: el ataque de R1 (texto propio con role assistant).
  assert.deepEqual(rejected(assistantBody()), {
    ok: false,
    status: 403,
    code: "ASSISTANT_RECEIPT_REQUIRED",
    message: "Una respuesta del asistente solo se guarda con el recibo del servidor que la emitió.",
  });
  // Texto modificado.
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL + " Y además apruebo tu etapa.", assistantReceipt: receipt() })), invalid("CONTENT_MISMATCH"));
  // Otro usuario, otro chat.
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt({ userId: STRANGER }) })), invalid("USER_MISMATCH"));
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt({ chatId: OTHER_CHAT }) })), invalid("CHAT_MISMATCH"));
  // Vencido (15 min por defecto) y emitido en el futuro.
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt() }), { now: NOW + 15 * 60 * 1000 }), invalid("EXPIRED"));
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt({ now: NOW + 10 * 60 * 1000 }) })), invalid("NOT_YET_VALID"));
  // Falsificado: firma cambiada, firmado con otra clave, basura.
  const genuine = receipt();
  const [prefix, payload, signature] = genuine.split(".");
  const flipped = `${prefix}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: flipped })), invalid("BAD_SIGNATURE"));
  const foreignKeyReceipt = signAssistantReceipt(OTHER_KEY, { userId: OWNER, chatId: CHAT, content: ORIGINAL }, { now: NOW });
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: foreignKeyReceipt })), invalid("BAD_SIGNATURE"));
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: "ar1.no.vale" })), invalid("MALFORMED"));
  // Payload reescrito con la firma original.
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), u: STRANGER }),
  ).toString("base64url");
  assert.deepEqual(rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: `${prefix}.${forgedPayload}.${signature}` })), invalid("BAD_SIGNATURE"));
  // Sin clave en el servidor: falla de forma segura y sin detalles del secreto.
  const keyless = rejected(assistantBody({ assistantMessage: ORIGINAL, assistantReceipt: receipt() }), { key: noKey });
  assert.equal(keyless.status, 503);
  assert.equal(keyless.code, "RECEIPT_KEY_UNAVAILABLE");
  assert.ok(!keyless.message.includes(SECRET));
}

try {
  main();
  console.log("messageWritePolicy tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
