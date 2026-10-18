// src/lib/time/periodKey.ts
export function getPeriodKeyLaPaz(date: Date = new Date()): string {
  // YYYY-MM usando zona horaria America/La_Paz
  // en-CA da formato YYYY-MM-DD
  return date.toLocaleDateString("en-CA", { timeZone: "America/La_Paz" }).slice(0, 7);
}

// YYYY-MM-DD del día calendario en America/La_Paz.
export function getDateKeyLaPaz(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "America/La_Paz" });
}
