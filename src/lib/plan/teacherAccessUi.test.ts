import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Interfaz docente de acceso de estudiantes. Los componentes no se montan (no hay navegador): se
// comprueba en el código que el panel de correos autorizados está en la pestaña Aprobaciones,
// habla solo con la API docente usando la sesión (Bearer) y no manda identificadores de usuario
// ni roles desde el navegador.

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
}

try {
  main();
  console.log("teacherAccessUi tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
