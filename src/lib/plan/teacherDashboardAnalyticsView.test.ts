import assert from "node:assert/strict";

import type { DashboardStudent } from "../teacher/dashboard/aggregate";
import type { AdvanceWindow, DashboardAnalytics, StageCounts } from "../teacher/dashboard/analytics";
import {
  advanceMarkers,
  dateEndPosition,
  datePosition,
  defaultAnalysisStage,
  findWindow,
  formatDateRange,
  formatDay,
  formatMonth,
  formatMonthTick,
  hoursDistribution,
  monthDetail,
  niceMax,
  periodOptions,
  scoreDistributionFor,
  scoreLabelRows,
  spanPositions,
  stageBreakdown,
  stageClosuresByMonth,
  windowsNotice,
} from "../teacher/dashboard/analyticsView";

// Funciones puras de presentación de analytics del panel docente
// (src/lib/teacher/dashboard/analyticsView.ts). Vive aquí porque el runner solo recorre
// src/lib/plan.

function counts(values: Partial<StageCounts> = {}): StageCounts {
  return { e1: 0, e2: 0, e3: 0, e4: 0, e5: 0, e6: 0, e7: 0, e8: 0, e9: 0, e10: 0, ...values };
}

function window(
  key: AdvanceWindow["key"],
  from: string | null,
  to: string | null,
  overrides: Partial<AdvanceWindow> = {}
): AdvanceWindow {
  const index = key === "advance1" ? 1 : key === "advance2" ? 2 : key === "advance3" ? 3 : null;
  return {
    key,
    advanceIndex: index,
    label: index === null ? "Después del Avance 3" : `Avance ${index}`,
    from,
    to,
    referenceStageRange: null,
    summary: {
      validations: { total: 0, byStage: counts() },
      hours: { totalHours: null, entries: 0, studentsWithRecords: 0 },
      activity: { timezone: "UTC", studentMessages: 0, activeStudents: 0 },
    },
    ...overrides,
  };
}

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

const ANALYTICS: DashboardAnalytics = {
  range: { from: "2026-01-07", to: "2026-06-28", timezone: "America/La_Paz" },
  advanceEvents: [
    { index: 1, date: "2026-04-03", label: "Avance 1", referenceStageRange: { from: 1, to: 5 } },
    { index: 2, date: "2026-05-05", label: "Avance 2", referenceStageRange: { from: 6, to: 8 } },
    { index: 3, date: "2026-08-05", label: "Avance 3", referenceStageRange: { from: 9, to: 9 } },
  ],
  advanceWindows: {
    status: "available",
    windows: [
      window("advance1", null, "2026-04-03"),
      window("advance2", "2026-04-04", "2026-05-05"),
      window("advance3", "2026-05-06", "2026-08-05"),
      window("afterAdvance3", "2026-08-06", null),
    ],
  },
  validationsByPeriod: MONTHS.map((period) => ({
    period,
    total: period === "2026-03" ? 3 : 0,
    byStage: period === "2026-03" ? counts({ e2: 2, e4: 1 }) : counts(),
  })),
  cumulativeStageProgress: {
    points: MONTHS.map((period) => ({
      period,
      stages: period >= "2026-03" ? counts({ e2: 2, e4: 1 }) : counts(),
    })),
    undated: counts(),
  },
  hoursByPeriod: [
    { periodStart: "2026-02-28", periodEnd: "2026-03-06", totalHours: 3.5, entries: 1, studentsWithRecords: 1, cumulativeHours: 3.5 },
    { periodStart: "2026-03-07", periodEnd: "2026-03-13", totalHours: 10.25, entries: 2, studentsWithRecords: 2, cumulativeHours: 13.75 },
    { periodStart: "2026-03-28", periodEnd: "2026-04-03", totalHours: 0, entries: 1, studentsWithRecords: 1, cumulativeHours: 13.75 },
  ],
  activityByPeriod: {
    timezone: "UTC",
    points: MONTHS.map((period) => ({
      period,
      studentMessages: period === "2026-03" ? 120 : 0,
      activeStudents: period === "2026-03" ? 4 : 0,
    })),
  },
  scoreDistributions: [
    { stage: 1, count: 2, min: 90, max: 100, average: 95, labels: { Bien: 2 } },
    { stage: 4, count: 0, min: null, max: null, average: null, labels: {} },
    { stage: 9, count: 3, min: 52, max: 97, average: 68, labels: { Regular: 2, Bien: 1, Otra: 1 } },
  ],
};

