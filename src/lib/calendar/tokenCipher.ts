// src/lib/calendar/tokenCipher.ts
//
// Cifrado del refresh token de la cuenta organizadora de Google Calendar (calendar_organizer,
// M3). Solo servidor. AES-256-GCM con una clave propia, CALENDAR_TOKEN_ENCRYPTION_KEY (base64 de
// exactamente 32 bytes), distinta de cualquier otro secreto: la base guarda solo el texto
// cifrado y sin la clave no sirve. Formato: v1.<iv>.<cifrado>.<etiqueta>, en base64url.
//
// Si existe NEXT_PUBLIC_CALENDAR_TOKEN_ENCRYPTION_KEY la clave se rechaza: Next.js la incrustaría
// en el código del navegador.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CALENDAR_TOKEN_KEY_ENV = "CALENDAR_TOKEN_ENCRYPTION_KEY";

const VERSION = "v1";
const AAD = Buffer.from("opt-ia/calendar-organizer/refresh-token/v1", "utf8");
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const PART = /^[A-Za-z0-9_-]+$/;

export type CalendarTokenKey = { readonly __brand: "CalendarTokenKey" };

export type CalendarTokenKeyStatus =
  | { ok: true; key: CalendarTokenKey }
  | { ok: false; reason: "MISSING" | "INVALID_FORMAT" | "WRONG_LENGTH" | "EXPOSED_PUBLIC" };

const material = new WeakMap<CalendarTokenKey, Buffer>();

function assertServerRuntime(): void {
  if (typeof window !== "undefined") throw new Error("tokenCipher solo puede usarse en el servidor.");
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadCalendarTokenKey(env: Env = process.env): CalendarTokenKeyStatus {
  assertServerRuntime();
  if (env[`NEXT_PUBLIC_${CALENDAR_TOKEN_KEY_ENV}`] !== undefined) return { ok: false, reason: "EXPOSED_PUBLIC" };
  const raw = (env[CALENDAR_TOKEN_KEY_ENV] ?? "").trim();
  if (!raw) return { ok: false, reason: "MISSING" };
  if (!BASE64.test(raw)) return { ok: false, reason: "INVALID_FORMAT" };
  const bytes = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== KEY_BYTES) return { ok: false, reason: "WRONG_LENGTH" };
  const key = Object.freeze({}) as CalendarTokenKey;
  material.set(key, bytes);
  return { ok: true, key };
}

let cached: CalendarTokenKeyStatus | null = null;

export function getCalendarTokenKey(): CalendarTokenKeyStatus {
  if (cached === null) cached = loadCalendarTokenKey();
  return cached;
}

function keyBytes(key: CalendarTokenKey): Buffer {
  const bytes = material.get(key);
  if (!bytes) throw new TypeError("Clave de cifrado inválida.");
  return bytes;
}

export function encryptRefreshToken(key: CalendarTokenKey, plaintext: string): string {
  assertServerRuntime();
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new TypeError("Token vacío.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

// null si el texto no tiene el formato, se manipuló o se cifró con otra clave.
export function decryptRefreshToken(key: CalendarTokenKey, sealed: unknown): string | null {
  assertServerRuntime();
  if (typeof sealed !== "string") return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => PART.test(p))) return null;
  const iv = Buffer.from(parts[1], "base64url");
  const ciphertext = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
