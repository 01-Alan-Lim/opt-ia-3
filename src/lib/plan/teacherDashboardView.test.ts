import assert from "node:assert/strict";

import type { DashboardStudent } from "../teacher/dashboard/aggregate";
import {
  filterDashboardStudents,
  filterStudents,
  formatHours,
  formatPercent,
  readCohortOptions,
  readDashboardResponse,
  pendingStudentsForStage,
  registrationLabel,
  stageKey,
  stageName,
  stagePercent,
  studentDisplayName,
} from "../teacher/dashboard/view";

// Caracterización de las funciones puras de la vista del panel docente
// (src/lib/teacher/dashboard/view.ts). Vive aquí porque el runner solo recorre src/lib/plan.

function student(overrides: Partial<DashboardStudent>): DashboardStudent {
  return {
    userId: "u",
    ru: null,
    firstName: null,
    lastName: null,
    email: null,
    registrationStatus: "approved",
    progress: [],
    completedStages: 0,
    lastValidatedStage: null,
    activeStateStage: null,
    activeStateUpdatedAt: null,
    hours: { entries: 0, total: null },
    activity: { messagesSent: null, lastMessageAt: null },
    finalDocument: { latestVersion: null, closed: false },
    ...overrides,
  };
}

{
  // Porcentaje por etapa: un decimal; sin estudiantes no hay porcentaje (no 0%).
  assert.equal(stagePercent(20, 30), 66.7);
  assert.equal(stagePercent(3, 30), 10);
  assert.equal(stagePercent(30, 30), 100);
  assert.equal(stagePercent(0, 30), 0);
  assert.equal(stagePercent(0, 0), null);
  assert.equal(formatPercent(66.7), "66,7%");
  assert.equal(formatPercent(10), "10,0%");
  assert.equal(formatPercent(null), "—");
}

{
  // Horas: null es "Sin registros", nunca "0 h".
  assert.equal(formatHours(null), "Sin registros");
  assert.equal(formatHours(171.5), "171,5 h");
  assert.equal(formatHours(4.25), "4,25 h");
  assert.equal(formatHours(0), "0 h");
}

{
  // Etiquetas de estado y de etapa (las del chat).
  assert.equal(registrationLabel("approved"), "Aprobado");
  assert.equal(registrationLabel("pending"), "Pendiente");
  assert.equal(registrationLabel("rejected"), "Rechazado");
  assert.equal(registrationLabel(null), "Sin estado");
  assert.equal(registrationLabel("otro"), "Sin estado");
  assert.equal(stageKey(0), "e0");
  assert.equal(stageKey(10), "e10");
  assert.equal(stageName(0), "Contexto del caso");
  assert.equal(stageName(4), "Ishikawa");
  assert.equal(stageName(10), "Documento final");
}

{
  // Filtro: RU, nombre, apellido, nombre completo o email, sin tildes ni mayúsculas; y estado.
  const list = [
    student({ userId: "1", ru: "20201234", firstName: "José", lastName: "Pérez", email: "jperez@umsa.bo" }),
    student({ userId: "2", ru: "20209999", firstName: "Ana", lastName: "Quispe", registrationStatus: "pending" }),
    student({ userId: "3", firstName: null, lastName: null, email: "sin.nombre@umsa.bo", registrationStatus: null }),
  ];
  const ids = (out: DashboardStudent[]) => out.map((s) => s.userId);

  assert.deepEqual(ids(filterDashboardStudents(list, { query: "", status: "all" })), ["1", "2", "3"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "jose perez", status: "all" })), ["1"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "PÉREZ", status: "all" })), ["1"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "2020", status: "all" })), ["1", "2"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "sin.nombre", status: "all" })), ["3"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "  ", status: "pending" })), ["2"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "", status: "approved" })), ["1"]);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "", status: "rejected" })), []);
  assert.deepEqual(ids(filterDashboardStudents(list, { query: "quispe", status: "approved" })), []);
}

{
  // Opciones de cohorte de /api/teacher/cohorts/list: mismo orden, filas inválidas fuera.
  assert.deepEqual(
    readCohortOptions({
      ok: true,
      data: {
        cohorts: [
          { id: "c2", name: "2026-I", is_active: true, created_at: "2026-02-01" },
          { id: "c1", name: "2025-II", is_active: false },
          { id: 3, name: "mala" },
          null,
        ],
      },
    }),
    [
      { id: "c2", name: "2026-I", isActive: true },
      { id: "c1", name: "2025-II", isActive: false },
    ]
  );
  assert.deepEqual(readCohortOptions(null), []);
  assert.deepEqual(readCohortOptions({ ok: false, code: "FORBIDDEN" }), []);
}

