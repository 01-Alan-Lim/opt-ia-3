import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createSingleFlight,
  finishLogin,
  FINISH_LOGIN_MESSAGES,
  type AfterLoginResponse,
  type FinishLoginDeps,
} from "../auth/finishLogin";

// Rutina común de fin de inicio de sesión (src/lib/auth/finishLogin.ts), que usan el callback de
// OAuth y el botón de Google Identity Services. Sin red: las dependencias son simuladas.

const TOKEN = "eyJ-token-de-prueba-que-no-debe-aparecer-en-logs";

type Recorded = { calls: string[]; navigations: string[]; statuses: string[]; tokensSent: string[] };

function deps(response: AfterLoginResponse | Error | null, accessToken: string | null = TOKEN) {
  const rec: Recorded = { calls: [], navigations: [], statuses: [], tokensSent: [] };
  const d: FinishLoginDeps = {
    getAccessToken: async () => {
      rec.calls.push("getAccessToken");
      return accessToken;
    },
    postAfterLogin: async (token) => {
      rec.calls.push("postAfterLogin");
      rec.tokensSent.push(token);
      if (response instanceof Error) throw response;
      if (!response) throw new Error("sin respuesta");
      return response;
    },
    signOut: async () => {
      rec.calls.push("signOut");
    },
    navigate: (p) => {
      rec.calls.push("navigate");
      rec.navigations.push(p);
    },
    onStatus: (m) => rec.statuses.push(m),
  };
  return { d, rec };
}

const okBody = (role?: string) => ({ ok: true, data: role ? { role } : {} });

async function main() {
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  }

  try {
    // Sin sesión: vuelve a la portada y no llama a after-login.
    {
      const { d, rec } = deps(null, null);
      assert.deepEqual(await finishLogin(d), { kind: "no_session" });
      assert.deepEqual(rec.calls, ["getAccessToken", "navigate"]);
      assert.deepEqual(rec.navigations, ["/"]);
      assert.deepEqual(rec.statuses, [FINISH_LOGIN_MESSAGES.noSession]);
    }

    // Docente y estudiante: redirección por el rol que decide el servidor.
    {
      const { d, rec } = deps({ status: 200, ok: true, body: okBody("teacher") });
      assert.deepEqual(await finishLogin(d), { kind: "redirected", to: "/docente" });
      assert.deepEqual(rec.navigations, ["/docente"]);
      assert.deepEqual(rec.tokensSent, [TOKEN], "el token solo va a after-login");
    }
    for (const body of [okBody("student"), okBody(), { role: "student" }, null, "texto"]) {
      const { d, rec } = deps({ status: 200, ok: true, body });
      assert.deepEqual(await finishLogin(d), { kind: "redirected", to: "/chat" });
      assert.deepEqual(rec.navigations, ["/chat"], "sin rol claro: estudiante (/chat aplica el gate)");
    }
    // El cliente no puede elegirse docente: solo cuenta el rol que devuelve el servidor.
    {
      const { d, rec } = deps({ status: 200, ok: true, body: { ok: true, data: { role: "admin" } } });
      await finishLogin(d);
      assert.deepEqual(rec.navigations, ["/chat"]);
    }

    // 403 (correo no autorizado): cierra sesión y vuelve con el motivo.
    {
      const { d, rec } = deps({ status: 403, ok: false, body: { ok: false, code: "FORBIDDEN" } });
      assert.deepEqual(await finishLogin(d), { kind: "forbidden" });
      assert.deepEqual(rec.calls, ["getAccessToken", "postAfterLogin", "signOut", "navigate"]);
      assert.deepEqual(rec.navigations, ["/?reason=forbidden"]);
    }

    // 401 (sesión inválida): cierra sesión y vuelve a la portada una sola vez. No reintenta ni
    // inicia sesión otra vez: no hay bucle.
    {
      const { d, rec } = deps({ status: 401, ok: false, body: { ok: false, code: "UNAUTHORIZED" } });
      assert.deepEqual(await finishLogin(d), { kind: "unauthorized" });
      assert.deepEqual(rec.calls, ["getAccessToken", "postAfterLogin", "signOut", "navigate"]);
      assert.deepEqual(rec.navigations, ["/"]);
    }

    // Otros fallos: portada, sin cerrar sesión (como antes).
    for (const res of [
      { status: 500, ok: false, body: { ok: false } },
      { status: 200, ok: false, body: { ok: false } },
      new Error("red caída"),
    ]) {
      const { d, rec } = deps(res);
      assert.deepEqual(await finishLogin(d), { kind: "failed" });
      assert.deepEqual(rec.navigations, ["/"]);
      assert.ok(!rec.calls.includes("signOut"));
      assert.equal(rec.statuses.at(-1), FINISH_LOGIN_MESSAGES.failed);
    }

    // Una sola ejecución a la vez.
    {
      let runs = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const once = createSingleFlight(async (label: string) => {
        runs++;
        await gate;
        return label;
      });
      const a = once("primero");
      const b = once("segundo");
      assert.equal(a, b, "la segunda llamada recibe la misma promesa");
      release();
      assert.equal(await a, "primero");
      assert.equal(runs, 1);
      assert.equal(await once("después"), "después", "al terminar se puede volver a ejecutar");
      assert.equal(runs, 2);
    }
  } finally {
    Object.assign(console, original);
  }

  assert.ok(!logs.some((l) => l.includes(TOKEN)), "el token no aparece en ningún log");

  // Código: el cliente real manda solo el Bearer y un cuerpo vacío; callback y botón usan la
  // misma rutina; el onboarding sigue a cargo del gate de /chat.
  const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
  const client = read("src", "lib", "auth", "loginClient.ts");
  assert.ok(client.includes("Authorization: `Bearer ${accessToken}`"));
  assert.ok(client.includes("body: JSON.stringify({}),"));
  assert.ok(!/userId|user_id/.test(client.replace(/^\s*\/\/.*$/gm, "")), "no envía identificadores de usuario");
  assert.ok(read("src", "app", "auth", "callback", "page.tsx").includes("await finishBrowserLogin("));
  assert.ok(read("src", "components", "LoginButton.tsx").includes("await finishBrowserLogin((path) => router.push(path));"));
  const gate = read("src", "app", "chat", "_lib", "useAccessGate.ts");
  assert.ok(/reason === "NEEDS_ONBOARDING"[\s\S]{0,80}router\.replace\("\/onboarding"\)/.test(gate), "onboarding sin cambios");
  assert.equal(read("src", "app", "api", "auth", "after-login", "route.ts").includes("requireUser(req)"), true);
}

main()
  .then(() => console.log("finishLogin tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
