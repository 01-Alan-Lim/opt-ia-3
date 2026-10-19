import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { prepareRouteTestEnv, routeRequest } from "./assistantRouteHarness";
import { installRestStub, type RestStubState } from "./restStubHarness";

// Onboarding y retirada del Calendar individual. Ruta real de envío del registro contra
// Supabase simulado: reenviar en la misma cohorte no quita una aprobación; un registro nuevo, en
// otra cohorte o rechazado queda pendiente. Las rutas de Calendar por estudiante responden 410
// sin tocar la base ni Google. Sin red.

const STUDENT = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const COHORT = "c0000000-0000-4000-8000-000000000001";
const OTHER_COHORT = "c0000000-0000-4000-8000-000000000002";

const state: RestStubState = {
  user: STUDENT,
  tables: {
    cohorts: [
      { id: COHORT, is_active: true, registration_opens_at: null, access_starts_at: "2026-09-01T00:00:00Z", access_ends_at: "2027-01-31T00:00:00Z" },
      { id: OTHER_COHORT, is_active: true, registration_opens_at: null, access_starts_at: null, access_ends_at: null },
    ],
    profiles: [],
  },
};

const form = (cohortId: string) => ({
  ru: "1234567",
  first_name: "Ana",
  last_name: "Prueba",
  semester: "1",
  company_name: "Empresa privada",
  cohort_id: cohortId,
});

async function main() {
  prepareRouteTestEnv({ ALLOWED_EMAIL_DOMAIN: "umsa.bo" });
  const stub = installRestStub(state);
  const submit = await import("../../app/api/onboarding/submit/route");

  const send = async (cohortId: string) => {
    const res = await submit.POST(routeRequest("/api/onboarding/submit", form(cohortId)));
    return res.status;
  };
  const profile = () => state.tables.profiles.find((p) => p.user_id === STUDENT.id);

  // Nuevo: pendiente.
  assert.equal(await send(COHORT), 200);
  assert.equal(profile()?.registration_status, "pending");
  assert.equal(state.tables.profiles.length, 1);

  // Aprobado por el docente y reenvía (p. ej. corrige su RU) en la misma cohorte: sigue aprobado.
  const p = profile();
  assert.ok(p);
  p.registration_status = "approved";
  assert.equal(await send(COHORT), 200);
  assert.equal(profile()?.registration_status, "approved", "reenviar no quita la aprobación");
  assert.equal(state.tables.profiles.length, 1, "sin duplicar el perfil");

  // Cambia de cohorte: la aprobación era para otra cohorte, vuelve a pendiente.
  assert.equal(await send(OTHER_COHORT), 200);
  assert.equal(profile()?.registration_status, "pending");
  assert.equal(profile()?.cohort_id, OTHER_COHORT);

  // Rechazado que reenvía: nueva solicitud pendiente.
  const q = profile();
  assert.ok(q);
  q.registration_status = "rejected";
  assert.equal(await send(OTHER_COHORT), 200);
  assert.equal(profile()?.registration_status, "pending");

  // El estado lo decide el servidor: aunque el navegador lo mande, se ignora.
  q.registration_status = "pending";
  const forged = await submit.POST(
    routeRequest("/api/onboarding/submit", { ...form(OTHER_COHORT), registration_status: "approved", role: "teacher" }),
  );
  assert.equal(forged.status, 200);
  assert.equal(profile()?.registration_status, "pending");
  assert.equal(profile()?.role, "student");

  // Calendar por estudiante: 410 sin tocar nada.
  stub.reset();
  const routes = [
    ["start", "GET"],
    ["callback", "POST"],
    ["store", "POST"],
    ["sync", "POST"],
  ] as const;
  for (const [name, method] of routes) {
    const mod = (await import(`../../app/api/integrations/google-calendar/${name}/route`)) as Record<string, () => Promise<Response>>;
    const res = await mod[method]();
    assert.equal(res.status, 410, `${name}: 410`);
    assert.equal(((await res.json()) as { code: string }).code, "GONE");
  }
  assert.equal(stub.calls.length, 0, "ni Supabase ni Google");
  stub.restore();

  // Código: el estudiante ya no conecta Calendar.
  const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8").replace(/\r\n/g, "\n");
  const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");
  const onboarding = code(read("src", "app", "onboarding", "page.tsx"));
  assert.ok(!/google-calendar|showCalendarStep|Conectar Google Calendar/.test(onboarding));
  assert.ok(onboarding.includes('router.replace("/chat");'), "tras registrarse va a /chat (pendiente de aprobación)");
  assert.ok(!/google-calendar/.test(code(read("src", "app", "hours", "page.tsx"))));
}

main()
  .then(() => console.log("onboardingAccess tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
