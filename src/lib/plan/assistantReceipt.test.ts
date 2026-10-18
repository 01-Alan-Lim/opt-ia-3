import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  createAssistantReceiptKey,
  DEFAULT_RECEIPT_TTL_SECONDS,
  MAX_RECEIPT_TTL_SECONDS,
  RECEIPT_CLOCK_SKEW_SECONDS,
  signAssistantReceipt,
  verifyAssistantReceipt,
  type AssistantReceiptClaims,
  type AssistantReceiptKey,
} from "../chat/assistantReceipt";

// Recibos de autenticidad de respuestas del asesor (R1). Lógica pura, sin I/O.
//
// Los secretos son solo de prueba y viven aquí, nunca en el módulo. forge() reproduce el
// formato v1 documentado en assistantReceipt.ts para fabricar casos que la API pública no
// produce (payload bien firmado con versión desconocida, fechas incoherentes, campos de más);
// también sirve de comprobación del formato.

const SECRET = "test-secret-assistant-receipt-0123456789abcdef";
const OTHER_SECRET = "otro-secreto-de-prueba-assistant-receipt-zyxwvut";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CHAT = "33333333-3333-4333-8333-333333333333";
const OTHER_CHAT = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const REPLY = "Bien, ahora prioricemos tus causas con el criterio de **frecuencia**.\n\n¿Cuál ocurre más?";

const claims: AssistantReceiptClaims = { userId: USER, chatId: CHAT, content: REPLY };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function forge(secret: string, payload: Record<string, unknown>, prefix = "ar1"): string {
  const mac = createHmac("sha256", secret).update("opt-ia/assistant-receipt/v1", "utf8").digest();
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signedPart = `${prefix}.${payloadPart}`;
  return `${signedPart}.${createHmac("sha256", mac).update(signedPart, "utf8").digest("base64url")}`;
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    u: USER,
    c: CHAT,
    h: sha256Hex(REPLY),
    iat: NOW_S,
    exp: NOW_S + DEFAULT_RECEIPT_TTL_SECONDS,
    n: "nonce-de-prueba-0001",
    ...overrides,
  };
}

function reasonOf(key: AssistantReceiptKey, receipt: unknown, expected = claims, now = NOW): string {
  const result = verifyAssistantReceipt(key, receipt, expected, { now });
  return result.ok ? "OK" : result.reason;
}

function replaceAt(text: string, index: number): string {
  const ch = text[index] === "A" ? "B" : "A";
  return text.slice(0, index) + ch + text.slice(index + 1);
}

// Archivos que el navegador puede cargar: "use client", src/app/chat y src/components.
function clientFilesImportingReceipts(): string[] {
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
      if (!/assistantReceipt["']/.test(code)) continue;
      const isClient =
        /^\s*["']use client["']/m.test(code) ||
        rel.startsWith("src/app/chat/") ||
        rel.startsWith("src/components/");
      if (isClient) found.push(rel);
    }
  })("src");
  return found;
}

