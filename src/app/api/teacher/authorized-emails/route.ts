// src/app/api/teacher/authorized-emails/route.ts
//
// Correos personales (p. ej. Gmail) que un docente autoriza a entrar como estudiantes
// (student_email_authorizations, M3). Solo docentes: el rol lo resuelve requireUser en el
// servidor (TEACHER_EMAIL_ALLOWLIST), nunca el navegador.
//   GET    -> lista de autorizaciones (activas y revocadas) con el estado académico del perfil.
//   POST   -> { email, note? } autoriza. Idempotente: si ya hay una activa, la devuelve.
//   DELETE -> ?email= revoca. Si el correo solo estaba en la lista heredada del entorno, deja
//             una fila revocada: la revocación prevalece sobre STUDENT_TEST_EMAIL_ALLOWLIST.
// Autorizar no aprueba: el estudiante sigue pasando por onboarding y aprobación docente.

import { z } from "zod";

import { ok, failResponse } from "@/lib/api/response";
import { requireTeacher } from "@/lib/auth/requireTeacher";
import { syncStudentInvitationsByEmail } from "@/lib/calendar/invitationTriggers";
import {
  clearStudentEmailAuthorizationCache,
  isInstitutionalEmail,
  normalizeEmail,
} from "@/lib/auth/studentEmailAuthorization";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const EmailSchema = z
  .string()
  .max(254)
  .transform((v) => normalizeEmail(v))
  .refine((v) => EMAIL_PATTERN.test(v), { message: "Correo inválido." });

const PostSchema = z.object({
  email: EmailSchema,
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
});

type AuthorizationRow = {
  id: string;
  email: string;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
};

const SELECT = "id, email, note, created_at, revoked_at";

function allowedDomain(): string | null {
  const v = (process.env.ALLOWED_EMAIL_DOMAIN ?? "").trim().toLowerCase();
  if (!v) return null;
  return v.startsWith("@") ? v.slice(1) : v;
}

function tableUnavailable(): Response {
  return failResponse("INTERNAL", "Las autorizaciones no están disponibles todavía (falta preparar la base de datos).", 503);
}

export async function GET(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const { data, error } = await supabaseServer
    .from("student_email_authorizations")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) return tableUnavailable();

  const rows = (data ?? []) as AuthorizationRow[];
  const emails = [...new Set(rows.map((r) => r.email))];
  const statusByEmail = new Map<string, string | null>();
  if (emails.length > 0) {
    const { data: profiles } = await supabaseServer
      .from("profiles")
      .select("email, registration_status")
      .in("email", emails);
    for (const p of (profiles ?? []) as Array<{ email: string | null; registration_status: string | null }>) {
      if (p.email) statusByEmail.set(normalizeEmail(p.email), p.registration_status ?? "pending");
    }
  }

  return ok({
    items: rows.map((r) => ({
      id: r.id,
      email: r.email,
      note: r.note,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      active: r.revoked_at === null,
      registrationStatus: statusByEmail.get(r.email) ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return failResponse("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Datos inválidos.", 400);
  }
  const { email, note } = parsed.data;

  const domain = allowedDomain();
  if (domain && isInstitutionalEmail(email, domain)) {
    return failResponse("BAD_REQUEST", `Los correos @${domain} ya tienen acceso; no hace falta autorizarlos.`, 400);
  }

  const { data, error } = await supabaseServer
    .from("student_email_authorizations")
    .insert({ email, note, authorized_by: auth.user.userId })
    .select(SELECT)
    .single();

  if (error) {
    if (error.code !== "23505") return tableUnavailable();
    // Ya había una activa: la operación es idempotente.
    const { data: existing } = await supabaseServer
      .from("student_email_authorizations")
      .select(SELECT)
      .eq("email", email)
      .is("revoked_at", null)
      .maybeSingle();
    clearStudentEmailAuthorizationCache(email);
    return ok({ authorization: existing ?? null, created: false });
  }

  clearStudentEmailAuthorizationCache(email);
  // Si ya estaba aprobado (p. ej. se le había revocado y vuelve), recupera sus invitaciones.
  const calendar = await syncStudentInvitationsByEmail(email, new URL(req.url).origin);
  return ok({ authorization: data as AuthorizationRow, created: true, calendar });
}

export async function DELETE(req: Request) {
  const auth = await requireTeacher(req);
  if (!auth.ok) return auth.res;

  const parsed = EmailSchema.safeParse(new URL(req.url).searchParams.get("email") ?? "");
  if (!parsed.success) return failResponse("BAD_REQUEST", "Correo inválido.", 400);
  const email = parsed.data;

  const now = new Date().toISOString();
  const { data: revoked, error } = await supabaseServer
    .from("student_email_authorizations")
    .update({ revoked_at: now, revoked_by: auth.user.userId })
    .eq("email", email)
    .is("revoked_at", null)
    .select("id");
  if (error) return tableUnavailable();

  const wasActive = (revoked ?? []).length > 0;
  if (!wasActive) {
    // Acceso heredado (solo en el entorno) o sin autorización: queda constancia revocada.
    const { error: markErr } = await supabaseServer.from("student_email_authorizations").insert({
      email,
      note: "Revocación de un acceso sin autorización activa",
      revoked_at: now,
      revoked_by: auth.user.userId,
    });
    if (markErr) return tableUnavailable();
  }

  clearStudentEmailAuthorizationCache(email);

  // Sin acceso no recibe recordatorios: se cancelan sus invitaciones futuras.
  const calendar = await syncStudentInvitationsByEmail(email, new URL(req.url).origin);

  return ok({ revoked: true, wasActive, calendar });
}
