// src/lib/auth/studentEmailAuthorization.ts
//
// Quién puede entrar como estudiante (lo usa requireUser):
//   - correo del dominio institucional (ALLOWED_EMAIL_DOMAIN, p. ej. umsa.bo): sí;
//   - otro correo con una autorización activa de un docente (student_email_authorizations): sí;
//   - otro correo revocado (filas en la tabla, ninguna activa): NO, aunque siga en
//     STUDENT_TEST_EMAIL_ALLOWLIST. La revocación prevalece sobre la variable heredada;
//   - otro correo sin filas: solo si está en STUDENT_TEST_EMAIL_ALLOWLIST (transición);
//   - si la tabla todavía no existe (M3 sin aplicar), cuenta solo la variable heredada.
// Entrar no es estar aprobado: /api/me sigue exigiendo onboarding y aprobación docente.
//
// La consulta a la base solo se hace para correos no institucionales y se guarda 30 s por
// instancia (los docentes la invalidan al autorizar o revocar). Un error de la base que no sea
// "la tabla no existe" falla cerrado.

import { supabaseServer } from "@/lib/supabaseServer";

export type StudentEmailLookup = "active" | "revoked" | "none" | "unavailable";

export type StudentAccessDecision =
  | { allowed: true; via: "institutional" | "authorized" | "legacy_env" }
  | { allowed: false; via: "revoked" | "not_authorized" };

export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

// Sin dominio configurado no hay restricción (comportamiento de siempre).
export function isInstitutionalEmail(email: string, allowedDomain: string | null): boolean {
  if (!allowedDomain) return true;
  return normalizeEmail(email).endsWith(`@${allowedDomain}`);
}

export function decideStudentAccess(input: {
  institutional: boolean;
  lookup: StudentEmailLookup;
  envAllowlisted: boolean;
}): StudentAccessDecision {
  if (input.institutional) return { allowed: true, via: "institutional" };
  if (input.lookup === "active") return { allowed: true, via: "authorized" };
  if (input.lookup === "revoked") return { allowed: false, via: "revoked" };
  if (input.envAllowlisted) return { allowed: true, via: "legacy_env" };
  return { allowed: false, via: "not_authorized" };
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: StudentEmailLookup; expires: number }>();

export function clearStudentEmailAuthorizationCache(email?: string): void {
  if (email) cache.delete(normalizeEmail(email));
  else cache.clear();
}

function isMissingTable(error: { code?: string | null; message?: string | null }): boolean {
  const code = error.code ?? "";
  const message = error.message ?? "";
  return code === "PGRST205" || code === "42P01" || /Could not find the table|does not exist/i.test(message);
}

export async function lookupStudentEmailAuthorization(rawEmail: string, now: number = Date.now()): Promise<StudentEmailLookup> {
  const email = normalizeEmail(rawEmail);
  const hit = cache.get(email);
  if (hit && hit.expires > now) return hit.value;

  const { data, error } = await supabaseServer
    .from("student_email_authorizations")
    .select("id, revoked_at")
    .eq("email", email)
    .limit(50);

  let value: StudentEmailLookup;
  if (error) {
    if (!isMissingTable(error)) throw new Error("AUTHORIZATION_LOOKUP_FAILED");
    value = "unavailable";
  } else {
    const rows = (data ?? []) as Array<{ revoked_at: string | null }>;
    value = rows.some((r) => r.revoked_at === null) ? "active" : rows.length > 0 ? "revoked" : "none";
  }

  cache.set(email, { value, expires: now + CACHE_TTL_MS });
  return value;
}

// Decisión para varios correos a la vez, sin caché (la usa la sincronización de invitaciones de
// Calendar: solo se invita a quien hoy podría entrar). Mismas reglas que requireUser. Un error de
// la base que no sea "la tabla no existe" lanza: quien llama no debe cancelar nada con datos
// dudosos.
export function allowedEmailDomain(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const v = normalizeEmail(env.ALLOWED_EMAIL_DOMAIN);
  if (!v) return null;
  return v.startsWith("@") ? v.slice(1) : v;
}

function envList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((e) => normalizeEmail(e)).filter(Boolean);
}

export async function decideStudentAccessForEmails(rawEmails: string[]): Promise<Map<string, StudentAccessDecision>> {
  const domain = allowedEmailDomain();
  const legacy = new Set(envList(process.env.STUDENT_TEST_EMAIL_ALLOWLIST));
  const emails = [...new Set(rawEmails.map((e) => normalizeEmail(e)).filter(Boolean))];
  const external = emails.filter((e) => !isInstitutionalEmail(e, domain));

  const lookups = new Map<string, StudentEmailLookup>();
  if (external.length > 0) {
    const { data, error } = await supabaseServer
      .from("student_email_authorizations")
      .select("email, revoked_at")
      .in("email", external)
      .limit(5000);
    if (error) {
      if (!isMissingTable(error)) throw new Error("AUTHORIZATION_LOOKUP_FAILED");
      for (const e of external) lookups.set(e, "unavailable");
    } else {
      const rows = (data ?? []) as Array<{ email: string; revoked_at: string | null }>;
      for (const e of external) {
        const mine = rows.filter((r) => r.email === e);
        lookups.set(e, mine.some((r) => r.revoked_at === null) ? "active" : mine.length > 0 ? "revoked" : "none");
      }
    }
  }

  const decisions = new Map<string, StudentAccessDecision>();
  for (const e of emails) {
    decisions.set(
      e,
      decideStudentAccess({
        institutional: isInstitutionalEmail(e, domain),
        lookup: lookups.get(e) ?? "none",
        envAllowlisted: legacy.has(e),
      }),
    );
  }
  return decisions;
}
