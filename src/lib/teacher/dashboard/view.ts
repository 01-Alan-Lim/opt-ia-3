// src/lib/teacher/dashboard/view.ts
//
// Funciones puras de presentación del panel docente nativo (src/components/teacher/dashboard):
// lectura defensiva de las respuestas de la API, filtro de estudiantes, porcentajes, horas y
// nombres de etapa. Sin React ni fetch.

import { getAdvisorStageLabel } from "@/lib/plan/advisorMessages";
import type { PlanStageNumber } from "@/lib/plan/stageArtifacts";
import type { DashboardStageKey, DashboardStudent, TeacherDashboard } from "./aggregate";

export type RegistrationFilter = "all" | "approved" | "pending" | "rejected";

export type CohortOption = { id: string; name: string; isActive: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GET /api/teacher/cohorts/list -> { ok, data: { cohorts: [...] } }, más reciente primero.
// Se conserva ese orden.
export function readCohortOptions(response: unknown): CohortOption[] {
  const data = isRecord(response) && isRecord(response.data) ? response.data : null;
  const list = data && Array.isArray(data.cohorts) ? data.cohorts : [];

  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id, name: item.name, isActive: item.is_active === true }];
  });
}

// GET /api/teacher/dashboard -> { ok: true, data: TeacherDashboard }. Comprueba la forma
// mínima que pinta la UI; si no la cumple, la vista muestra un error en vez de datos a medias.
export function readDashboardResponse(response: unknown): TeacherDashboard | null {
  if (!isRecord(response) || response.ok === false) return null;
  const data = response.data;
  if (!isRecord(data)) return null;

  const cohort = data.cohort;
  if (!isRecord(cohort) || typeof cohort.id !== "string" || typeof cohort.name !== "string") {
    return null;
  }
  if (!isRecord(data.summary) || !isRecord(data.stageTotals) || !Array.isArray(data.students)) {
    return null;
  }

  return data as TeacherDashboard;
}

export function stageKey(stage: PlanStageNumber): DashboardStageKey {
  return `e${stage}`;
}

// "Etapa 4: Ishikawa" -> "Ishikawa" (nombres de getAdvisorStageLabel, los mismos del chat).
export function stageName(stage: PlanStageNumber): string {
  const label = getAdvisorStageLabel(stage);
  const separator = label.indexOf(": ");
  return separator >= 0 ? label.slice(separator + 2) : label;
}

export function stageLabel(stage: PlanStageNumber): string {
  return getAdvisorStageLabel(stage);
}

// Porcentaje con un decimal; null si la cohorte no tiene estudiantes.
export function stagePercent(count: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((count / total) * 1000) / 10;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("es-BO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// null = sin registros de horas (no es 0 h).
export function formatHours(total: number | null): string {
  if (total === null) return "Sin registros";
  return `${total.toLocaleString("es-BO", { maximumFractionDigits: 2 })} h`;
}

const REGISTRATION_LABELS: Record<string, string> = {
  approved: "Aprobado",
  pending: "Pendiente",
  rejected: "Rechazado",
};

export function registrationLabel(status: string | null): string {
  return (status && REGISTRATION_LABELS[status]) || "Sin estado";
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Búsqueda por RU, nombre, apellido o email (sin distinguir mayúsculas ni tildes) y filtro
// por estado de registro. Conserva el orden recibido.
export function filterDashboardStudents(
  students: DashboardStudent[],
  filter: { query: string; status: RegistrationFilter }
): DashboardStudent[] {
  const query = normalizeSearch(filter.query);

  return students.filter((student) => {
    if (filter.status !== "all" && student.registrationStatus !== filter.status) return false;
    if (!query) return true;

    const fullName = [student.firstName, student.lastName].filter(Boolean).join(" ");
    const haystack = [student.ru, student.firstName, student.lastName, fullName, student.email]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(normalizeSearch);

    return haystack.some((value) => value.includes(query));
  });
}
