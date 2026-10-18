import assert from "node:assert/strict";

import { buildTeacherDashboard, type TeacherDashboardInput } from "../teacher/dashboard/aggregate";
import {
  buildAdvanceEvents,
  buildAdvanceWindowBounds,
  monthsBetween,
  nextDate,
  type CompletionStageKey,
  type DashboardAnalytics,
} from "../teacher/dashboard/analytics";
import type {
  DashboardAdvanceEventRow,
  DashboardArtifactRow,
  DashboardEvaluationRow,
  DashboardHoursRow,
  DashboardStudentRow,
  DashboardUsageDailyRow,
} from "../teacher/dashboard/rows";

// Capa analítica temporal del panel docente (src/lib/teacher/dashboard/analytics.ts), probada a
// través de buildTeacherDashboard para que las series y el snapshot salgan de los mismos datos.
// Vive aquí porque el runner solo recorre src/lib/plan.

// Acceso 2026-01-07 00:00 → 2026-09-28 23:59:59.999 en La Paz (UTC-4), como la cohorte real.
const COHORT = {
  id: "c0000000-0000-4000-8000-000000000001",
  name: "Cohorte 2026-I",
  is_active: true,
  created_at: "2026-01-05T20:00:00+00:00",
  access_starts_at: "2026-01-07T04:00:00+00:00",
  access_ends_at: "2026-09-29T03:59:59.999+00:00",
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

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";

function student(userId: string, lastName: string): DashboardStudentRow {
  return {
    user_id: userId,
    email: `${lastName.toLowerCase()}@example.edu`,
    ru: null,
    first_name: "Est",
    last_name: lastName,
    registration_status: "approved",
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
  label = "Bien",
  artifactType = FINAL_BY_STAGE[stage]
): DashboardEvaluationRow {
  return {
    user_id: userId,
    stage,
    artifact_type: artifactType,
    total_score: score,
    total_label: label,
    created_at: createdAt,
  };
}

function hoursRow(
  userId: string,
  hours: number | string,
  periodStart: string,
  periodEnd: string
): DashboardHoursRow {
  return { user_id: userId, hours, period_start: periodStart, period_end: periodEnd };
}

function usageRow(userId: string, day: string, messages: number | string): DashboardUsageDailyRow {
  return { user_id: userId, day, messages_user: messages };
}

function advanceRow(
  index: number | null,
  date: string,
  overrides: Partial<DashboardAdvanceEventRow> = {}
): DashboardAdvanceEventRow {
  return { event_kind: "ADVANCE", event_index: index, event_date: date, is_enabled: true, ...overrides };
}

const REAL_ADVANCES = [advanceRow(1, "2026-04-03"), advanceRow(2, "2026-05-05"), advanceRow(3, "2026-06-05")];

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
    usageDaily: [],
    advanceEvents: [],
    now: new Date("2026-10-05T12:00:00Z"),
    ...overrides,
  };
}

const STAGE_KEYS: CompletionStageKey[] = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"];

function point(analytics: DashboardAnalytics, period: string) {
  const found = analytics.validationsByPeriod.find((item) => item.period === period);
  assert.ok(found, `falta el periodo ${period}`);
  return found;
}

function lastCumulative(analytics: DashboardAnalytics) {
  const points = analytics.cumulativeStageProgress.points;
  return points[points.length - 1].stages;
}

// --- Utilidades de fecha -------------------------------------------------------------------

assert.equal(nextDate("2026-04-03"), "2026-04-04");
assert.equal(nextDate("2026-12-31"), "2027-01-01");
assert.equal(nextDate("2028-02-28"), "2028-02-29");
assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
assert.deepEqual(monthsBetween("2026-03", "2026-03"), ["2026-03"]);
assert.deepEqual(monthsBetween("2026-04", "2026-03"), []);

{
  // Cohorte vacía: rango del acceso, eje mensual del acceso sin pasar del mes actual, series en
  // cero, sin horas, notas E1-E10 con count 0.
  const { analytics } = buildTeacherDashboard(input({}));
  assert.deepEqual(analytics.range, { from: "2026-01-07", to: "2026-09-28", timezone: "America/La_Paz" });
  assert.deepEqual(
    analytics.validationsByPeriod.map((item) => item.period),
    monthsBetween("2026-01", "2026-09")
  );
  assert.ok(analytics.validationsByPeriod.every((item) => item.total === 0));
  assert.deepEqual(analytics.hoursByPeriod, []);
  assert.equal(analytics.activityByPeriod.timezone, "UTC");
  assert.equal(analytics.scoreDistributions.length, 10);
  assert.deepEqual(analytics.advanceEvents, []);
  assert.deepEqual(analytics.advanceWindows, { status: "missing_advance_dates", windows: [] });
}

