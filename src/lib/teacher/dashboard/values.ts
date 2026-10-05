// src/lib/teacher/dashboard/values.ts
//
// Lectura de valores que comparten el snapshot (aggregate.ts) y la capa analítica
// (analytics.ts) del panel docente. Sin I/O.

// profiles.user_id es text y otras tablas lo guardan como uuid: se comparan normalizados.
export function normalizeUserId(id: string): string {
  return id.trim().toLowerCase();
}

// numeric/bigint llegan como número o string.
export function toFiniteNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Milisegundos de un timestamp; 0 si no se puede leer.
export function timeOf(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
