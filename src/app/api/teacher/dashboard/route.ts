// src/app/api/teacher/dashboard/route.ts
//
// GET /api/teacher/dashboard[?cohortId=<uuid>]
// Datos del panel docente nativo para UNA cohorte: sin cohortId, la más reciente (mismo orden
// que /api/teacher/cohorts/list: created_at descendente). No hay vista "todas las cohortes".
//
// Autoridad: requireUser + rol docente resuelto en el servidor (allowlist), igual que el resto
// de /api/teacher/*. Recién después se lee con service role, porque las tablas plan_* no
// tienen policies para docentes. Cada tabla se lee UNA vez para todos los estudiantes de la
// cohorte (las que pueden pasar de PAGE_SIZE filas, en páginas); la agregación es pura
// (src/lib/teacher/dashboard/aggregate.ts y analytics.ts).

import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { failResponse, ok } from "@/lib/api/response";
import {
  FINAL_ARTIFACT_BY_STAGE,
  FINAL_DOC_VERSION_ARTIFACT_TYPES,
} from "@/lib/plan/stageArtifacts";
import { supabaseServer } from "@/lib/supabaseServer";
import { buildTeacherDashboard } from "@/lib/teacher/dashboard/aggregate";
import {
  DashboardAdvanceEventRowSchema,
  DashboardArtifactRowSchema,
  DashboardCaseContextRowSchema,
  DashboardCohortRowSchema,
  DashboardEvaluationRowSchema,
  DashboardHoursRowSchema,
  DashboardStateRowSchema,
  DashboardStudentRowSchema,
  DashboardUsageDailyRowSchema,
  DashboardUsageRowSchema,
} from "@/lib/teacher/dashboard/rows";

export const runtime = "nodejs";

const QuerySchema = z.object({
  cohortId: z.string().uuid().optional(),
});

const COHORT_COLUMNS = "id, name, is_active, created_at, access_starts_at, access_ends_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Error de lectura o de forma de datos: se registra en el servidor y el cliente recibe
// INTERNAL_ERROR sin detalles de Supabase.
class DashboardDataError extends Error {
  readonly detail: unknown;

  constructor(source: string, detail: unknown) {
    super(`DASHBOARD_DATA:${source}`);
    this.name = "DashboardDataError";
    this.detail = detail;
  }
}

function parseRows<T>(source: string, schema: z.ZodType<T>, data: unknown): T[] {
  const parsed = z.array(schema).safeParse(data ?? []);
  if (!parsed.success) throw new DashboardDataError(source, parsed.error.issues);
  return parsed.data;
}

// Máximo de filas por respuesta que PostgREST aplica por defecto en Supabase: una respuesta
// más larga se corta sin error.
const PAGE_SIZE = 1000;

type PageResult = { data: unknown[] | null; error: unknown };