{
  // 1. E0 nunca recibe fecha: un contexto confirmado no entra en ninguna serie ni como "sin
  // fecha", y las series no tienen clave e0.
  const dash = buildTeacherDashboard(
    input({ students: [student(A, "Alba")], caseContexts: [{ user_id: A, status: "confirmed" }] })
  );
  assert.equal(dash.stageTotals.e0, 1);
  assert.equal(dash.students[0].progress[0].validatedAt, null);
  const { analytics } = dash;
  assert.ok(analytics.validationsByPeriod.every((item) => item.total === 0));
  for (const item of analytics.validationsByPeriod) assert.deepEqual(Object.keys(item.byStage), STAGE_KEYS);
  assert.deepEqual(Object.keys(lastCumulative(analytics)), STAGE_KEYS);
  assert.deepEqual(Object.keys(analytics.cumulativeStageProgress.undated), STAGE_KEYS);
  assert.ok(Object.values(analytics.cumulativeStageProgress.undated).every((n) => n === 0));
  assert.ok(analytics.scoreDistributions.every((item) => (item.stage as number) !== 0));
}

{
  // 2-3. E1 usa la primera evaluación, no el created_at del artefacto (borrador, marzo) ni su
  // period_key (mes de los datos, 2025-09). Una segunda evaluación posterior no suma.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [validated(A, 1, "2026-03-10T10:00:00+00:00", "2025-09")],
      evaluations: [
        evaluation(A, 1, 100, "2026-05-20T15:00:00+00:00"),
        evaluation(A, 1, 100, "2026-04-02T15:00:00+00:00"),
      ],
    })
  );
  const { analytics } = dash;
  assert.equal(point(analytics, "2026-03").byStage.e1, 0);
  assert.equal(point(analytics, "2026-04").byStage.e1, 1);
  assert.equal(point(analytics, "2026-05").byStage.e1, 0);
  assert.equal(analytics.validationsByPeriod.some((item) => item.period.startsWith("2025")), false);
  assert.equal(analytics.validationsByPeriod[0].period, "2026-01");
  // El snapshot no cambia: validatedAt de E1 sigue siendo el del artefacto.
  assert.equal(dash.students[0].progress[1].validatedAt, "2026-03-10T10:00:00+00:00");
}

{
  // E1 cerrado sin evaluación: no se inventa fecha, queda en undated. Una evaluación de E1 sin
  // artefacto validado no cuenta (el snapshot no lo da por cerrado).
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      artifacts: [validated(A, 1, "2026-03-10T10:00:00+00:00")],
      evaluations: [evaluation(B, 1, 90, "2026-03-11T10:00:00+00:00")],
    })
  );
  const { analytics } = dash;
  assert.equal(dash.stageTotals.e1, 1);
  assert.equal(analytics.cumulativeStageProgress.undated.e1, 1);
  assert.equal(lastCumulative(analytics).e1, 0);
  assert.ok(analytics.validationsByPeriod.every((item) => item.byStage.e1 === 0));
}

{
  // 4-5. E2-E10: primera finalización por estudiante y etapa. Dos periodos de E2 cuentan una vez
  // (en el primero); v1/v2 del documento final en borrador no son cierres; E10 cuenta una vez.
  const { analytics } = buildTeacherDashboard(
    input({
      students: [student(A, "Alba")],
      artifacts: [
        validated(A, 2, "2026-04-15T10:00:00+00:00", "2026-04"),
        validated(A, 2, "2026-02-15T10:00:00+00:00", "2026-02"),
        { ...validated(A, 10, "2026-06-10T10:00:00+00:00"), artifact_type: "final_doc_v1", status: "draft" },
        { ...validated(A, 10, "2026-06-12T10:00:00+00:00"), artifact_type: "final_doc_v2", status: "draft" },
        validated(A, 10, "2026-06-12T10:00:01+00:00"),
      ],
    })
  );
  assert.equal(point(analytics, "2026-02").byStage.e2, 1);
  assert.equal(point(analytics, "2026-04").byStage.e2, 0);
  assert.equal(point(analytics, "2026-06").byStage.e10, 1);
  assert.equal(point(analytics, "2026-06").total, 1);
  const totals = analytics.validationsByPeriod.reduce((sum, item) => sum + item.total, 0);
  assert.equal(totals, 2);
  assert.equal(lastCumulative(analytics).e2, 1);
  assert.equal(lastCumulative(analytics).e10, 1);
}

