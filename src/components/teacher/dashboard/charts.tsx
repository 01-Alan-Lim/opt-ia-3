"use client";

// Primitivas visuales del Dashboard docente: tarjeta, eje temporal por meses (con las fechas de
// referencia de los avances y la ventana elegida), columnas, barras por semana, mini línea
// acumulada, barra horizontal, lectura del elemento activo y tabla equivalente. Solo dibujan lo
// que reciben; los números salen de GET /api/teacher/dashboard.
//
// Un solo color de datos (el azul del panel): ninguna serie se distingue por color. Marcas
// finas, líneas de 2px, grilla y ejes en hairline. Cada valor también está en "Ver tabla".

import type { ReactNode } from "react";

import type { StageCounts } from "@/lib/teacher/dashboard/analytics";
import { formatMonthTick, stageBreakdown, type TimeMarker } from "@/lib/teacher/dashboard/analyticsView";

export type Span = { start: number; end: number };

export function ChartCard({
  title,
  subtitle,
  note,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
      {note ? <p className="mt-3 text-[11px] leading-4 text-slate-500">{note}</p> : null}
    </section>
  );
}

// Lectura del elemento bajo el cursor o con foco (el "tooltip" del panel): siempre en el mismo
// lugar, sin tapar el gráfico.
export function ChartReadout({ children }: { children: ReactNode }) {
  return (
    <div aria-live="polite" className="mb-2 min-h-[2.5rem] text-xs leading-5 text-slate-300">
      {children}
    </div>
  );
}

