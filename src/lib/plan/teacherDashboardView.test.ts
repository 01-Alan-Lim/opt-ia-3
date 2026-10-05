import assert from "node:assert/strict";

import type { DashboardStudent } from "../teacher/dashboard/aggregate";
import {
  filterDashboardStudents,
  formatHours,
  formatPercent,
  readCohortOptions,
  readDashboardResponse,
  registrationLabel,
  stageKey,
  stageName,
  stagePercent,
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
  // Respuesta del panel: solo se acepta con la forma mínima que pinta la UI.
  const data = {
    cohort: { id: "c2", name: "2026-I", isActive: true, createdAt: "x", accessStartsAt: null, accessEndsAt: null },
    summary: {},
    stageTotals: {},
    students: [],
  };
  assert.equal(readDashboardResponse({ ok: true, data }), data);
  assert.equal(readDashboardResponse({ ok: false, code: "FORBIDDEN", message: "Solo docentes." }), null);
  assert.equal(readDashboardResponse({ ok: true, data: { ...data, students: null } }), null);
  assert.equal(readDashboardResponse({ ok: true, data: { ...data, cohort: null } }), null);
  assert.equal(readDashboardResponse("<html>"), null);
}

console.log("teacherDashboardView tests passed");