function main() {
  const key = createAssistantReceiptKey(SECRET);
  const otherKey = createAssistantReceiptKey(OTHER_SECRET);
  const receipt = signAssistantReceipt(key, claims, { now: NOW, nonce: "nonce-de-prueba-0001" });

  // Formato: ar1.<payload>.<firma de 43 caracteres>; el payload lleva el hash, no el texto.
  assert.match(receipt, /^ar1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const decoded = JSON.parse(
    Buffer.from(receipt.split(".")[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded), ["v", "u", "c", "h", "iat", "exp", "n"]);
  assert.equal(decoded.h, sha256Hex(REPLY));
  assert.equal(Number(decoded.exp) - Number(decoded.iat), DEFAULT_RECEIPT_TTL_SECONDS);
  assert.ok(!receipt.includes(Buffer.from("prioricemos").toString("base64url")));
  assert.equal(receipt, forge(SECRET, basePayload()), "el formato coincide con la especificación v1");

  // Firma válida.
  assert.deepEqual(verifyAssistantReceipt(key, receipt, claims, { now: NOW }), {
    ok: true,
    receiptId: "nonce-de-prueba-0001",
    issuedAt: NOW_S,
    expiresAt: NOW_S + DEFAULT_RECEIPT_TTL_SECONDS,
  });

  // Texto modificado: cualquier cambio, incluso invisible, rompe el recibo.
  for (const changed of [
    REPLY + " ",
    REPLY.replace("frecuencia", "Frecuencia"),
    REPLY.replace("\n\n", "\n"),
    "",
    "Tu plan está aprobado con 100/100.",
  ]) {
    assert.equal(reasonOf(key, receipt, { ...claims, content: changed }), "CONTENT_MISMATCH");
  }
  const composed = signAssistantReceipt(key, { ...claims, content: "Mejoró la producción" }, { now: NOW });
  assert.equal(
    reasonOf(key, composed, { ...claims, content: "Mejoró la producción".normalize("NFD") }),
    "CONTENT_MISMATCH",
    "no se normaliza Unicode: se firma el texto exacto",
  );

  // Usuario o chat diferente.
  assert.equal(reasonOf(key, receipt, { ...claims, userId: OTHER_USER }), "USER_MISMATCH");
  assert.equal(reasonOf(key, receipt, { ...claims, chatId: OTHER_CHAT }), "CHAT_MISMATCH");

  // Caducidad: vale hasta exp - 1, caduca en exp.
  assert.equal(reasonOf(key, receipt, claims, NOW + (DEFAULT_RECEIPT_TTL_SECONDS - 1) * 1000), "OK");
  assert.equal(reasonOf(key, receipt, claims, NOW + DEFAULT_RECEIPT_TTL_SECONDS * 1000), "EXPIRED");
  assert.equal(reasonOf(key, receipt, claims, NOW + 24 * 3600 * 1000), "EXPIRED");

  // Malformado.
  for (const bad of [undefined, null, 42, {}, "", "ar1", "ar1.", "ar1..", "a.b", "a.b.c.d", "x".repeat(3000), "ar1.***.***"]) {
    assert.equal(reasonOf(key, bad), "MALFORMED", `malformado: ${String(bad).slice(0, 20)}`);
  }
  const [prefix, payloadPart, signaturePart] = receipt.split(".");
  assert.equal(reasonOf(key, `${prefix}.${payloadPart}=.${signaturePart}`), "MALFORMED", "base64 no canónico");

  // Firma truncada, ausente o con longitud incorrecta.
  assert.equal(reasonOf(key, `${prefix}.${payloadPart}.${signaturePart.slice(0, 42)}`), "BAD_SIGNATURE");
  assert.equal(reasonOf(key, `${prefix}.${payloadPart}.${signaturePart.slice(0, 20)}`), "BAD_SIGNATURE");
  assert.equal(reasonOf(key, `${prefix}.${payloadPart}.${signaturePart}AA`), "BAD_SIGNATURE");
  assert.equal(reasonOf(key, receipt.slice(0, -1)), "BAD_SIGNATURE");

  // Firma o payload manipulados.
  assert.equal(reasonOf(key, `${prefix}.${payloadPart}.${replaceAt(signaturePart, 5)}`), "BAD_SIGNATURE");
  const swappedUser = Buffer.from(JSON.stringify(basePayload({ u: OTHER_USER })), "utf8").toString("base64url");
  assert.equal(
    reasonOf(key, `${prefix}.${swappedUser}.${signaturePart}`, { ...claims, userId: OTHER_USER }),
    "BAD_SIGNATURE",
    "cambiar el usuario dentro del payload invalida la firma",
  );

  // Clave distinta.
  assert.equal(reasonOf(otherKey, receipt), "BAD_SIGNATURE");
  assert.equal(reasonOf(key, forge(OTHER_SECRET, basePayload())), "BAD_SIGNATURE");

  // Versión desconocida: prefijo de otra versión o payload v2 bien firmado.
  assert.equal(reasonOf(key, receipt.replace(/^ar1\./, "ar2.")), "UNSUPPORTED_VERSION");
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ v: 2 }))), "UNSUPPORTED_VERSION");

  // Vencimiento inválido aunque la firma sea correcta.
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ exp: NOW_S }))), "INVALID_EXPIRY");
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ exp: NOW_S - 10 }))), "INVALID_EXPIRY");
  assert.equal(
    reasonOf(key, forge(SECRET, basePayload({ exp: NOW_S + MAX_RECEIPT_TTL_SECONDS + 1 }))),
    "INVALID_EXPIRY",
  );
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ exp: NOW_S + 10.5 }))), "MALFORMED");
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ exp: "mañana" }))), "MALFORMED");
  const future = NOW_S + RECEIPT_CLOCK_SKEW_SECONDS + 5;
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ iat: future, exp: future + 60 }))), "NOT_YET_VALID");
  assert.equal(reasonOf(key, forge(SECRET, basePayload({ extra: true }))), "MALFORMED", "sin campos de más");

  // Reutilización: el módulo no guarda estado, así que un recibo válido se verifica igual
  // las veces que haga falta hasta caducar. NO es de un solo uso; evitar duplicados es tarea
  // de quien integre (pendiente de diseño).
  const first = verifyAssistantReceipt(key, receipt, claims, { now: NOW });
  const second = verifyAssistantReceipt(key, receipt, claims, { now: NOW + 1000 });
  assert.ok(first.ok && second.ok);
  assert.equal(first.ok && second.ok && first.receiptId === second.receiptId, true);
  const a = signAssistantReceipt(key, claims, { now: NOW });
  const b = signAssistantReceipt(key, claims, { now: NOW });
  assert.notEqual(a, b, "cada firma lleva un nonce distinto");

  // Firmar exige datos válidos y un ttl acotado.
  assert.throws(() => signAssistantReceipt(key, { ...claims, userId: "no-uuid" }), TypeError);
  assert.throws(() => signAssistantReceipt(key, { ...claims, chatId: "" }), TypeError);
  assert.throws(() => signAssistantReceipt(key, { ...claims, content: "" }), TypeError);
  for (const ttl of [0, -1, 1.5, MAX_RECEIPT_TTL_SECONDS + 1]) {
    assert.throws(() => signAssistantReceipt(key, claims, { ttlSeconds: ttl }), RangeError);
  }
  assert.throws(() => signAssistantReceipt(key, claims, { nonce: "corto" }), TypeError);

  // Clave: secreto mínimo, objeto opaco y sin material serializable.
  assert.throws(() => createAssistantReceiptKey("demasiado-corto"), TypeError);
  assert.equal(JSON.stringify(key), "{}");
  assert.ok(Object.isFrozen(key));
  const fakeKey = Object.freeze({}) as AssistantReceiptKey;
  assert.throws(() => signAssistantReceipt(fakeKey, claims), TypeError);
  assert.throws(() => verifyAssistantReceipt(fakeKey, receipt, claims), TypeError);

  // Ningún archivo que pueda cargar el navegador importa este módulo.
  assert.deepEqual(clientFilesImportingReceipts(), []);
}

try {
  main();
  console.log("assistantReceipt tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
