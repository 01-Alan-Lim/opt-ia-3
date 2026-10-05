import assert from "node:assert/strict";

import { buildTeacherDashboard, type TeacherDashboardInput } from "../teacher/dashboard/aggregate";
import type {
  DashboardArtifactRow,
  DashboardEvaluationRow,
  DashboardStudentRow,
} from "../teacher/dashboard/rows";

// Caracterización de la agregación pura del panel docente (src/lib/teacher/dashboard).
// Vive aquí porque el runner solo recorre src/lib/plan.

const COHORT = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: "Cohorte 2026-I",
  is_active: true,
  created_at: "2026-02-01T00:00:00+00:00",
  access_starts_at: null,
  access_ends_at: null,
};

const FINAL_BY_STAGE: Record<number, string> = {
  1: "productivity_report",
  2: "foda_analysis",
  3: "brainstorm_ideas",
  4: "ishikawa_final",
  5: "pareto_final",
  6: "objectives_final",
  7: "improvement_final",
  8: "planning_final",
  9: "progress_final",
  10: "final_doc_final",
};

function student(userId: string, lastName: string, status: string | null = "approved"): DashboardStudentRow {
  return {
    user_id: userId,
    email: `${lastName.toLowerCase()}@example.edu`,
    ru: null,
    first_name: "Est",
    last_name: lastName,
    registration_status: status,
  };
}

function validated(
  userId: string,
  stage: number,
  createdAt: string,
  periodKey: string | null = createdAt.slice(0, 7)
): DashboardArtifactRow {
  return {
    user_id: userId,
    stage,
    artifact_type: FINAL_BY_STAGE[stage],
    status: "validated",
    period_key: periodKey,
    created_at: createdAt,
  };
}

function evaluation(
  userId: string,
  stage: number,
  score: number | string,
  createdAt: string,
  artifactType = FINAL_BY_STAGE[stage]
): DashboardEvaluationRow {
  return {
    user_id: userId,
    stage,
    artifact_type: artifactType,
    total_score: score,
    total_label: `Nota ${score}`,
    created_at: createdAt,
  };
}

function input(overrides: Partial<TeacherDashboardInput>): TeacherDashboardInput {
  return {
    cohort: COHORT,
    students: [],
    caseContexts: [],
    artifacts: [],
    states: [],
    evaluations: [],
    hours: [],
    usage: [],
    ...overrides,
  };
}

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";

{
  // Cohorte sin estudiantes: todo en cero y sin horas (null, no 0).
  const dash = buildTeacherDashboard(input({}));
  assert.deepEqual(dash.cohort, {
    id: COHORT.id,
    name: "Cohorte 2026-I",
    isActive: true,
    createdAt: COHORT.created_at,
    accessStartsAt: null,
    accessEndsAt: null,
  });
  assert.equal(dash.students.length, 0);
  assert.deepEqual(dash.summary, {
    totalStudents: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    otherStatus: 0,
    contextConfirmed: 0,
    planClosed: 0,
    studentsWithHours: 0,
    totalHours: null,
  });
  assert.deepEqual(Object.keys(dash.stageTotals), ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]);
  assert.ok(Object.values(dash.stageTotals).every((n) => n === 0));
}

{
  // Estudiante sin ningún dato plan_*: nada cerrado, sin etapa activa, sin horas ni actividad.
  const dash = buildTeacherDashboard(input({ students: [student(A, "Alba")] }));
  const s = dash.students[0];
  assert.equal(s.progress.length, 11);
  assert.ok(s.progress.every((p) => !p.completed && p.validatedAt === null && p.score === null));
  assert.equal(s.completedStages, 0);
  assert.equal(s.lastValidatedStage, null);
  assert.equal(s.activeStateStage, null);
  assert.deepEqual(s.hours, { entries: 0, total: null });
  assert.deepEqual(s.activity, { messagesSent: null, lastMessageAt: null });
  assert.deepEqual(s.finalDocument, { latestVersion: null, closed: false });
}

{
  // Solo E0: contexto confirmado; un contexto en borrador no cierra.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      caseContexts: [
        { user_id: A, status: "confirmed" },
        { user_id: B, status: "draft" },
      ],
    })
  );
  const [a, b] = dash.students;
  assert.equal(a.progress[0].completed, true);
  assert.equal(a.progress[0].validatedAt, null);
  assert.equal(a.lastValidatedStage, 0);
  assert.equal(a.completedStages, 1);
  assert.equal(b.progress[0].completed, false);
  assert.equal(b.lastValidatedStage, null);
  assert.equal(dash.stageTotals.e0, 1);
  assert.equal(dash.summary.contextConfirmed, 1);
}