{
  // 6. Agrupación mensual en La Paz: 2026-04-01 02:30 UTC es 2026-03-31 22:30 en La Paz.
  const { analytics } = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      artifacts: [
        validated(A, 2, "2026-04-01T02:30:00+00:00"),
        validated(B, 2, "2026-04-01T04:30:00+00:00"),
      ],
    })
  );
  assert.equal(point(analytics, "2026-03").byStage.e2, 1);
  assert.equal(point(analytics, "2026-04").byStage.e2, 1);
}

{
  // 7-8. Acumulado monotónico por etapa, etapas independientes (E2 supera a E1: E1 se puede
  // saltar) y último punto + undated = stageTotals E1-E10.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo"), student(C, "Ceta")],
      caseContexts: [{ user_id: A, status: "confirmed" }],
      artifacts: [
        validated(A, 1, "2026-02-01T10:00:00+00:00"),
        validated(A, 2, "2026-03-01T10:00:00+00:00"),
        validated(B, 2, "2026-03-05T10:00:00+00:00"),
        validated(C, 2, "2026-06-05T10:00:00+00:00"),
        validated(A, 3, "2026-06-10T10:00:00+00:00"),
        validated(C, 1, "2026-06-01T10:00:00+00:00"),
      ],
      evaluations: [evaluation(A, 1, 100, "2026-02-01T10:00:02+00:00")],
    })
  );
  const { analytics, stageTotals } = dash;
  const points = analytics.cumulativeStageProgress.points;
  for (const key of STAGE_KEYS) {
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i].stages[key] >= points[i - 1].stages[key], `${key} decrece en ${points[i].period}`);
    }
  }
  const last = lastCumulative(analytics);
  assert.ok(last.e2 > last.e1);
  for (const key of STAGE_KEYS) {
    assert.equal(last[key] + analytics.cumulativeStageProgress.undated[key], stageTotals[key], key);
  }
  // C cerró E1 sin evaluación: queda sin fecha.
  assert.equal(analytics.cumulativeStageProgress.undated.e1, 1);
  assert.deepEqual(
    points.map((item) => item.period),
    analytics.validationsByPeriod.map((item) => item.period)
  );
}

{
  // 9-10. Horas: solo semanas con registros (sin registro no es 0 h y no aparece); un registro
  // de 0 h sí cuenta como registro; acumulado por semana.
  const dash = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo"), student(C, "Ceta")],
      hours: [
        hoursRow(A, 10, "2026-03-07", "2026-03-13"),
        hoursRow(B, "2.5", "2026-03-07", "2026-03-13"),
        hoursRow(A, 0, "2026-03-21", "2026-03-27"),
      ],
    })
  );
  const { analytics } = dash;
  assert.deepEqual(analytics.hoursByPeriod, [
    { periodStart: "2026-03-07", periodEnd: "2026-03-13", totalHours: 12.5, entries: 2, studentsWithRecords: 2, cumulativeHours: 12.5 },
    { periodStart: "2026-03-21", periodEnd: "2026-03-27", totalHours: 0, entries: 1, studentsWithRecords: 1, cumulativeHours: 12.5 },
  ]);
  // La semana del 14 no tiene registros: no se inventa como 0.
  assert.equal(analytics.hoursByPeriod.some((week) => week.periodStart === "2026-03-14"), false);
  // C no tiene registros: su total sigue null en el snapshot.
  assert.equal(dash.students.find((s) => s.lastName === "Ceta")?.hours.total, null);
}

{
  // 11. advanceEvents: solo ADVANCE 1-3 habilitados, ordenados por índice, con la referencia de
  // etapas y sin campos de cumplimiento.
  const events = buildAdvanceEvents([
    advanceRow(3, "2026-06-05"),
    advanceRow(1, "2026-04-03"),
    advanceRow(null, "2026-03-01"),
    advanceRow(2, "2026-05-05"),
    advanceRow(1, "2026-04-20", { is_enabled: false }),
    advanceRow(1, "2026-02-27", { event_kind: "FORM_INITIAL" }),
  ]);
  assert.deepEqual(events, [
    { index: 1, date: "2026-04-03", label: "Avance 1", referenceStageRange: { from: 1, to: 5 } },
    { index: 2, date: "2026-05-05", label: "Avance 2", referenceStageRange: { from: 6, to: 8 } },
    { index: 3, date: "2026-06-05", label: "Avance 3", referenceStageRange: { from: 9, to: 9 } },
  ]);
  for (const event of events) {
    for (const forbidden of ["completed", "compliant", "onTime", "late", "failed"]) {
      assert.equal(forbidden in event, false);
    }
  }
}

