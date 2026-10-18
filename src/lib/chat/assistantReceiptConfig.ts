// src/lib/chat/assistantReceiptConfig.ts

// Clave de los recibos de respuestas del asesor (R1), leída de ASSISTANT_RECEIPT_SECRET.
//
// Reglas del secreto:
//   - Exclusivo del servidor: nunca con prefijo NEXT_PUBLIC_ (Next.js lo incrustaría en el
//     bundle del navegador). Si existe NEXT_PUBLIC_ASSISTANT_RECEIPT_SECRET se rechaza todo,
//     porque el secreto ya estaría expuesto.
//   - Propio de este uso: no se deriva de SUPABASE_SERVICE_ROLE_KEY ni de otra clave.
//   - Formato: base64 o base64url sin espacios que decodifique a 32 bytes o más. Por ejemplo
//     `openssl rand -base64 48`. Un secreto distinto por entorno (Production y Preview).
//
// Si falta o no es válido, loadAssistantReceiptKey devuelve { ok: false, reason } y nada
// lanza: quien use la clave (withAssistantReceipt) deja la respuesta como estaba, sin
// recibo, y la conversación sigue funcionando. Ni el valor ni la clave derivada salen de
// este módulo en mensajes o errores; solo el motivo.
//
// Este archivo no crea ni lee .env: solo mira el objeto de entorno que recibe (process.env
// por defecto). Los tests le pasan su propio objeto con secretos de prueba.

import { createAssistantReceiptKey, type AssistantReceiptKey } from "@/lib/chat/assistantReceipt";

export const ASSISTANT_RECEIPT_SECRET_ENV = "ASSISTANT_RECEIPT_SECRET";
export const MIN_ASSISTANT_RECEIPT_SECRET_DECODED_BYTES = 32;

export type AssistantReceiptKeyUnavailable =
  | "MISSING"
  | "INVALID_FORMAT"
  | "TOO_SHORT"
  | "EXPOSED_PUBLIC";

export type AssistantReceiptKeyStatus =
  | { ok: true; key: AssistantReceiptKey }
  | { ok: false; reason: AssistantReceiptKeyUnavailable };

type Env = Readonly<Record<string, string | undefined>>;

const BASE64_SECRET = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function loadAssistantReceiptKey(env: Env = process.env): AssistantReceiptKeyStatus {
  if (typeof window !== "undefined") {
    throw new Error("assistantReceiptConfig solo puede usarse en el servidor.");
  }

  if (env[`NEXT_PUBLIC_${ASSISTANT_RECEIPT_SECRET_ENV}`] !== undefined) {
    return { ok: false, reason: "EXPOSED_PUBLIC" };
  }

  const secret = env[ASSISTANT_RECEIPT_SECRET_ENV];
  if (secret === undefined || secret === "") return { ok: false, reason: "MISSING" };
  if (!BASE64_SECRET.test(secret)) return { ok: false, reason: "INVALID_FORMAT" };

  const decoded = Buffer.from(secret, /[+/=]/.test(secret) ? "base64" : "base64url");
  if (decoded.length < MIN_ASSISTANT_RECEIPT_SECRET_DECODED_BYTES) {
    return { ok: false, reason: "TOO_SHORT" };
  }

  return { ok: true, key: createAssistantReceiptKey(secret) };
}

// Una sola lectura por proceso: el entorno de una función de servidor no cambia en marcha.
let cached: AssistantReceiptKeyStatus | null = null;

export function getAssistantReceiptKey(): AssistantReceiptKeyStatus {
  if (cached === null) cached = loadAssistantReceiptKey();
  return cached;
}