export function ChartTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: string[][];
}) {
  return (
    <details className="mt-3 text-xs text-slate-300">
      <summary className="cursor-pointer select-none text-[11px] text-slate-400 hover:text-slate-200">
        Ver tabla
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-800">
        <table className="min-w-full">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-950/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              {head.map((cell) => (
                <th key={cell} scope="col" className="px-3 py-2 font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 tabular-nums">
            {rows.map((row) => (
              <tr key={row.join("|")}>
                {row.map((cell, index) => (
                  <td key={`${index}-${cell}`} className="px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function pct(position: number, total: number): string {
  return `${total > 0 ? (position / total) * 100 : 0}%`;
}

// Eje temporal compartido: un tramo por mes. Las posiciones son meses desde el inicio del eje
// (analyticsView.datePosition). children va encima del área de trazado, en posición absoluta.
export function TimePlot({
  months,
  yMax,
  formatY = String,
  height = 160,
  markers = [],
  band = null,
  highlight = null,
  label,
  footer,
  children,
}: {
  months: readonly string[];
  yMax: number;
  formatY?: (value: number) => string;
  height?: number;
  markers?: TimeMarker[];
  band?: Span | null;
  highlight?: number | null;
  label: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const n = months.length;
  const thin = n > 12;

  return (
    <div role="group" aria-label={label} className={`flex gap-2 ${markers.length ? "pt-4" : "pt-1"}`}>
      <div
        className="relative w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-500"
        style={{ height }}
        aria-hidden
      >
        <span className="absolute right-0 top-0 -translate-y-1/2">{formatY(yMax)}</span>
        <span className="absolute right-0 top-1/2 -translate-y-1/2">{formatY(yMax / 2)}</span>
        <span className="absolute bottom-0 right-0 translate-y-1/2">0</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }}>
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-slate-800/80" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-slate-800/80" />
          {highlight !== null && highlight >= 0 && (
            <div
              className="pointer-events-none absolute inset-y-0 bg-slate-600/20"
              style={{ left: pct(highlight, n), width: pct(1, n) }}
            />
          )}
          {band && (
            <div
              className="pointer-events-none absolute inset-y-0 bg-sky-400/[0.07] ring-1 ring-inset ring-sky-400/20"
              style={{ left: pct(band.start, n), width: pct(band.end - band.start, n) }}
            />
          )}
          {children}
          {markers.map((marker) => (
            <div
              key={marker.label}
              className="pointer-events-none absolute inset-y-0 w-px bg-slate-400/45"
              style={{ left: pct(marker.position, n) }}
            >
              <span className="absolute -top-4 left-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-slate-400">
                {marker.label}
              </span>
            </div>
          ))}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-slate-700" />
        </div>

        <div className="relative mt-1 h-4 text-[10px] text-slate-500" aria-hidden>
          {months.map((month, index) =>
            thin && index % 2 === 1 ? null : (
              <span
                key={month}
                className={[
                  "absolute top-0 -translate-x-1/2 whitespace-nowrap",
                  n > 6 && index % 2 === 1 ? "max-sm:hidden" : "",
                ].join(" ")}
                style={{ left: pct(index + 0.5, n) }}
              >
                {formatMonthTick(month, index)}
              </span>
            )
          )}
        </div>
        {footer}
      </div>
    </div>
  );
}

// Una columna por mes (hijo de TimePlot). La columna es el blanco de hover/foco; clic llama a
// onSelect si existe.
export function MonthColumns({
  values,
  yMax,
  activeIndex,
  onActivate,
  onSelect,
  describe,
}: {
  values: readonly number[];
  yMax: number;
  activeIndex: number | null;
  onActivate: (index: number | null) => void;
  onSelect?: (index: number) => void;
  describe: (index: number) => string;
}) {
  return (
    <div className="absolute inset-0 flex" onMouseLeave={() => onActivate(null)}>
      {values.map((value, index) => (
        <button
          key={index}
          type="button"
          aria-label={describe(index)}
          aria-pressed={onSelect ? activeIndex === index : undefined}
          onMouseEnter={() => onActivate(index)}
          onFocus={() => onActivate(index)}
          onClick={() => (onSelect ? onSelect(index) : onActivate(index))}
          className="flex h-full min-w-0 flex-1 items-end justify-center rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
        >
          <span
            className={[
              "block w-3/5 max-w-6 rounded-t transition-colors",
              activeIndex === index ? "bg-sky-400" : "bg-sky-500/70",
            ].join(" ")}
            style={{ height: `${(value / yMax) * 100}%`, minHeight: value > 0 ? 2 : 0 }}
          />
        </button>
      ))}
    </div>
  );
}

// Barras sobre tramos del eje (p. ej., semanas): solo los tramos recibidos; lo demás queda vacío.
export function SpanBars({
  items,
  months,
  yMax,
  activeIndex,
  onActivate,
  describe,
}: {
  items: ReadonlyArray<Span & { value: number }>;
  months: readonly string[];
  yMax: number;
  activeIndex: number | null;
  onActivate: (index: number | null) => void;
  describe: (index: number) => string;
}) {
  const n = months.length;
  return (
    <div className="absolute inset-0" onMouseLeave={() => onActivate(null)}>
      {items.map((item, index) => (
        <button
          key={`${item.start}-${item.end}`}
          type="button"
          aria-label={describe(index)}
          onMouseEnter={() => onActivate(index)}
          onFocus={() => onActivate(index)}
          onClick={() => onActivate(index)}
          className="absolute inset-y-0 flex items-end justify-center rounded-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
          style={{ left: pct(item.start, n), width: pct(item.end - item.start, n), minWidth: 6 }}
        >
          <span
            className={[
              "block w-4/5 max-w-6 rounded-t transition-colors",
              activeIndex === index ? "bg-sky-400" : "bg-sky-500/70",
            ].join(" ")}
            style={{ height: `${(item.value / yMax) * 100}%`, minHeight: item.value > 0 ? 2 : 0 }}
          />
        </button>
      ))}
    </div>
  );
}

// Línea acumulada de una etapa (small multiple): parte de 0 al inicio del eje y cada punto es
// el valor al cierre del mes. Escala común yMax para comparar paneles.
export function MiniLine({
  values,
  yMax,
  markers = [],
  band = null,
  highlight = null,
  label,
}: {
  values: readonly number[];
  yMax: number;
  markers?: TimeMarker[];
  band?: Span | null;
  highlight?: number | null;
  label: string;
}) {
  const n = values.length;
  if (!n) return null;

  const x = (position: number) => (position / n) * 100;
  const y = (value: number) => 100 - (Math.min(value, yMax) / yMax) * 100;
  const points = [`0,100`, ...values.map((value, index) => `${x(index + 1)},${y(value)}`)].join(" ");
  const last = values[n - 1];
  const marked = highlight !== null && highlight >= 0 && highlight < n ? highlight : null;

  return (
    <div className="relative h-16" role="img" aria-label={label}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden
      >
        <line x1="0" y1="100" x2="100" y2="100" className="stroke-slate-700" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {band && (
          <rect
            x={x(band.start)}
            y="0"
            width={x(band.end) - x(band.start)}
            height="100"
            className="fill-sky-400/10"
          />
        )}
        {markers.map((marker) => (
          <line
            key={marker.label}
            x1={x(marker.position)}
            y1="0"
            x2={x(marker.position)}
            y2="100"
            className="stroke-slate-400/40"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon points={`${points} ${x(n)},100`} className="fill-sky-400/10" />
        <polyline
          points={points}
          fill="none"
          className="stroke-sky-400"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {marked !== null && (
          <line
            x1={x(marked + 1)}
            y1="0"
            x2={x(marked + 1)}
            y2="100"
            className="stroke-slate-300/60"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <span
        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-400 ring-2 ring-slate-950"
        style={{ left: `${x(n)}%`, top: `${y(last)}%` }}
        aria-hidden
      />
      {marked !== null && (
        <span
          className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-100 ring-2 ring-slate-950"
          style={{ left: `${x(marked + 1)}%`, top: `${y(values[marked])}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}

// Fila de barra horizontal: etiqueta, valor y pista. tone "muted" para categorías aparte (p. ej.,
// sin registros), que no son un valor de la escala.
export function HBar({
  label,
  value,
  max,
  display,
  tone = "accent",
}: {
  label: ReactNode;
  value: number;
  max: number;
  display: ReactNode;
  tone?: "accent" | "muted";
}) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-slate-300">{label}</span>
        <span className="shrink-0 tabular-nums text-slate-200">{display}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800/80" aria-hidden>
        <div
          className={`h-full rounded-full ${tone === "accent" ? "bg-sky-500/70" : "bg-slate-500/50"}`}
          style={{ width: `${percent}%`, minWidth: value > 0 ? 4 : 0 }}
        />
      </div>
    </div>
  );
}

// Desglose por etapa de un conteo (solo etapas con valor): "E2 5 · E3 3".
export function BreakdownText({ byStage }: { byStage: StageCounts }) {
  const items = stageBreakdown(byStage);
  if (!items.length) return <span className="text-slate-500">sin validaciones</span>;
  return (
    <span className="text-slate-400">
      {items.map((item, index) => (
        <span key={item.stage}>
          {index > 0 ? " · " : ""}E{item.stage} <span className="tabular-nums text-slate-200">{item.count}</span>
        </span>
      ))}
    </span>
  );
}