{
  // Ventanas de referencia: hasta A1, día siguiente → A2, día siguiente → A3, día siguiente en
  // adelante. Inclusivas, en días de La Paz; la primera sin inicio y la última sin fin.
  const { status, bounds } = buildAdvanceWindowBounds(buildAdvanceEvents(REAL_ADVANCES));
  assert.equal(status, "available");
  assert.deepEqual(
    bounds.map((b) => [b.key, b.advanceIndex, b.label, b.from, b.to, b.referenceStageRange]),
    [
      ["advance1", 1, "Avance 1", null, "2026-04-03", { from: 1, to: 5 }],
      ["advance2", 2, "Avance 2", "2026-04-04", "2026-05-05", { from: 6, to: 8 }],
      ["advance3", 3, "Avance 3", "2026-05-06", "2026-06-05", { from: 9, to: 9 }],
      ["afterAdvance3", null, "Después del Avance 3", "2026-06-06", null, null],
    ]
  );

  // Falta un avance: no se arman ventanas.
  assert.deepEqual(buildAdvanceWindowBounds(buildAdvanceEvents(REAL_ADVANCES.slice(0, 2))), {
    status: "missing_advance_dates",
    bounds: [],
  });
  // Fechas fuera de orden: tampoco.
  assert.deepEqual(
    buildAdvanceWindowBounds(
      buildAdvanceEvents([advanceRow(1, "2026-05-10"), advanceRow(2, "2026-05-05"), advanceRow(3, "2026-06-05")])
    ),
    { status: "unordered_dates", bounds: [] }
  );
}

{
  // Resumen por ventana: el día del avance cuenta en su ventana (2026-04-04 03:00 UTC es
  // 2026-04-03 23:00 en La Paz); horas por period_start; actividad por día UTC.
  const { analytics } = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      artifacts: [
        validated(A, 2, "2026-04-04T03:00:00+00:00"),
        validated(B, 2, "2026-04-04T05:00:00+00:00"),
        validated(A, 9, "2026-06-20T10:00:00+00:00"),
      ],
      hours: [
        // Semana anterior al inicio de acceso (2026-01-07): cae en la ventana 1, no se pierde.
        hoursRow(B, 15, "2026-01-03", "2026-01-09"),
        hoursRow(A, 5, "2026-03-28", "2026-04-03"),
        hoursRow(A, 7, "2026-05-02", "2026-05-08"),
      ],
      usageDaily: [
        usageRow(A, "2026-04-03", 4),
        usageRow(B, "2026-04-04", 6),
        usageRow(B, "2026-04-05", 0),
        usageRow(A, "2026-09-30", 2),
      ],
      advanceEvents: REAL_ADVANCES,
    })
  );
  assert.equal(analytics.advanceWindows.status, "available");
  const windows = analytics.advanceWindows.windows;
  const [w1, w2, w3, after] = windows;
  assert.equal(w1.summary.validations.total, 1);
  assert.equal(w1.summary.validations.byStage.e2, 1);
  assert.equal(w2.summary.validations.byStage.e2, 1);
  assert.equal(after.summary.validations.byStage.e9, 1);
  assert.equal(w3.summary.validations.total, 0);
  assert.deepEqual(w1.summary.hours, { totalHours: 20, entries: 2, studentsWithRecords: 2 });
  // La semana del 2 al 8 de mayo empieza antes del Avance 2 (5 de mayo): cuenta en la ventana 2.
  assert.deepEqual(w2.summary.hours, { totalHours: 7, entries: 1, studentsWithRecords: 1 });
  assert.deepEqual(w3.summary.hours, { totalHours: null, entries: 0, studentsWithRecords: 0 });
  assert.deepEqual(w1.summary.activity, { timezone: "UTC", studentMessages: 4, activeStudents: 1 });
  assert.deepEqual(w2.summary.activity, { timezone: "UTC", studentMessages: 6, activeStudents: 1 });
  // Después del fin de acceso (2026-09-28) también cuenta: la última ventana no tiene fin.
  assert.deepEqual(after.summary.activity, { timezone: "UTC", studentMessages: 2, activeStudents: 1 });

  // Las ventanas parten la línea de tiempo: sus sumas dan los totales.
  const sum = (pick: (w: (typeof windows)[number]) => number) => windows.reduce((s, w) => s + pick(w), 0);
  assert.equal(sum((w) => w.summary.validations.total), 3);
  assert.equal(sum((w) => w.summary.hours.entries), analytics.hoursByPeriod.reduce((s, h) => s + h.entries, 0));
  assert.equal(
    sum((w) => w.summary.activity.studentMessages),
    analytics.activityByPeriod.points.reduce((s, p) => s + p.studentMessages, 0)
  );
}