{
  // Avance parcial en meses distintos: E1 en 2025-03 y E2-E3 en 2026; todo cuenta.
  // Notas solo donde hay evaluación; E4 validada sin evaluación queda en null (no 0).
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      caseContexts: [{ user_id: A, status: "confirmed" }],
      artifacts: [
        validated(A, 1, "2025-03-10T10:00:00+00:00"),
        validated(A, 2, "2026-02-15T10:00:00+00:00"),
        validated(A, 3, "2026-03-01T10:00:00+00:00"),
        validated(A, 4, "2026-06-20T10:00:00+00:00"),
      ],
      evaluations: [
        evaluation(A, 1, 72, "2025-03-10T10:05:00+00:00"),
        evaluation(A, 2, "85.5", "2026-02-15T10:05:00+00:00"),
        evaluation(A, 3, 90, "2026-03-01T10:05:00+00:00"),
      ],
    })
  );
  const s = dash.students[0];
  assert.deepEqual(
    s.progress.map((p) => p.completed),
    [true, true, true, true, true, false, false, false, false, false, false]
  );
  assert.equal(s.progress[1].validatedAt, "2025-03-10T10:00:00+00:00");
  assert.equal(s.progress[2].validatedAt, "2026-02-15T10:00:00+00:00");
  assert.equal(s.progress[1].score, 72);
  assert.equal(s.progress[2].score, 85.5);
  assert.equal(s.progress[2].scoreLabel, "Nota 85.5");
  assert.equal(s.progress[4].score, null);
  assert.equal(s.progress[4].scoreLabel, null);
  assert.equal(s.lastValidatedStage, 4);
  assert.equal(s.completedStages, 5);
  assert.equal(dash.stageTotals.e4, 1);
  assert.equal(dash.stageTotals.e5, 0);
}

{
  // E1-E10 completas, con v1 y v2 del documento final en borrador: cerrado, versión 2.
  const artifacts: DashboardArtifactRow[] = [];
  for (let stage = 1; stage <= 10; stage++) {
    artifacts.push(validated(A, stage, `2026-06-${String(stage + 10)}T10:00:00+00:00`));
  }
  artifacts.push({ ...validated(A, 10, "2026-06-05T10:00:00+00:00"), artifact_type: "final_doc_v1", status: "draft" });
  artifacts.push({ ...validated(A, 10, "2026-06-08T10:00:00+00:00"), artifact_type: "final_doc_v2", status: "draft" });

  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      caseContexts: [{ user_id: A, status: "confirmed" }],
      artifacts,
      evaluations: [evaluation(A, 10, 95, "2026-06-21T00:00:00+00:00")],
    })
  );
  const s = dash.students[0];
  assert.ok(s.progress.every((p) => p.completed));
  assert.equal(s.completedStages, 11);
  assert.equal(s.lastValidatedStage, 10);
  assert.deepEqual(s.finalDocument, { latestVersion: 2, closed: true });
  assert.equal(s.progress[10].score, 95);
  assert.equal(dash.summary.planClosed, 1);
  assert.ok(Object.values(dash.stageTotals).every((n) => n === 1));
}

{
  // Documento final solo con v1 en borrador: versión 1, sin cerrar; v1 no cierra E10.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [{ ...validated(A, 10, "2026-06-05T10:00:00+00:00"), artifact_type: "final_doc_v1", status: "draft" }],
    })
  );
  assert.deepEqual(dash.students[0].finalDocument, { latestVersion: 1, closed: false });
  assert.equal(dash.students[0].progress[10].completed, false);
}

{
  // Artefactos duplicados y ruido: dos validaciones de E2 en meses distintos cuentan una vez
  // (validatedAt = la primera); un final en borrador, un no-final validado y un final con la
  // etapa equivocada no cierran nada.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [
        validated(A, 2, "2026-04-01T10:00:00+00:00", "2026-04"),
        validated(A, 2, "2026-02-01T10:00:00+00:00", "2026-02"),
        { ...validated(A, 3, "2026-03-01T10:00:00+00:00"), status: "draft" },
        { ...validated(A, 3, "2026-03-01T10:00:00+00:00"), artifact_type: "brainstorm_wizard_state" },
        { ...validated(A, 5, "2026-05-01T10:00:00+00:00"), stage: 4 },
      ],
    })
  );
  const s = dash.students[0];
  assert.equal(s.progress[2].completed, true);
  assert.equal(s.progress[2].validatedAt, "2026-02-01T10:00:00+00:00");
  assert.equal(s.progress[3].completed, false);
  assert.equal(s.progress[4].completed, false);
  assert.equal(s.progress[5].completed, false);
  assert.equal(s.completedStages, 1);
  assert.equal(dash.stageTotals.e2, 1);
}

