// src/lib/teacher/dashboard/rows.ts
//
// Forma de las filas que GET /api/teacher/dashboard lee de Supabase, con las columnas reales
// de cada tabla. La ruta valida cada lista con estos esquemas antes de agregarla: si el
// esquema cambia, falla con un error en vez de mostrar datos a medias. Sin I/O.
//
// user_id es text en profiles, plan_case_contexts y plan_stage_artifacts, y uuid en
// plan_stage_states, plan_stage_evaluations y hours_entries: en JSON todos llegan como string
// y la agregación los compara normalizados. numeric/bigint se aceptan como número o string.

import { z } from "zod";

const NumericSchema = z.union([z.number(), z.string()]);

export const DashboardCohortRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
  access_starts_at: z.string().nullable(),
  access_ends_at: z.string().nullable(),
});

export const DashboardStudentRowSchema = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  ru: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  registration_status: z.string().nullable(),
});

export const DashboardCaseContextRowSchema = z.object({
  user_id: z.string(),
  status: z.string(),
});

export const DashboardArtifactRowSchema = z.object({
  user_id: z.string(),
  stage: z.number(),
  artifact_type: z.string(),
  status: z.string(),
  period_key: z.string().nullable(),
  created_at: z.string(),
});

export const DashboardStateRowSchema = z.object({
  user_id: z.string(),
  stage: z.number(),
  updated_at: z.string(),
});

export const DashboardEvaluationRowSchema = z.object({
  user_id: z.string(),
  stage: z.number(),
  artifact_type: z.string(),
  total_score: NumericSchema,
  total_label: z.string(),
  created_at: z.string(),
});

// period_start/period_end: semana sábado-viernes (date) que asigna /api/hours al registrar.
export const DashboardHoursRowSchema = z.object({
  user_id: z.string(),
  hours: NumericSchema,
  period_start: z.string(),
  period_end: z.string(),
});

// v_student_usage: mensajes por estudiante en todos sus chats (asesor y general).
export const DashboardUsageRowSchema = z.object({
  user_id: z.string().nullable(),
  messages_user: NumericSchema.nullable(),
  last_message_at: z.string().nullable(),
});

// v_bi_usage_daily, leída como "user_id:student_id": mensajes por estudiante y día. El día es
// la fecha en UTC (la vista hace date_trunc en la zona de la base, que es UTC).
export const DashboardUsageDailyRowSchema = z.object({
  user_id: z.string().nullable(),
  day: z.string(),
  messages_user: NumericSchema.nullable(),
});

// cohort_events con event_kind = 'ADVANCE' de la cohorte (event_index 1..3 por CHECK).
export const DashboardAdvanceEventRowSchema = z.object({
  event_kind: z.string(),
  event_index: z.number().nullable(),
  event_date: z.string(),
  is_enabled: z.boolean(),
});

export type DashboardCohortRow = z.infer<typeof DashboardCohortRowSchema>;
export type DashboardStudentRow = z.infer<typeof DashboardStudentRowSchema>;
export type DashboardCaseContextRow = z.infer<typeof DashboardCaseContextRowSchema>;
export type DashboardArtifactRow = z.infer<typeof DashboardArtifactRowSchema>;
export type DashboardStateRow = z.infer<typeof DashboardStateRowSchema>;
export type DashboardEvaluationRow = z.infer<typeof DashboardEvaluationRowSchema>;
export type DashboardHoursRow = z.infer<typeof DashboardHoursRowSchema>;
export type DashboardUsageRow = z.infer<typeof DashboardUsageRowSchema>;
export type DashboardUsageDailyRow = z.infer<typeof DashboardUsageDailyRowSchema>;
export type DashboardAdvanceEventRow = z.infer<typeof DashboardAdvanceEventRowSchema>;