// --- Formato de periodos ---------------------------------------------------------------------

assert.equal(formatMonth("2026-03"), "mar 2026");
assert.equal(formatMonth("2026-12"), "dic 2026");
assert.equal(formatMonthTick("2026-03", 0), "mar 2026");
assert.equal(formatMonthTick("2026-04", 1), "abr");
assert.equal(formatMonthTick("2027-01", 5), "ene 2027");
assert.equal(formatDay("2026-04-03"), "3 abr 2026");
assert.equal(formatDateRange(null, "2026-04-03"), "Hasta 3 abr 2026");
assert.equal(formatDateRange("2026-04-04", "2026-05-05"), "4 abr – 5 may 2026");
assert.equal(formatDateRange("2026-12-20", "2027-01-05"), "20 dic 2026 – 5 ene 2027");
assert.equal(formatDateRange("2026-06-06", null), "Desde 6 jun 2026");
assert.equal(formatDateRange(null, null), "Sin límite de fechas");

// --- Filtro de periodo -------------------------------------------------------------------------

{
  const options = periodOptions(ANALYTICS);
  assert.deepEqual(
    options.map((option) => [option.value, option.label, option.detail, option.disabled]),
    [
      ["all", "Periodo completo", "7 ene – 28 jun 2026", false],
      ["advance1", "Avance 1", "Hasta 3 abr 2026", false],
      ["advance2", "Avance 2", "4 abr – 5 may 2026", false],
      ["advance3", "Avance 3", "6 may – 5 ago 2026", false],
      ["afterAdvance3", "Después del Avance 3", "Desde 6 ago 2026", false],
    ]
  );
  // Ninguna opción habla de cumplimiento.
  for (const option of options) {
    assert.doesNotMatch(`${option.label} ${option.detail}`, /cumpli|a tiempo|retras/i);
  }
  assert.equal(findWindow(ANALYTICS, "all"), null);
  assert.equal(findWindow(ANALYTICS, "advance2")?.to, "2026-05-05");
  assert.equal(windowsNotice("available"), null);

  // Sin ventanas: las cuatro opciones quedan deshabilitadas con explicación; "Periodo completo"
  // sigue disponible.
  const missing: DashboardAnalytics = {
    ...ANALYTICS,
    advanceWindows: { status: "missing_advance_dates", windows: [] },
  };
  const disabled = periodOptions(missing);
  assert.deepEqual(disabled.map((option) => option.disabled), [false, true, true, true, true]);
  assert.equal(findWindow(missing, "advance1"), null);
  assert.match(windowsNotice("missing_advance_dates") ?? "", /tres fechas de avance/);
  assert.match(windowsNotice("unordered_dates") ?? "", /no están en orden/);
}

// --- Eje temporal --------------------------------------------------------------------------

assert.equal(datePosition(MONTHS, "2026-01-01"), 0);
assert.equal(datePosition(MONTHS, "2026-04-16"), 3.5);
assert.equal(datePosition(MONTHS, "2025-12-31"), null);
assert.equal(datePosition(MONTHS, "2026-07-01"), null);
assert.equal(datePosition(MONTHS, "mal"), null);
// Posiciones fraccionarias: se comparan con tolerancia de coma flotante.
function near(actual: number | null | undefined, expected: number) {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}
function nearSpan(actual: { start: number; end: number } | null, start: number, end: number) {
  near(actual?.start, start);
  near(actual?.end, end);
}

near(dateEndPosition(MONTHS, "2026-06-30"), 6);
// Semana que cruza de mes: termina dentro del mes siguiente.
nearSpan(spanPositions(MONTHS, "2026-02-28", "2026-03-06"), 1 + 27 / 28, 2 + 6 / 31);
// Ventanas abiertas o que salen del eje se recortan a sus bordes.
nearSpan(spanPositions(MONTHS, null, "2026-01-31"), 0, 1);
nearSpan(spanPositions(MONTHS, "2026-06-01", null), 5, 6);
nearSpan(spanPositions(MONTHS, "2025-11-01", "2026-01-31"), 0, 1);
assert.equal(spanPositions(MONTHS, "2026-08-06", null), null);
assert.equal(spanPositions(MONTHS, null, "2025-12-01"), null);
assert.equal(spanPositions([], null, null), null);