{
  // Evaluaciones: gana la más reciente del artefacto final; una evaluación de otro artefacto
  // de la misma etapa (p. ej. final_doc_v1) no es la nota de la etapa.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [validated(A, 1, "2026-01-10T10:00:00+00:00")],
      evaluations: [
        evaluation(A, 1, 60, "2026-01-10T10:05:00+00:00"),
        evaluation(A, 1, 80, "2026-02-10T10:05:00+00:00"),
        evaluation(A, 10, 40, "2026-06-01T00:00:00+00:00", "final_doc_v1"),
      ],
    })
  );
  const s = dash.students[0];
  assert.equal(s.progress[1].score, 80);
  assert.equal(s.progress[10].score, null);
}

{
  // La etapa activa sale del estado guardado más reciente y NO borra lo validado.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [validated(A, 4, "2026-03-01T10:00:00+00:00"), validated(A, 5, "2026-04-01T10:00:00+00:00")],
      states: [
        { user_id: A, stage: 6, updated_at: "2026-04-10T10:00:00+00:00" },
        { user_id: A, stage: 2, updated_at: "2026-05-01T10:00:00+00:00" },
        { user_id: A, stage: 5, updated_at: "2026-03-20T10:00:00+00:00" },
      ],
    })
  );
  const s = dash.students[0];
  assert.equal(s.activeStateStage, 2);
  assert.equal(s.activeStateUpdatedAt, "2026-05-01T10:00:00+00:00");
  assert.equal(s.lastValidatedStage, 5);
  assert.equal(s.progress[5].completed, true);
}

{
  // Horas: sin registros es null; con registros se suman (numeric como número o string) y se
  // redondean a 2 decimales.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      hours: [
        { user_id: A, hours: 0.1 },
        { user_id: A, hours: "0.2" },
        { user_id: A, hours: 4 },
      ],
    })
  );
  const [a, b] = dash.students;
  assert.deepEqual(a.hours, { entries: 3, total: 4.3 });
  assert.deepEqual(b.hours, { entries: 0, total: null });
  assert.equal(dash.summary.studentsWithHours, 1);
  assert.equal(dash.summary.totalHours, 4.3);
}

{
  // ids: profiles.user_id (text) y las columnas uuid se comparan normalizados; las filas de
  // usuarios fuera de la cohorte se ignoran.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A.toUpperCase(), "Alba")],
      caseContexts: [{ user_id: A, status: "confirmed" }],
      artifacts: [validated(` ${A} `, 1, "2026-01-10T10:00:00+00:00"), validated(C, 2, "2026-01-10T10:00:00+00:00")],
      states: [{ user_id: A, stage: 3, updated_at: "2026-02-01T00:00:00+00:00" }],
      hours: [{ user_id: C, hours: 10 }],
      usage: [
        { user_id: A, messages_user: "42", last_message_at: "2026-06-01T12:00:00+00:00" },
        { user_id: null, messages_user: 5, last_message_at: null },
      ],
    })
  );
  const s = dash.students[0];
  assert.equal(s.userId, A.toUpperCase());
  assert.equal(s.progress[0].completed, true);
  assert.equal(s.progress[1].completed, true);
  assert.equal(s.progress[2].completed, false);
  assert.equal(s.activeStateStage, 3);
  assert.deepEqual(s.hours, { entries: 0, total: null });
  assert.deepEqual(s.activity, { messagesSent: 42, lastMessageAt: "2026-06-01T12:00:00+00:00" });
  assert.equal(dash.summary.totalHours, null);
}

{
  // Resumen de registro y orden por apellido; un perfil repetido cuenta una vez.
  const dash = buildTeacherDashboard(
    input({
      students: [
        student(C, "Zeta", "pending"),
        student(A, "Alba", "approved"),
        student(B, "Ñandú", "rejected"),
        student("d0000000-0000-4000-8000-00000000000d", "Beta", null),
        student(A, "Alba", "approved"),
      ],
    })
  );
  assert.deepEqual(
    dash.students.map((s) => s.lastName),
    ["Alba", "Beta", "Ñandú", "Zeta"]
  );
  assert.equal(dash.summary.totalStudents, 4);
  assert.equal(dash.summary.approved, 1);
  assert.equal(dash.summary.pending, 1);
  assert.equal(dash.summary.rejected, 1);
  assert.equal(dash.summary.otherStatus, 1);
}

console.log("teacherDashboard tests passed");
