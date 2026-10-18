// src/lib/chat/assistantReceipt.ts

// Recibos de autenticidad para respuestas del asesor emitidas por el servidor (riesgo R1).
//
// Problema: el asesor guarda sus respuestas desde el navegador, así que hoy el dueño de un
// chat puede guardar como "assistant" un texto que el modelo no escribió. La idea es que el
// servidor, al generar una respuesta, emita un recibo firmado que vincula ese texto exacto al
// usuario y al chat; al guardar, el servidor solo aceptará "assistant" con un recibo válido.
//
// Este módulo SOLO firma y verifica. No está conectado a ninguna ruta todavía.
//
// Formato v1 (todo base64url sin relleno):
//   ar1.<payload>.<firma>
//   payload = JSON {"v":1,"u":userId,"c":chatId,"h":sha256(contenido),"iat":s,"exp":s,"n":nonce}
//   firma   = HMAC-SHA256(claveDerivada, "ar1." + payload)   -> 32 bytes, 43 caracteres
// El recibo no contiene el texto, solo su hash, y la firma cubre el payload ya codificado,
// así que no hay ambigüedad de serialización al verificar.
//
// Clave: viene de un secreto propio de este uso, exclusivo del servidor, que quien integre el
// módulo inyecta (createAssistantReceiptKey). Este módulo no lee variables de entorno ni
// deriva nada de otras claves. Del secreto se deriva una clave por versión de formato
// (separación de dominio), y el material queda fuera del objeto que se pasa de mano en mano:
// JSON.stringify de la clave devuelve "{}".
//
// Identidad: userId tiene que salir de requireUser en el servidor, nunca del cuerpo de la
// petición. chatId puede venir del cliente, pero quien integre debe haber comprobado antes
// que el chat es de ese usuario.
//
// Reutilización (LIMITACIÓN): el nonce identifica cada recibo, pero el módulo no guarda
// estado, así que un recibo válido se puede verificar más de una vez hasta que caduca. Eso
// NO es un recibo de un solo uso: evitar que la misma respuesta se guarde dos veces es
// responsabilidad de quien integre y todavía no tiene diseño. La caducidad corta solo limita
// la ventana.
//
// No importar desde componentes de cliente: usa node:crypto, la clave nunca debe llegar al
// navegador y las funciones fallan si se ejecutan con window definido.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const ASSISTANT_RECEIPT_VERSION = 1 as const;
export const ASSISTANT_RECEIPT_PREFIX = "ar1";
export const DEFAULT_RECEIPT_TTL_SECONDS = 15 * 60;
export const MAX_RECEIPT_TTL_SECONDS = 60 * 60;
// Tolerancia para un iat ligeramente en el futuro (relojes de instancias distintas).
export const RECEIPT_CLOCK_SKEW_SECONDS = 60;
export const MIN_RECEIPT_SECRET_BYTES = 32;

const MAX_RECEIPT_LENGTH = 2048;
const SIGNATURE_BYTES = 32;
const KEY_DERIVATION_LABEL = "opt-ia/assistant-receipt/v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export type AssistantReceiptKey = { readonly __brand: "AssistantReceiptKey" };

export type AssistantReceiptClaims = {
  userId: string;
  chatId: string;
  content: string;
};

export type AssistantReceiptRejection =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "BAD_SIGNATURE"
  | "INVALID_EXPIRY"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "USER_MISMATCH"
  | "CHAT_MISMATCH"
  | "CONTENT_MISMATCH";

export type AssistantReceiptVerification =
  | { ok: true; receiptId: string; issuedAt: number; expiresAt: number }
  | { ok: false; reason: AssistantReceiptRejection };

const keyMaterial = new WeakMap<AssistantReceiptKey, Buffer>();

const ClaimsSchema = z.object({
  userId: z.string().uuid(),
  chatId: z.string().uuid(),
  content: z.string().min(1),
});

const PayloadSchema = z
  .object({
    v: z.number().int(),
    u: z.string().uuid(),
    c: z.string().uuid(),
    h: z.string().regex(/^[0-9a-f]{64}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    n: z.string().regex(NONCE),
  })
  .strict();

function assertServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new Error("assistantReceipt solo puede usarse en el servidor.");
  }
}

function macKeyOf(key: AssistantReceiptKey): Buffer {
  const mac = keyMaterial.get(key);
  if (!mac) throw new TypeError("Clave de recibo inválida.");
  return mac;
}

function sha256(content: string): Buffer {
  return createHash("sha256").update(content, "utf8").digest();
}