{
  // Respuesta del panel: solo se acepta con la forma mínima que pinta la UI, analytics incluido.
  const analytics = {
    range: { from: null, to: null, timezone: "America/La_Paz" },
    advanceEvents: [],
    advanceWindows: { status: "missing_advance_dates", windows: [] },
    validationsByPeriod: [],
    cumulativeStageProgress: { points: [], undated: {} },
    hoursByPeriod: [],
    activityByPeriod: { timezone: "UTC", points: [] },
    scoreDistributions: [],
  };
  const data = {
    cohort: { id: "c2", name: "2026-I", isActive: true, createdAt: "x", accessStartsAt: null, accessEndsAt: null },
    summary: {},
    stageTotals: {},
    students: [],
    analytics,
  };
  assert.equal(readDashboardResponse({ ok: true, data }), data);
  assert.equal(readDashboardResponse({ ok: false, code: "FORBIDDEN", message: "Solo docentes." }), null);
  assert.equal(readDashboardResponse({ ok: true, data: { ...data, students: null } }), null);
  assert.equal(readDashboardResponse({ ok: true, data: { ...data, cohort: null } }), null);
  assert.equal(readDashboardResponse({ ok: true, data: { ...data, analytics: undefined } }), null);
  assert.equal(
    readDashboardResponse({ ok: true, data: { ...data, analytics: { ...analytics, activityByPeriod: [] } } }),
    null
  );
  assert.equal(readDashboardResponse("<html>"), null);
}

{
  // Filtros de la matriz: situación de una etapa (solo con etapa elegida) y registros de horas
  // (sin registros no es 0 h: un total de 0 con registro cuenta como "con registros").
  const progress = (closed: number[]) =>
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((stage) => ({
      stage: stage as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
      completed: closed.includes(stage),
      validatedAt: null,
      score: null,
      scoreLabel: null,
    }));
  const list = [
    student({ userId: "1", ru: "111", firstName: "Ana", lastName: "Mamani", progress: progress([0, 1, 2]), hours: { entries: 2, total: 12 } }),
    student({ userId: "2", ru: "222", firstName: "Luis", lastName: "Choque", progress: progress([0, 2]), hours: { entries: 1, total: 0 } }),
    student({ userId: "3", ru: "333", firstName: "Eva", lastName: "Quispe", progress: progress([]), registrationStatus: "pending" }),
  ];
  const ids = (out: DashboardStudent[]) => out.map((s) => s.userId);
  const base = { query: "", status: "all" as const, stage: null, situation: "all" as const, hours: "all" as const };

  assert.deepEqual(ids(filterStudents(list, base)), ["1", "2", "3"]);
  assert.deepEqual(ids(filterStudents(list, { ...base, stage: 1, situation: "completed" })), ["1"]);
  assert.deepEqual(ids(filterStudents(list, { ...base, stage: 1, situation: "pending" })), ["2", "3"]);
  // Etapa elegida pero situación "Todos": no filtra.
  assert.deepEqual(ids(filterStudents(list, { ...base, stage: 1 })), ["1", "2", "3"]);
  // Situación sin etapa: no filtra.
  assert.deepEqual(ids(filterStudents(list, { ...base, situation: "pending" })), ["1", "2", "3"]);
  assert.deepEqual(ids(filterStudents(list, { ...base, hours: "with" })), ["1", "2"]);
  assert.deepEqual(ids(filterStudents(list, { ...base, hours: "without" })), ["3"]);
  // Combinados con búsqueda y estado.
  assert.deepEqual(ids(filterStudents(list, { ...base, query: "quispe", stage: 2, situation: "pending" })), ["3"]);
  assert.deepEqual(ids(filterStudents(list, { ...base, status: "approved", hours: "without" })), []);

  // Pendientes de una etapa (vista Etapas), con búsqueda por RU.
  assert.deepEqual(ids(pendingStudentsForStage(list, 0, "")), ["3"]);
  assert.deepEqual(ids(pendingStudentsForStage(list, 1, "")), ["2", "3"]);
  assert.deepEqual(ids(pendingStudentsForStage(list, 1, "222")), ["2"]);
  assert.deepEqual(ids(pendingStudentsForStage(list, 2, "")), ["3"]);

  // Nombre visible: nombre y apellido, si no email, si no el id.
  assert.equal(studentDisplayName(list[0]), "Ana Mamani");
  assert.equal(studentDisplayName(student({ userId: "9", email: "x@umsa.bo" })), "x@umsa.bo");
  assert.equal(studentDisplayName(student({ userId: "9" })), "9");
}

console.log("teacherDashboardView tests passed");
