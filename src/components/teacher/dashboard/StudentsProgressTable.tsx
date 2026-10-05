"use client";

// Matriz E0-E10 por estudiante (GET /api/teacher/dashboard, students[].progress). Cada celda
// muestra solo si ESA etapa está cerrada: no se infiere una etapa por otra posterior. La nota,
// si existe, va en el tooltip; sin evaluación no se muestra nota.

import { useMemo, useState } from "react";

import {
  DASHBOARD_STAGES,
  type DashboardStudent,
  type StageProgress,
} from "@/lib/teacher/dashboard/aggregate";
import {
  filterDashboardStudents,
  formatHours,
  registrationLabel,
  stageLabel,
  type RegistrationFilter,
} from "@/lib/teacher/dashboard/view";

const STATUS_OPTIONS: Array<{ value: RegistrationFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "approved", label: "Aprobados" },
  { value: "pending", label: "Pendientes" },
  { value: "rejected", label: "Rechazados" },
];

function isRegistrationFilter(value: string): value is RegistrationFilter {
  return STATUS_OPTIONS.some((option) => option.value === value);
}

const STATUS_BADGE: Record<string, string> = {
  approved: "border-emerald-400/15 bg-emerald-600/15 text-emerald-200",
  pending: "border-amber-400/20 bg-amber-500/10 text-amber-200",
  rejected: "border-red-400/20 bg-red-500/10 text-red-200",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("es-BO");
}

function stageCellTitle(progress: StageProgress): string {
  const parts = [stageLabel(progress.stage)];
  if (!progress.completed) {
    parts.push("sin cerrar");
  } else {
    parts.push(progress.validatedAt ? `cerrada el ${formatDate(progress.validatedAt)}` : "cerrada");
    if (progress.score !== null) {
      parts.push(`nota ${progress.score}${progress.scoreLabel ? ` (${progress.scoreLabel})` : ""}`);
    }
  }
  return parts.join(" · ");
}

function StageCell({ progress }: { progress: StageProgress }) {
  const title = stageCellTitle(progress);

  return progress.completed ? (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15 text-xs text-emerald-300"
      title={title}
      aria-label={title}
    >
      ✓
    </span>
  ) : (
    <span className="text-slate-600" title={title} aria-label={title}>
      —
    </span>
  );
}

function studentName(student: DashboardStudent): string {
  const name = [student.firstName, student.lastName].filter(Boolean).join(" ");
  return name || student.email || student.userId;
}

export function StudentsProgressTable({ students }: { students: DashboardStudent[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RegistrationFilter>("all");

  const visible = useMemo(
    () => filterDashboardStudents(students, { query, status }),
    [students, query, status]
  );

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/20">
      <div className="flex flex-col gap-3 border-b border-slate-800 p-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Avance por estudiante</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            Mostrando {visible.length} de {students.length}. ✓ = etapa cerrada; pasa el cursor
            para ver la fecha y la nota, si la hay.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_170px] md:w-[460px]">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-400">Buscar (RU / nombre / email)</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
              placeholder="Ej: 20201234 o Juan Pérez"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-400">Estado</span>
            <select
              value={status}
              onChange={(e) => {
                const next = e.target.value;
                if (isRegistrationFilter(next)) setStatus(next);
              }}
              className="w-full rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="sticky left-0 z-10 bg-slate-950 px-4 py-2.5 font-medium">Estudiante</th>
              <th className="px-3 py-2.5 font-medium">Estado</th>
              {DASHBOARD_STAGES.map((stage) => (
                <th
                  key={stage}
                  className="px-1.5 py-2.5 text-center font-medium"
                  title={stageLabel(stage)}
                  scope="col"
                >
                  E{stage}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right font-medium">Horas</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-800/70">
            {visible.map((student) => (
              <tr key={student.userId} className="hover:bg-slate-900/40">
                <td className="sticky left-0 z-10 max-w-[220px] bg-slate-950 px-4 py-2.5">
                  <div className="truncate font-medium text-slate-100">{studentName(student)}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    {student.ru ? `RU ${student.ru}` : "Sin RU"}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={[
                      "whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]",
                      (student.registrationStatus && STATUS_BADGE[student.registrationStatus]) ||
                        "border-slate-600/20 bg-slate-700/30 text-slate-200",
                    ].join(" ")}
                  >
                    {registrationLabel(student.registrationStatus)}
                  </span>
                </td>
                {student.progress.map((progress) => (
                  <td key={progress.stage} className="px-1.5 py-2.5 text-center">
                    <StageCell progress={progress} />
                  </td>
                ))}
                <td
                  className={[
                    "whitespace-nowrap px-4 py-2.5 text-right tabular-nums",
                    student.hours.total === null ? "text-[11px] text-slate-500" : "text-slate-200",
                  ].join(" ")}
                >
                  {formatHours(student.hours.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {visible.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            {students.length
              ? "Ningún estudiante coincide con el filtro."
              : "No hay estudiantes en esta cohorte."}
          </div>
        )}
      </div>
    </section>
  );
}
