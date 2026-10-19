import assert from "node:assert/strict";

import {
  activityLabel,
  describeMonthlyPattern,
  formatDateOnly,
  monthlyFollowupDates,
  monthlyPatternOf,
  planMonthlyFollowups,
  type MonthlyPattern,
} from "../calendar/cohortSchedule";

// Seguimientos mensuales de la cohorte: tres meses seguidos (incluido el de la fecha base) con el
// mismo día de la semana y la misma posición en el mes; el último se conserva como último. Sin
// depender de la zona horaria. Las fechas ya guardadas no se mueven si el docente no cambia la
// base. Nombres visibles de los ocho eventos.

const dates = (base: string) => monthlyFollowupDates(base)?.dates ?? null;

function patternOf(date: string): MonthlyPattern {
  const pattern = monthlyPatternOf(date);
  assert.ok(pattern, `fecha válida: ${date}`);
  return pattern;
}

// =============== Primer sábado ===============
assert.deepEqual(dates("2026-10-03"), ["2026-10-03", "2026-11-07", "2026-12-05"]);
assert.equal(describeMonthlyPattern(patternOf("2026-10-03")), "primer sábado de cada mes");
assert.deepEqual(dates("2026-10-10"), ["2026-10-10", "2026-11-14", "2026-12-12"], "segundo sábado");

// =============== Último sábado ===============
assert.deepEqual(dates("2026-10-31"), ["2026-10-31", "2026-11-28", "2026-12-26"], "quinto = último");
assert.equal(describeMonthlyPattern(patternOf("2026-10-31")), "último sábado de cada mes");
// El 28/11 es el cuarto y también el último: se conserva el último (enero de 2027 tiene cinco).
assert.deepEqual(dates("2026-11-28"), ["2026-11-28", "2026-12-26", "2027-01-30"]);
// Un cuarto sábado que no es el último sigue siendo el cuarto (octubre: 24, no 31).
assert.deepEqual(dates("2026-08-22"), ["2026-08-22", "2026-09-26", "2026-10-24"]);
assert.equal(describeMonthlyPattern(patternOf("2026-08-22")), "cuarto sábado de cada mes");

// =============== Cambio de año ===============
assert.deepEqual(dates("2026-11-07"), ["2026-11-07", "2026-12-05", "2027-01-02"]);
assert.deepEqual(dates("2026-12-26"), ["2026-12-26", "2027-01-30", "2027-02-27"]);

// =============== Febrero ===============
// La regla anterior (mismo número de día) llevaba el 31/01 al 03/03.
assert.deepEqual(dates("2026-01-31"), ["2026-01-31", "2026-02-28", "2026-03-28"]);
assert.deepEqual(dates("2026-01-24"), ["2026-01-24", "2026-02-28", "2026-03-28"], "cuarto sábado");
assert.deepEqual(dates("2028-01-25"), ["2028-01-25", "2028-02-29", "2028-03-28"], "último martes, año bisiesto");
assert.deepEqual(dates("2026-02-07"), ["2026-02-07", "2026-03-07", "2026-04-04"]);

// =============== Cualquier día de 2026-2028, contra un recuento a mano ===============
function sameWeekdayDays(year: number, month: number, weekday: number): number[] {
  const out: number[] = [];
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break;
    if (d.getUTCDay() === weekday) out.push(day);
  }
  return out;
}
for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2028, 11, 31); t += 86_400_000) {
  const d = new Date(t);
  const base = d.toISOString().slice(0, 10);
  const weekday = d.getUTCDay();
  const inBaseMonth = sameWeekdayDays(d.getUTCFullYear(), d.getUTCMonth() + 1, weekday);
  const at = inBaseMonth.indexOf(d.getUTCDate());
  const isLast = at === inBaseMonth.length - 1;
  const got = dates(base);
  assert.ok(got && got.length === 3, base);
  assert.equal(got[0], base, `${base}: el primero es la fecha base`);
  got.forEach((date, i) => {
    const [y, m, day] = date.split("-").map(Number);
    const expectedMonth = (d.getUTCFullYear() * 12 + d.getUTCMonth() + i) % 12;
    assert.equal(m - 1, expectedMonth, `${base} -> ${date}: meses consecutivos`);
    const days = sameWeekdayDays(y, m, weekday);
    assert.equal(day, isLast ? days[days.length - 1] : days[at], `${base} -> ${date}: misma posición`);
  });
}