// Referencias de los avances: solo las que caen en el eje, como fecha de referencia.
assert.deepEqual(advanceMarkers(MONTHS, ANALYTICS.advanceEvents), [
  { position: 3 + 2 / 30, label: "A1", title: "Fecha de referencia — Avance 1 (3 abr 2026)" },
  { position: 4 + 4 / 31, label: "A2", title: "Fecha de referencia — Avance 2 (5 may 2026)" },
]);

// Máximo del eje vertical: redondo y con mitad de al menos 1.
assert.equal(niceMax(0), 2);
assert.equal(niceMax(1), 2);
assert.equal(niceMax(3), 4);
assert.equal(niceMax(12), 20);
assert.equal(niceMax(44), 60);
assert.equal(niceMax(100), 100);
assert.equal(niceMax(124), 200);
assert.equal(niceMax(5499), 6000);

// --- Validaciones, acumulado y mes --------------------------------------------------------------

assert.deepEqual(stageBreakdown(counts({ e2: 2, e4: 1 })), [
  { stage: 2, count: 2 },
  { stage: 4, count: 1 },
]);
assert.deepEqual(stageBreakdown(counts()), []);
assert.deepEqual(
  stageClosuresByMonth(ANALYTICS, 2).map((item) => item.count),
  [0, 0, 2, 0, 0, 0]
);

{
  const march = monthDetail(ANALYTICS, "2026-03");
  assert.equal(march.validations?.total, 3);
  assert.deepEqual(march.cumulative?.stages, counts({ e2: 2, e4: 1 }));
  assert.equal(march.activity?.studentMessages, 120);
  // Semanas que empiezan en marzo (la del 28 de febrero no): 10,25 h + 0 h (registro real de 0).
  assert.deepEqual(march.hours, { totalHours: 10.25, entries: 3, weeks: 2 });
  // Sin semanas con registros, las horas son null (no 0).
  assert.deepEqual(monthDetail(ANALYTICS, "2026-05").hours, { totalHours: null, entries: 0, weeks: 0 });
}

// --- Horas por estudiante -----------------------------------------------------------------------

function student(userId: string, total: number | null): DashboardStudent {
  return {
    userId,
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
    hours: { entries: total === null ? 0 : 1, total },
    activity: { messagesSent: null, lastMessageAt: null },
    finalDocument: { latestVersion: null, closed: false },
  };
}

{
  const distribution = hoursDistribution([
    student("a", null),
    student("b", null),
    student("c", 0),
    student("d", 9.99),
    student("e", 10),
    student("f", 44),
    student("g", 124),
  ]);
  assert.deepEqual(
    distribution.bins.map((bin) => [bin.label, bin.count]),
    [
      ["0–10 h", 2],
      ["10–25 h", 1],
      ["25–50 h", 1],
      ["50–100 h", 0],
      ["100 h o más", 1],
    ]
  );
  // Sin registros es una categoría aparte; 0 h con registro sí entra en el primer rango.
  assert.equal(distribution.withoutRecords, 2);
  assert.equal(distribution.withRecords, 5);
  // Determinista: misma entrada, mismo resultado.
  assert.deepEqual(hoursDistribution([student("x", 25)]), hoursDistribution([student("x", 25)]));
}

// --- Vista Etapas ----------------------------------------------------------------------------------

{
  const totals = { e0: 27, e1: 20, e2: 24, e3: 23, e4: 20, e5: 6, e6: 6, e7: 5, e8: 5, e9: 5, e10: 3 };
  assert.equal(defaultAnalysisStage(totals, 30), 10);
  // Empate: la etapa menor.
  assert.equal(defaultAnalysisStage({ ...totals, e5: 3, e10: 3 }, 30), 5);
  assert.equal(defaultAnalysisStage(totals, 0), 1);
}

assert.equal(scoreDistributionFor(ANALYTICS, 0), null);
assert.equal(scoreDistributionFor(ANALYTICS, 4)?.count, 0);
assert.equal(scoreDistributionFor(ANALYTICS, 2), null);
// Escala fija primero (con ceros), etiquetas fuera de escala al final.
assert.deepEqual(scoreLabelRows(ANALYTICS.scoreDistributions[2]), [
  { label: "Deficiente", count: 0 },
  { label: "Regular", count: 2 },
  { label: "Adecuado", count: 0 },
  { label: "Bien", count: 1 },
  { label: "Otra", count: 1 },
]);

console.log("teacherDashboardAnalyticsView tests passed");
