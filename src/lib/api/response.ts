// src/lib/api/response.ts
import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "FORBIDDEN_DOMAIN"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "INTERNAL"
  | "CONFLICT"
  | "PROFILE_UPSERT_FAILED"
  | "NEEDS_ONBOARDING"
  | "PENDING_APPROVAL"
  | "COHORT_INACTIVE"
  | "ACCESS_NOT_STARTED"
  | "ACCESS_EXPIRED"
  | "PAYLOAD_TOO_LARGE"
  | "AUTH_UPSTREAM_TIMEOUT"
  | "FORBIDDEN_IN_PRODUCTION"
  // La ruta existe pero no atiende esa etapa (p. ej. el estado de E4 se guarda por
  // /api/plans/ishikawa/state, que es quien protege sus campos de autoridad).
  | "STAGE_NOT_ALLOWED"
  // Panel docente (GET /api/teacher/dashboard).
  | "INVALID_QUERY"
  | "COHORT_NOT_FOUND"
  | "INTERNAL_ERROR"
  // POST /api/messages (R1): respuesta assistant sin recibo, con recibo que no verifica, sin
  // clave de verificación en el servidor, o base sin la migración M2.
  | "ASSISTANT_RECEIPT_REQUIRED"
  | "ASSISTANT_RECEIPT_INVALID"
  | "RECEIPT_KEY_UNAVAILABLE"
  | "SCHEMA_NOT_READY"
  // Ruta retirada que se conserva para responder de forma explícita
  // (POST /api/chats/[chatId]/clear).
  | "GONE"
  // Calendario organizador (/api/teacher/calendar-organizer): falta configurar el cliente OAuth o
  // la clave de cifrado, o Google rechazó la operación.
  | "CALENDAR_NOT_CONFIGURED"
  | "GOOGLE_ERROR"
  // Etapa 0 (/api/plans/context y context/confirm): un valor que no es un dato del caso
  // (stage0Values.ts). context/interpret: Gemini no devolvió una lectura válida.
  | "INVALID_CONTEXT_VALUE"
  | "INTERPRET_UNREADABLE";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

/**
 * fail() SOLO construye el payload (objeto).
 * Úsalo con failResponse(...) o NextResponse.json(fail(...), {status})
 */
export function fail(code: ApiErrorCode, message: string, details: unknown = null) {
  if (details !== null && details !== undefined) {
    console.error(`[api] ${code}: ${message}`, details);
  }
  return { ok: false, code, message };
}

/**
 * failResponse() devuelve una Response válida para Route Handlers.
 */
export function failResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  details: unknown = null
) {
  return NextResponse.json(fail(code, message, details), { status });
}
