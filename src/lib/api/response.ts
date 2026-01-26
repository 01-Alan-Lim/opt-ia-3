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
  | "ACCESS_EXPIRED";


export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

/**
 * fail() SOLO construye el payload (objeto).
 * Úsalo con failResponse(...) o NextResponse.json(fail(...), {status})
 */
export function fail(code: ApiErrorCode, message: string, details: unknown = null) {
  return { ok: false, code, message, details };
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
