// src/lib/auth/supabase.ts

import { supabaseServer } from "@/lib/supabaseServer";
import {
  decideStudentAccess,
  isInstitutionalEmail,
  lookupStudentEmailAuthorization,
  type StudentEmailLookup,
} from "@/lib/auth/studentEmailAuthorization";

export type UserRole = "student" | "teacher";

export type AuthedUser = {
  userId: string;
  email?: string | null;
  role: UserRole;
};

export type AuthFailureCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN_DOMAIN"
  | "AUTH_UPSTREAM_TIMEOUT"
  | "AUTH_UPSTREAM_ERROR";

class AuthError extends Error {
  readonly code: AuthFailureCode;
  override readonly cause?: unknown;

  constructor(code: AuthFailureCode, cause?: unknown) {
    super(code);
    this.name = "AuthError";
    this.code = code;
    this.cause = cause;
  }
}

function getBearerToken(req: Request): string {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new AuthError("UNAUTHORIZED");
  }

  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthError("UNAUTHORIZED");
  }

  return token;
}

function parseList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Permite ALLOWED_EMAIL_DOMAIN="umsa.bo" o "@umsa.bo"
function normalizeDomain(raw?: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  return v.startsWith("@") ? v.slice(1) : v;
}

function getErrorText(err: unknown): string {
  if (err instanceof Error) {
    const causeText =
      err.cause instanceof Error
        ? `${err.cause.name} ${err.cause.message}`
        : typeof err.cause === "string"
        ? err.cause
        : "";

    return `${err.name} ${err.message} ${causeText}`.toLowerCase();
  }

  return String(err ?? "").toLowerCase();
}

function isAuthUpstreamTimeout(err: unknown): boolean {
  const text = getErrorText(err);

  return (
    text.includes("connecttimeouterror") ||
    text.includes("und_err_connect_timeout") ||
    text.includes("fetch failed") ||
    text.includes("timeout")
  );
}

export function getAuthErrorCode(err: unknown): AuthFailureCode | null {
  if (err instanceof AuthError) return err.code;

  if (err instanceof Error) {
    if (err.message === "UNAUTHORIZED") return "UNAUTHORIZED";
    if (err.message === "FORBIDDEN_DOMAIN") return "FORBIDDEN_DOMAIN";
  }

  return null;
}

/**
 * Requiere usuario autenticado via Supabase.
 * Espera: Authorization: Bearer <access_token>
 */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const token = getBearerToken(req);

  let authData: Awaited<ReturnType<typeof supabaseServer.auth.getUser>>["data"] | null = null;
  let authError: Awaited<ReturnType<typeof supabaseServer.auth.getUser>>["error"] | null = null;

  try {
    const result = await supabaseServer.auth.getUser(token);
    authData = result.data;
    authError = result.error;
  } catch (err: unknown) {
    if (isAuthUpstreamTimeout(err)) {
      throw new AuthError("AUTH_UPSTREAM_TIMEOUT", err);
    }

    throw new AuthError("AUTH_UPSTREAM_ERROR", err);
  }

  if (authError || !authData?.user) {
    throw new AuthError("UNAUTHORIZED", authError);
  }

  const email = authData.user.email ?? null;
  const emailLower = (email ?? "").toLowerCase();

  if (!emailLower) {
    throw new AuthError("UNAUTHORIZED");
  }

  // 1) Allowlist docente (puede incluir gmail)
  const teacherAllowlist = parseList(process.env.TEACHER_EMAIL_ALLOWLIST);
  const isTeacher = teacherAllowlist.includes(emailLower);
  if (isTeacher) {
    return { userId: authData.user.id, email, role: "teacher" };
  }

  // 2) Dominio institucional: entra sin más consultas (la aprobación docente se exige aparte).
  const allowedDomain = normalizeDomain(process.env.ALLOWED_EMAIL_DOMAIN);
  if (isInstitutionalEmail(emailLower, allowedDomain)) {
    return { userId: authData.user.id, email, role: "student" };
  }

  // 3) Otro correo: autorización de un docente (la revocación manda) o, en transición, la lista
  //    heredada STUDENT_TEST_EMAIL_ALLOWLIST. Ver studentEmailAuthorization.ts.
  let lookup: StudentEmailLookup;
  try {
    lookup = await lookupStudentEmailAuthorization(emailLower);
  } catch (err: unknown) {
    throw new AuthError("AUTH_UPSTREAM_ERROR", err);
  }
  const studentTestAllowlist = parseList(process.env.STUDENT_TEST_EMAIL_ALLOWLIST);
  const decision = decideStudentAccess({
    institutional: false,
    lookup,
    envAllowlisted: studentTestAllowlist.includes(emailLower),
  });
  if (!decision.allowed) {
    throw new AuthError("FORBIDDEN_DOMAIN");
  }

  return { userId: authData.user.id, email, role: "student" };
}