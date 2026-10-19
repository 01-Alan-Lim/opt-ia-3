// src/lib/calendar/invitationTriggers.ts
//
// Puntos de entrada de la sincronización de invitaciones para las rutas. Nunca lanzan: devuelven
// un SyncReport que la ruta añade a su respuesta, después de haber guardado su propio cambio (la
// aprobación, la revocación o las fechas no dependen de Google).

import { normalizeEmail } from "@/lib/auth/studentEmailAuthorization";
import { supabaseServer } from "@/lib/supabaseServer";

import { safeReconcile, type SyncOptions, type SyncReport } from "./invitationSync";

type TriggerOptions = Omit<SyncOptions, "origin">;

// Un estudiante: aprobación, rechazo, cambio de cohorte, autorización o revocación del correo.
export function syncStudentInvitations(userId: string, origin: string, options: TriggerOptions = {}): Promise<SyncReport> {
  return safeReconcile({ kind: "user", userId }, { budgetMs: 20_000, ...options, origin });
}

export async function syncStudentInvitationsByEmail(email: string, origin: string, options: TriggerOptions = {}): Promise<SyncReport | null> {
  const { data, error } = await supabaseServer.from("profiles").select("user_id").eq("email", normalizeEmail(email)).limit(5);
  if (error) return null;
  const users = (data ?? []) as Array<{ user_id: string }>;
  if (users.length === 0) return null;
  let last: SyncReport | null = null;
  for (const u of users) last = await syncStudentInvitations(u.user_id, origin, options);
  return last;
}

// Una cohorte: tras guardar fechas, hora del recordatorio o enlaces de formularios.
export function syncCohortInvitations(cohortId: string, origin: string, options: TriggerOptions = {}): Promise<SyncReport> {
  return safeReconcile({ kind: "cohort", cohortId }, { budgetMs: 45_000, ...options, origin });
}

// Todo: al conectar la cuenta organizadora o con "Sincronizar" en el panel.
export function syncAllInvitations(origin: string, options: TriggerOptions = {}): Promise<SyncReport> {
  return safeReconcile({ kind: "all" }, { budgetMs: 45_000, ...options, origin });
}

// Retirar todas las invitaciones de la cuenta actual (antes de cambiar de cuenta organizadora).
export function withdrawAllInvitations(origin: string, options: TriggerOptions = {}): Promise<SyncReport> {
  return safeReconcile({ kind: "withdraw" }, { budgetMs: 45_000, ...options, origin });
}
