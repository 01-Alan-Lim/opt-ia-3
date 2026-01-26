// src/lib/auth/supabase.ts

import { supabaseServer } from "@/lib/supabaseServer";

export type UserRole = "student" | "teacher";

export type AuthedUser = {
  userId: string;
  email?: string | null;
  role: UserRole;
};

function getBearerToken(req: Request): string {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new Error("UNAUTHORIZED");

  const token = auth.slice("Bearer ".length).trim();
  if (!token) throw new Error("UNAUTHORIZED");

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

/**
 * Requiere usuario autenticado via Supabase.
 * Espera: Authorization: Bearer <access_token>
 */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const token = getBearerToken(req);

  const { data, error } = await supabaseServer.auth.getUser(token);
  if (error || !data?.user) throw new Error("UNAUTHORIZED");

  const email = data.user.email ?? null;
  const emailLower = (email ?? "").toLowerCase();

  if (!emailLower) throw new Error("UNAUTHORIZED");

  // 1) Allowlist docente (puede incluir gmail)
  const teacherAllowlist = parseList(process.env.TEACHER_EMAIL_ALLOWLIST);
  const isTeacher = teacherAllowlist.includes(emailLower);
  if (isTeacher) {
    return { userId: data.user.id, email, role: "teacher" };
  }

  // 2) Estudiantes de prueba (gmail específicos)
  const studentTestAllowlist = parseList(process.env.STUDENT_TEST_EMAIL_ALLOWLIST);
  const isStudentTest = studentTestAllowlist.includes(emailLower);

  // 3) Restricción por dominio institucional para estudiantes
  const allowedDomain = normalizeDomain(process.env.ALLOWED_EMAIL_DOMAIN); // "umsa.bo"
  const isInstitutional = allowedDomain ? emailLower.endsWith(`@${allowedDomain}`) : true;

  if (!isInstitutional && !isStudentTest) {
    throw new Error("FORBIDDEN_DOMAIN");
  }

  return { userId: data.user.id, email, role: "student" };
}
