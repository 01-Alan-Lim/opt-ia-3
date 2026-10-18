import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Interfaz docente de acceso de estudiantes y del calendario organizador. Los componentes no se
// montan (no hay navegador): se comprueba en el código que el panel de correos autorizados está en
// la pestaña Aprobaciones y el del organizador en Configuración, que hablan solo con la API
// docente usando la sesión (Bearer), que no mandan identificadores de usuario ni roles, y que el
// navegador nunca maneja tokens de Google.

const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

function main() {
  const panel = code(read("src", "components", "teacher", "AuthorizedEmailsPanel.tsx"));
  const page = code(read("src", "app", "docente", "page.tsx"));

  // Montado en Aprobaciones.
  const approvals = page.slice(page.indexOf('{tab === "approvals" && ('), page.indexOf('{tab === "dashboard" && <TeacherDashboard />}'));
  assert.ok(approvals.includes("<AuthorizedEmailsPanel />"));

  // Solo la API docente, con el token de la sesión.
  assert.ok(panel.includes('fetch("/api/teacher/authorized-emails", { headers: await authHeaders() })'));
  assert.ok(panel.includes("`/api/teacher/authorized-emails?email=${encodeURIComponent(target)}`"));
  assert.ok(panel.includes("Authorization: `Bearer ${token}`"));
  assert.ok(!/user_id|userId|role:/.test(panel), "no manda identificadores ni roles");
  assert.ok(panel.includes('JSON.stringify({ email, note: note.trim() || null })'));

  // Mensajes claros: autorizar no aprueba; revocar pide confirmación.
  assert.ok(panel.includes("Autorizar no aprueba"));
  assert.ok(panel.includes("window.confirm("));

  // ---------------- Calendario organizador (Configuración) ----------------
  const organizer = code(read("src", "components", "teacher", "CalendarOrganizerPanel.tsx"));
  const config = page.slice(page.indexOf('{tab === "config" && ('), page.indexOf('{tab === "approvals" && ('));
  assert.ok(config.includes("<CalendarOrganizerPanel />"));
  assert.ok(config.indexOf("<CalendarOrganizerPanel />") < config.indexOf("<CohortsPanel />"), "el estado del calendario, sobre las cohortes");

  for (const route of ["/api/teacher/calendar-organizer/start", "/api/teacher/calendar-organizer/sync", "/api/teacher/calendar-organizer/withdraw"]) {
    assert.ok(organizer.includes(`"${route}"`), route);
  }
  assert.ok(organizer.includes('post("/api/teacher/calendar-organizer", "DELETE")'));
  assert.ok(organizer.includes("Authorization: `Bearer ${token}`"));
  assert.ok(organizer.includes('url.startsWith("https://accounts.google.com/")'), "solo redirige a Google");
  assert.ok(!/refresh_token|ciphertext|localStorage|sessionStorage|document\.cookie/.test(organizer), "sin tokens de Google en el navegador");
  assert.ok(!/user_id|userId|role:/.test(organizer));
  // Estados comprensibles y confirmación de las acciones que avisan a estudiantes.
  for (const text of ["Conectado", "Desconectado", "Sin conectar", "Conectar cuenta organizadora", "Volver a conectar", "Sincronizar ahora", "invitaciones activas", "con error"]) {
    assert.ok(organizer.includes(text), text);
  }
  assert.equal(organizer.match(/window\.confirm\(/g)?.length, 2, "desconectar y retirar piden confirmación");
  assert.ok(organizer.includes("Los estudiantes no tienen que conectar nada."));

  // La página de retorno de Google solo reenvía el código al servidor.
  const callback = code(read("src", "app", "auth", "calendar-callback", "CalendarCallbackClient.tsx"));
  assert.ok(callback.includes('fetch("/api/teacher/calendar-organizer/callback"'));
  assert.ok(callback.includes("body: JSON.stringify({ code, state })"));
  assert.ok(!/google-calendar|refresh_token|localStorage/.test(callback));

  // Aprobaciones, correos y cohortes muestran el resultado de las invitaciones.
  assert.ok(page.includes("calendarReportText(json?.data?.calendar, { quietWhenNotConnected: true })"));
  assert.ok(panel.includes("calendarReportText(calendar, { quietWhenNotConnected: true })"));
  const cohorts = code(read("src", "components", "teacher", "CohortsPanel.tsx"));
  assert.ok(cohorts.includes("calendarReportText(report)"));
  assert.ok(!/conectados \$\{/.test(cohorts), "sin el resumen del Calendar por estudiante");
}

try {
  main();
  console.log("teacherAccessUi tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