// Todas las filas de una consulta ordenada, en páginas de PAGE_SIZE. La cantidad de consultas
// crece con las filas, no con los estudiantes.
async function fetchAllRows(
  source: string,
  page: (from: number, to: number) => PromiseLike<PageResult>
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new DashboardDataError(source, error);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

async function loadCohort(cohortId: string | undefined) {
  const base = supabaseServer.from("cohorts").select(COHORT_COLUMNS);
  const { data, error } = cohortId
    ? await base.eq("id", cohortId).maybeSingle()
    : await base.order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (error) throw new DashboardDataError("cohorts", error);
  if (!data) return null;

  const parsed = DashboardCohortRowSchema.safeParse(data);
  if (!parsed.success) throw new DashboardDataError("cohorts", parsed.error.issues);
  return parsed.data;
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return failResponse("FORBIDDEN", "Solo docentes.", 403);
    }

    const url = new URL(req.url);
    const query = QuerySchema.safeParse({
      cohortId: url.searchParams.get("cohortId") ?? undefined,
    });
    if (!query.success) {
      return failResponse("INVALID_QUERY", "Parámetros inválidos.", 400);
    }

    const cohort = await loadCohort(query.data.cohortId);
    if (!cohort) {
      return failResponse(
        "COHORT_NOT_FOUND",
        query.data.cohortId ? "La cohorte no existe." : "Todavía no hay cohortes.",
        404
      );
    }

    const [studentsRes, eventsRes] = await Promise.all([
      supabaseServer
        .from("profiles")
        .select("user_id, email, ru, first_name, last_name, registration_status")
        .eq("role", "student")
        .eq("cohort_id", cohort.id),
      supabaseServer
        .from("cohort_events")
        .select("event_kind, event_index, event_date, is_enabled")
        .eq("cohort_id", cohort.id)
        .eq("event_kind", "ADVANCE"),
    ]);
    if (studentsRes.error) throw new DashboardDataError("profiles", studentsRes.error);
    if (eventsRes.error) throw new DashboardDataError("cohort_events", eventsRes.error);
    const students = parseRows("profiles", DashboardStudentRowSchema, studentsRes.data);
    const advanceEvents = parseRows("cohort_events", DashboardAdvanceEventRowSchema, eventsRes.data);
    const now = new Date();

    // user_id es text en profiles; las columnas uuid solo aceptan ids con forma de uuid.
    const ids = students.map((student) => student.user_id);
    const uuidIds = ids.filter((id) => UUID_RE.test(id));

    if (!ids.length) {
      return ok(
        buildTeacherDashboard({
          cohort,
          students: [],
          caseContexts: [],
          artifacts: [],
          states: [],
          evaluations: [],
          hours: [],
          usage: [],
          usageDaily: [],
          advanceEvents,
          now,
        })
      );
    }

    const artifactTypes = [
      ...FINAL_ARTIFACT_BY_STAGE.values(),
      FINAL_DOC_VERSION_ARTIFACT_TYPES[1],
      FINAL_DOC_VERSION_ARTIFACT_TYPES[2],
    ];
    const noUuidIds = uuidIds.length === 0;

    // plan_stage_states (una fila por chat y etapa), hours_entries (una por semana) y
    // v_bi_usage_daily (una por día) pueden pasar de PAGE_SIZE en una cohorte: van en páginas.
    const [contextsRes, artifactsRes, evaluationsRes, usageRes, stateRows, hoursRows, usageDailyRows] =
      await Promise.all([
        supabaseServer.from("plan_case_contexts").select("user_id, status").in("user_id", ids),
        supabaseServer
          .from("plan_stage_artifacts")
          .select("user_id, stage, artifact_type, status, period_key, created_at")
          .in("user_id", ids)
          .in("artifact_type", artifactTypes),
        noUuidIds
          ? null
          : supabaseServer
              .from("plan_stage_evaluations")
              .select("user_id, stage, artifact_type, total_score, total_label, created_at")
              .in("user_id", uuidIds),
        supabaseServer
          .from("v_student_usage")
          .select("user_id, messages_user, last_message_at")
          .in("user_id", ids),
        noUuidIds
          ? []
          : fetchAllRows("plan_stage_states", (from, to) =>
              supabaseServer
                .from("plan_stage_states")
                .select("user_id, stage, updated_at")
                .in("user_id", uuidIds)
                .order("id")
                .range(from, to)
            ),
        noUuidIds
          ? []
          : fetchAllRows("hours_entries", (from, to) =>
              supabaseServer
                .from("hours_entries")
                .select("user_id, hours, period_start, period_end")
                .eq("cohort_id", cohort.id)
                .in("user_id", uuidIds)
                .order("id")
                .range(from, to)
            ),
        fetchAllRows("v_bi_usage_daily", (from, to) =>
          supabaseServer
            .from("v_bi_usage_daily")
            .select("user_id:student_id, day, messages_user")
            .in("student_id", ids)
            .order("day")
            .order("student_id")
            .range(from, to)
        ),
      ]);

    const sources = [
      ["plan_case_contexts", contextsRes],
      ["plan_stage_artifacts", artifactsRes],
      ["plan_stage_evaluations", evaluationsRes],
      ["v_student_usage", usageRes],
    ] as const;
    for (const [source, res] of sources) {
      if (res?.error) throw new DashboardDataError(source, res.error);
    }

    return ok(
      buildTeacherDashboard({
        cohort,
        students,
        caseContexts: parseRows("plan_case_contexts", DashboardCaseContextRowSchema, contextsRes.data),
        artifacts: parseRows("plan_stage_artifacts", DashboardArtifactRowSchema, artifactsRes.data),
        states: parseRows("plan_stage_states", DashboardStateRowSchema, stateRows),
        evaluations: parseRows(
          "plan_stage_evaluations",
          DashboardEvaluationRowSchema,
          evaluationsRes?.data
        ),
        hours: parseRows("hours_entries", DashboardHoursRowSchema, hoursRows),
        usage: parseRows("v_student_usage", DashboardUsageRowSchema, usageRes.data),
        usageDaily: parseRows("v_bi_usage_daily", DashboardUsageDailyRowSchema, usageDailyRows),
        advanceEvents,
        now,
      })
    );
  } catch (e) {
    const authCode = getAuthErrorCode(e);
    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }
    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN", "Acceso restringido.", 403);
    }
    const detail = e instanceof DashboardDataError ? { source: e.message, detail: e.detail } : e;
    return failResponse("INTERNAL_ERROR", "No se pudo cargar el panel docente.", 500, detail);
  }
}
