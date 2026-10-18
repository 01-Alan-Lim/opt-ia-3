// src/lib/calendar/syncReportText.ts
//
// Texto para el docente a partir del resultado de una sincronización de invitaciones (lo usan el
// panel del organizador, las aprobaciones, los correos autorizados y las cohortes). Sin imports de
// servidor: se usa en el navegador.

export type CalendarReportLike = {
  status?: string;
  message?: string;
  created?: number;
  updated?: number;
  cancelled?: number;
} | null | undefined;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// quietWhenNotConnected: en aprobaciones y correos no se repite en cada acción que falta conectar
// la cuenta organizadora (ya lo dice el panel de Configuración).
export function calendarReportText(report: CalendarReportLike, opts: { quietWhenNotConnected?: boolean } = {}): string {
  if (!report || !report.status) return "";
  if (report.status === "organizer_not_connected") {
    return opts.quietWhenNotConnected ? "" : "Calendario: conecta la cuenta organizadora para enviar invitaciones.";
  }
  if (report.status !== "ok") return `Calendario: ${report.message ?? "no se pudo sincronizar."}`;
  const parts: string[] = [];
  if (report.created) parts.push(plural(report.created, "invitación enviada", "invitaciones enviadas"));
  if (report.updated) parts.push(plural(report.updated, "actualizada", "actualizadas"));
  if (report.cancelled) parts.push(plural(report.cancelled, "cancelada", "canceladas"));
  return parts.length ? `Calendario: ${parts.join(", ")}.` : opts.quietWhenNotConnected ? "" : "Calendario: invitaciones al día.";
}