// =============== Sin desplazamientos por zona horaria ===============
const originalTz = process.env.TZ;
for (const tz of ["Pacific/Pago_Pago", "Pacific/Kiritimati", "America/La_Paz", "UTC"]) {
  process.env.TZ = tz;
  assert.deepEqual(dates("2026-10-03"), ["2026-10-03", "2026-11-07", "2026-12-05"], tz);
  assert.deepEqual(dates("2026-10-31"), ["2026-10-31", "2026-11-28", "2026-12-26"], tz);
  assert.equal(formatDateOnly("2026-10-03"), "03/10/2026", tz);
}
// Comprobación del entorno: en UTC-11 una fecha leída como medianoche UTC cae el día anterior.
process.env.TZ = "Pacific/Pago_Pago";
assert.equal(new Date("2026-10-03").getDay(), 5, "el cambio de TZ se aplica");
if (originalTz === undefined) delete process.env.TZ;
else process.env.TZ = originalTz;

// =============== Fechas inválidas ===============
for (const bad of ["", "2026-02-30", "2026-13-01", "2026-1-3", "0026-10-03", "texto"]) {
  assert.equal(dates(bad), null, `inválida: "${bad}"`);
}
assert.deepEqual(planMonthlyFollowups({ base: "", saved: [], keepSaved: false }).dates, [], "sin base, sin seguimientos");

// =============== Fechas ya existentes ===============
const legacy = ["2026-10-03", "2026-11-03", "2026-12-03"]; // regla anterior: mismo número de día
const pattern = ["2026-10-03", "2026-11-07", "2026-12-05"];

// Abrir la cohorte y guardar sin tocar la base: se guardan las mismas (no se reenvía nada).
let plan = planMonthlyFollowups({ base: "2026-10-03", saved: legacy, keepSaved: true });
assert.equal(plan.source, "saved");
assert.deepEqual(plan.dates, legacy);
assert.equal(plan.followsPattern, false, "se avisa que no siguen el patrón");
assert.deepEqual(plan.patternDates, pattern);

// "Recalcular" o cambiar la base: el patrón.
plan = planMonthlyFollowups({ base: "2026-10-03", saved: legacy, keepSaved: false });
assert.deepEqual([plan.source, plan.dates], ["pattern", pattern]);
plan = planMonthlyFollowups({ base: "2026-10-10", saved: legacy, keepSaved: true });
assert.deepEqual([plan.source, plan.dates], ["pattern", ["2026-10-10", "2026-11-14", "2026-12-12"]], "otra base, otras fechas");

// Guardadas que ya siguen el patrón: sin aviso.
plan = planMonthlyFollowups({ base: "2026-10-03", saved: pattern, keepSaved: true });
assert.deepEqual([plan.source, plan.dates, plan.followsPattern], ["saved", pattern, true]);

// Incompletas (falta algún seguimiento) o cohorte nueva: el patrón completa los tres.
plan = planMonthlyFollowups({ base: "2026-10-03", saved: ["2026-10-03", "2026-11-03", ""], keepSaved: true });
assert.deepEqual([plan.source, plan.dates], ["pattern", pattern]);
plan = planMonthlyFollowups({ base: "2026-10-03", saved: [], keepSaved: false });
assert.deepEqual([plan.source, plan.dates], ["pattern", pattern]);

// =============== Nombres visibles (ocho eventos) ===============
const labels = [
  activityLabel("FORM_INITIAL", null),
  activityLabel("FORM_MONTHLY", 1),
  activityLabel("FORM_MONTHLY", 2),
  activityLabel("FORM_MONTHLY", 3),
  activityLabel("FORM_FINAL", null),
  activityLabel("ADVANCE", 1),
  activityLabel("ADVANCE", 2),
  activityLabel("ADVANCE", 3),
];
assert.deepEqual(labels, [
  "Formulario inicial",
  "Seguimiento 1",
  "Seguimiento 2",
  "Seguimiento 3",
  "Formulario de sistematización",
  "Avance 1",
  "Avance 2",
  "Avance 3",
]);
assert.equal(activityLabel("OTRO", null), "Actividad académica");

console.log("cohortSchedule tests passed");