{
  // 12-13. Notas: estadísticas separadas por etapa, solo de evaluaciones; la vigente por
  // estudiante (la más reciente). Una etapa validada sin evaluación tiene count 0. No hay nota
  // general.
  const { analytics } = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo"), student(C, "Ceta")],
      artifacts: [
        validated(A, 2, "2026-03-01T10:00:00+00:00"),
        validated(B, 2, "2026-03-02T10:00:00+00:00"),
        validated(C, 3, "2026-03-03T10:00:00+00:00"),
        validated(A, 4, "2026-06-15T10:00:00+00:00"),
      ],
      evaluations: [
        evaluation(A, 2, 60, "2026-03-01T10:00:10+00:00", "Regular"),
        evaluation(A, 2, 80, "2026-03-20T10:00:10+00:00", "Adecuado"),
        evaluation(B, 2, "90.5", "2026-03-02T10:00:10+00:00", "Bien"),
        evaluation(C, 3, 70, "2026-03-03T10:00:10+00:00", "Regular"),
      ],
    })
  );
  const byStage = new Map(analytics.scoreDistributions.map((item) => [item.stage, item]));
  assert.deepEqual(
    analytics.scoreDistributions.map((item) => item.stage),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.deepEqual(byStage.get(2), {
    stage: 2,
    count: 2,
    min: 80,
    max: 90.5,
    average: 85.25,
    labels: { Adecuado: 1, Bien: 1 },
  });
  assert.deepEqual(byStage.get(3), { stage: 3, count: 1, min: 70, max: 70, average: 70, labels: { Regular: 1 } });
  assert.deepEqual(byStage.get(4), { stage: 4, count: 0, min: null, max: null, average: null, labels: {} });
  const keys = Object.keys(analytics);
  assert.deepEqual(keys, [
    "range",
    "advanceEvents",
    "advanceWindows",
    "validationsByPeriod",
    "cumulativeStageProgress",
    "hoursByPeriod",
    "activityByPeriod",
    "scoreDistributions",
  ]);
}

{
  // 14. Actividad: meses de días UTC, declarados como UTC; activo = al menos un mensaje propio.
  const { analytics } = buildTeacherDashboard(
    input({
      students: [student(A, "Alba"), student(B, "Bravo")],
      usageDaily: [
        usageRow(A, "2026-03-31", 3),
        usageRow(A, "2026-04-01", "2"),
        usageRow(B, "2026-04-15", 0),
        usageRow(C, "2026-04-15", 50),
      ],
    })
  );
  assert.equal(analytics.activityByPeriod.timezone, "UTC");
  const march = analytics.activityByPeriod.points.find((item) => item.period === "2026-03");
  const april = analytics.activityByPeriod.points.find((item) => item.period === "2026-04");
  const may = analytics.activityByPeriod.points.find((item) => item.period === "2026-05");
  assert.deepEqual(march, { period: "2026-03", studentMessages: 3, activeStudents: 1 });
  // C no es de la cohorte; B tiene un día sin mensajes propios: no está activo.
  assert.deepEqual(april, { period: "2026-04", studentMessages: 2, activeStudents: 1 });
  assert.deepEqual(may, { period: "2026-05", studentMessages: 0, activeStudents: 0 });
}

{
  // Eje mensual: no pasa del mes actual aunque el acceso siga; sin fechas de acceso, el rango
  // sale de la extensión de los datos.
  const early = buildTeacherDashboard(input({ now: new Date("2026-05-10T12:00:00Z") })).analytics;
  assert.equal(early.validationsByPeriod[early.validationsByPeriod.length - 1].period, "2026-05");

  const noAccess = buildTeacherDashboard(
    input({
      cohort: { ...COHORT, access_starts_at: null, access_ends_at: null },
      students: [student(A, "Alba")],
      artifacts: [validated(A, 2, "2026-03-15T10:00:00+00:00")],
      hours: [hoursRow(A, 4, "2026-05-02", "2026-05-08")],
    })
  ).analytics;
  assert.deepEqual(noAccess.range, { from: "2026-03-15", to: "2026-05-02", timezone: "America/La_Paz" });
  assert.deepEqual(
    noAccess.validationsByPeriod.map((item) => item.period),
    ["2026-03", "2026-04", "2026-05"]
  );
}

console.log("teacherDashboardAnalytics tests passed");