function sign(mac: Buffer, signedPart: string): Buffer {
  return createHmac("sha256", mac).update(signedPart, "utf8").digest();
}

// Decodifica base64url exigiendo la forma canónica (sin relleno ni caracteres de más).
function decodeBase64Url(part: string): Buffer | null {
  if (!BASE64URL.test(part)) return null;
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

export function createAssistantReceiptKey(secret: string): AssistantReceiptKey {
  assertServerRuntime();
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_RECEIPT_SECRET_BYTES) {
    throw new TypeError(
      `El secreto de recibos debe tener al menos ${MIN_RECEIPT_SECRET_BYTES} bytes.`,
    );
  }
  const handle = Object.freeze({}) as AssistantReceiptKey;
  keyMaterial.set(handle, createHmac("sha256", secret).update(KEY_DERIVATION_LABEL, "utf8").digest());
  return handle;
}

export function signAssistantReceipt(
  key: AssistantReceiptKey,
  claims: AssistantReceiptClaims,
  options: { now?: number; ttlSeconds?: number; nonce?: string } = {},
): string {
  assertServerRuntime();
  const mac = macKeyOf(key);

  const parsed = ClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    throw new TypeError("Datos inválidos para firmar el recibo (userId, chatId o contenido).");
  }

  const ttl = options.ttlSeconds ?? DEFAULT_RECEIPT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_RECEIPT_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds debe ser un entero entre 1 y ${MAX_RECEIPT_TTL_SECONDS}.`);
  }

  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  if (!NONCE.test(nonce)) throw new TypeError("Nonce de recibo inválido.");

  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = JSON.stringify({
    v: ASSISTANT_RECEIPT_VERSION,
    u: parsed.data.userId,
    c: parsed.data.chatId,
    h: sha256(parsed.data.content).toString("hex"),
    iat,
    exp: iat + ttl,
    n: nonce,
  });

  const payloadPart = Buffer.from(payload, "utf8").toString("base64url");
  const signedPart = `${ASSISTANT_RECEIPT_PREFIX}.${payloadPart}`;
  return `${signedPart}.${sign(mac, signedPart).toString("base64url")}`;
}

export function verifyAssistantReceipt(
  key: AssistantReceiptKey,
  receipt: unknown,
  expected: AssistantReceiptClaims,
  options: { now?: number } = {},
): AssistantReceiptVerification {
  assertServerRuntime();
  const mac = macKeyOf(key);

  if (typeof receipt !== "string" || receipt.length === 0 || receipt.length > MAX_RECEIPT_LENGTH) {
    return { ok: false, reason: "MALFORMED" };
  }

  const parts = receipt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };
  const [prefix, payloadPart, signaturePart] = parts;

  if (prefix !== ASSISTANT_RECEIPT_PREFIX) {
    return { ok: false, reason: /^ar\d+$/.test(prefix) ? "UNSUPPORTED_VERSION" : "MALFORMED" };
  }

  const payloadBytes = decodeBase64Url(payloadPart);
  if (!payloadBytes) return { ok: false, reason: "MALFORMED" };

  // La firma se compara antes de mirar el contenido del payload.
  const provided = decodeBase64Url(signaturePart);
  if (!provided || provided.length !== SIGNATURE_BYTES) return { ok: false, reason: "BAD_SIGNATURE" };
  if (!timingSafeEqual(sign(mac, `${prefix}.${payloadPart}`), provided)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const payload = PayloadSchema.safeParse(json);
  if (!payload.success) return { ok: false, reason: "MALFORMED" };
  const { v, u, c, h, iat, exp, n } = payload.data;

  if (v !== ASSISTANT_RECEIPT_VERSION) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  if (exp <= iat || exp - iat > MAX_RECEIPT_TTL_SECONDS) return { ok: false, reason: "INVALID_EXPIRY" };

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (iat > nowSeconds + RECEIPT_CLOCK_SKEW_SECONDS) return { ok: false, reason: "NOT_YET_VALID" };
  if (nowSeconds >= exp) return { ok: false, reason: "EXPIRED" };

  if (typeof expected.userId !== "string" || expected.userId !== u) {
    return { ok: false, reason: "USER_MISMATCH" };
  }
  if (typeof expected.chatId !== "string" || expected.chatId !== c) {
    return { ok: false, reason: "CHAT_MISMATCH" };
  }
  if (
    typeof expected.content !== "string" ||
    !timingSafeEqual(sha256(expected.content), Buffer.from(h, "hex"))
  ) {
    return { ok: false, reason: "CONTENT_MISMATCH" };
  }

  return { ok: true, receiptId: n, issuedAt: iat, expiresAt: exp };
}
