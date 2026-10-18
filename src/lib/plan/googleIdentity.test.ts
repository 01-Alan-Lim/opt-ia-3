import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createGoogleNonce,
  createGoogleSignInController,
  GOOGLE_IDENTITY_SCRIPT_SRC,
  GOOGLE_SIGN_IN_ERROR,
  loadGoogleIdentityApi,
  parseGoogleClientId,
  type GoogleButtonOptions,
  type GoogleCredentialResponse,
  type GoogleIdApi,
  type GoogleIdConfiguration,
  type GoogleNonce,
  type GoogleSignInState,
} from "../auth/googleIdentity";

// Google Identity Services (src/lib/auth/googleIdentity.ts), sin navegador ni red: GIS, Supabase y
// el fin del login son simulados. Comprueba el client ID, el nonce, la carga del script y el
// controlador (una inicialización, un envío por credencial, errores y respaldo).

const CLIENT_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.id-token-de-prueba.firma";
const OPTIONS: GoogleButtonOptions = { type: "standard", theme: "filled_blue", size: "large", text: "signin_with", shape: "pill", logo_alignment: "left", width: 260, locale: "es" };

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Container = { id: string };

function fakeGis() {
  const initialized: GoogleIdConfiguration[] = [];
  const rendered: Array<{ container: Container; options: GoogleButtonOptions }> = [];
  let disabled = 0;
  const api: GoogleIdApi<Container> = {
    initialize: (config) => {
      initialized.push(config);
    },
    renderButton: (container, options) => {
      rendered.push({ container, options });
    },
    disableAutoSelect: () => {
      disabled++;
    },
  };
  const press = (response: GoogleCredentialResponse) => {
    const config = initialized.at(-1);
    assert.ok(config, "GIS no está inicializado");
    config.callback(response);
  };
  return { api, initialized, rendered, disabledCount: () => disabled, press };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function controllerWith(opts: {
  clientId?: string | null;
  loadApi?: () => Promise<GoogleIdApi<Container>>;
  signIn?: (c: { token: string; nonce: string }) => Promise<boolean>;
  onSignedIn?: () => Promise<void>;
}) {
  const gis = fakeGis();
  const nonces: GoogleNonce[] = [];
  const signIns: Array<{ token: string; nonce: string }> = [];
  let loads = 0;
  let finished = 0;
  const states: string[] = [];
  const controller = createGoogleSignInController<Container>({
    clientId: opts.clientId === undefined ? CLIENT_ID : opts.clientId,
    loadApi: async () => {
      loads++;
      return opts.loadApi ? opts.loadApi() : gis.api;
    },
    createNonce: async () => {
      const n = await createGoogleNonce();
      nonces.push(n);
      return n;
    },
    signIn: async (c) => {
      signIns.push(c);
      return opts.signIn ? opts.signIn(c) : true;
    },
    onSignedIn: async () => {
      finished++;
      if (opts.onSignedIn) await opts.onSignedIn();
    },
  });
  controller.subscribe((s: GoogleSignInState) => states.push(s.status));
  return { controller, gis, nonces, signIns, states, loads: () => loads, finished: () => finished };
}

async function main() {
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }

  try {
    // ---------------- Client ID ----------------
    assert.equal(parseGoogleClientId(CLIENT_ID), CLIENT_ID);
    assert.equal(parseGoogleClientId(`  ${CLIENT_ID}\n`), CLIENT_ID);
    for (const bad of [undefined, null, "", "   ", "mi-client-id", "123.apps.googleusercontent.com", `${CLIENT_ID}.evil.com`, "GOCSPX-secreto"]) {
      assert.equal(parseGoogleClientId(bad), null, `client ID inválido: ${String(bad)}`);
    }

    // ---------------- Nonce ----------------
    const n1 = await createGoogleNonce();
    const n2 = await createGoogleNonce();
    assert.match(n1.raw, /^[A-Za-z0-9_-]{43}$/, "32 bytes en base64url");
    assert.match(n1.hashed, /^[0-9a-f]{64}$/, "SHA-256 en hexadecimal");
    assert.equal(n1.hashed, sha256Hex(n1.raw), "Google recibe el hash del nonce que verá Supabase");
    assert.notEqual(n1.raw, n2.raw, "aleatorio");
    assert.ok(Object.isFrozen(n1));
    const fixed = await createGoogleNonce({
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
        if (array instanceof Uint8Array) array.fill(7);
        return array;
      },
      subtle: globalThis.crypto.subtle,
    });
    assert.equal(fixed.raw, Buffer.alloc(32, 7).toString("base64url"));
    assert.equal(fixed.hashed, sha256Hex(fixed.raw));

    // ---------------- Carga del script ----------------
    {
      // Ya cargado: no inyecta nada.
      let injected = 0;
      const api = fakeGis().api;
      const got = await loadGoogleIdentityApi({ readApi: () => api, scriptPresent: () => false, injectScript: () => injected++, wait: async () => undefined, timeoutMs: 1000 });
      assert.equal(got, api);
      assert.equal(injected, 0);
    }
    {
      // Se inyecta una vez y espera a que aparezca la API.
      const srcs: string[] = [];
      const api = fakeGis().api;
      let polls = 0;
      const got = await loadGoogleIdentityApi({
        readApi: () => (polls >= 3 ? api : null),
        scriptPresent: () => false,
        injectScript: (src) => srcs.push(src),
        wait: async () => {
          polls++;
        },
        timeoutMs: 1000,
        pollMs: 10,
      });
      assert.equal(got, api);
      assert.deepEqual(srcs, [GOOGLE_IDENTITY_SCRIPT_SRC], "un solo <script>, de accounts.google.com");
    }
    {
      // Otro botón ya inyectó el script: no se duplica.
      let injected = 0;
      let polls = 0;
      const api = fakeGis().api;
      await loadGoogleIdentityApi({ readApi: () => (polls > 0 ? api : null), scriptPresent: () => true, injectScript: () => injected++, wait: async () => { polls++; }, timeoutMs: 100, pollMs: 10 });
      assert.equal(injected, 0);
    }
    await assert.rejects(
      loadGoogleIdentityApi({ readApi: () => null, scriptPresent: () => false, injectScript: (_src, onError) => onError(), wait: async () => undefined, timeoutMs: 1000, pollMs: 10 }),
      /GIS_SCRIPT_ERROR/,
      "script bloqueado o con error",
    );
    await assert.rejects(
      loadGoogleIdentityApi({ readApi: () => null, scriptPresent: () => false, injectScript: () => undefined, wait: async () => undefined, timeoutMs: 50, pollMs: 10 }),
      /GIS_TIMEOUT/,
      "no carga a tiempo",
    );

    // ---------------- Sin NEXT_PUBLIC_GOOGLE_CLIENT_ID: OAuth de respaldo ----------------
    {
      const t = controllerWith({ clientId: null });
      assert.deepEqual(t.controller.getState(), { status: "unavailable", reason: "NO_CLIENT_ID" });
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      assert.equal(t.loads(), 0, "ni siquiera carga el script");
      assert.equal(t.gis.initialized.length, 0);
    }

    // ---------------- Script que falla: OAuth de respaldo ----------------
    {
      const t = controllerWith({ loadApi: async () => { throw new Error("GIS_SCRIPT_ERROR"); } });
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      await tick();
      assert.deepEqual(t.controller.getState(), { status: "unavailable", reason: "SCRIPT_FAILED" });
      t.controller.mount({ id: "cta" }, OPTIONS);
      await tick();
      assert.equal(t.loads(), 1, "no reintenta en bucle");
    }

    // ---------------- Inicio satisfactorio con dos botones ----------------
    {
      const t = controllerWith({});
      const hero = { id: "hero" };
      const cta = { id: "cta" };
      const unmountHero = t.controller.mount(hero, OPTIONS);
      t.controller.mount(cta, { ...OPTIONS, width: 320 });
      await tick();
      await tick();
      assert.deepEqual(t.controller.getState(), { status: "ready", error: null });
      assert.equal(t.loads(), 1, "un script");
      assert.equal(t.gis.initialized.length, 1, "una sola inicialización con dos botones");
      assert.deepEqual(t.gis.rendered.map((r) => r.container.id), ["hero", "cta"]);
      assert.equal(t.gis.rendered[1].options.width, 320);
      const config = t.gis.initialized[0];
      assert.equal(config.client_id, CLIENT_ID);
      assert.equal(config.auto_select, false, "sin selección automática");
      assert.equal(config.ux_mode, "popup");
      assert.equal(t.gis.disabledCount(), 1, "disableAutoSelect al iniciar");
      assert.equal(config.nonce, t.nonces[0].hashed, "a Google va el hash");

      // Un botón montado después de estar listo se dibuja enseguida; uno desmontado, no.
      unmountHero();
      t.controller.mount({ id: "tarde" }, OPTIONS);
      assert.equal(t.gis.rendered.at(-1)?.container.id, "tarde");
      assert.equal(t.gis.initialized.length, 1);

      t.gis.press({ credential: ID_TOKEN, select_by: "btn" });
      await tick();
      await tick();
      assert.deepEqual(t.signIns, [{ token: ID_TOKEN, nonce: t.nonces[0].raw }], "a Supabase va el nonce original");
      assert.equal(sha256Hex(t.signIns[0].nonce), config.nonce, "nonce y hash se corresponden");
      assert.equal(t.finished(), 1, "after-login una vez");
      assert.ok(t.states.includes("signing_in"));
      assert.deepEqual(t.controller.getState(), { status: "ready", error: null });
    }

    // ---------------- Credenciales repetidas: un solo envío ----------------
    {
      let release: () => void = () => undefined;
      const pending = new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
      const t = controllerWith({ signIn: () => pending });
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      await tick();
      t.gis.press({ credential: ID_TOKEN });
      t.gis.press({ credential: ID_TOKEN });
      t.gis.press({ credential: `${ID_TOKEN}-otro` });
      await tick();
      assert.equal(t.signIns.length, 1, "no hay segunda sesión ni segundo envío");
      assert.equal(t.controller.getState().status, "signing_in");
      release();
      await tick();
      await tick();
      assert.equal(t.finished(), 1);
    }

    // ---------------- Errores de GIS o de Supabase: aviso y respaldo ----------------
    {
      const results = [false, true];
      const t = controllerWith({
        signIn: async () => {
          const next = results.shift();
          if (next === undefined) throw new Error("sin más respuestas");
          return next;
        },
      });
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      await tick();
      t.gis.press({ credential: ID_TOKEN });
      await tick();
      await tick();
      assert.deepEqual(t.controller.getState(), { status: "ready", error: GOOGLE_SIGN_IN_ERROR });
      assert.equal(t.finished(), 0, "sin sesión no hay after-login");
      // Se puede reintentar.
      t.gis.press({ credential: ID_TOKEN });
      await tick();
      await tick();
      assert.equal(t.finished(), 1);
    }
    {
      const t = controllerWith({ signIn: async () => { throw new Error("red caída"); } });
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      await tick();
      t.gis.press({ credential: ID_TOKEN });
      await tick();
      await tick();
      assert.deepEqual(t.controller.getState(), { status: "ready", error: GOOGLE_SIGN_IN_ERROR });
    }
    {
      // Respuesta de Google sin credencial: error, sin llamar a Supabase.
      const t = controllerWith({});
      t.controller.mount({ id: "hero" }, OPTIONS);
      await tick();
      await tick();
      t.gis.press({});
      await tick();
      assert.equal(t.signIns.length, 0);
      assert.deepEqual(t.controller.getState(), { status: "ready", error: GOOGLE_SIGN_IN_ERROR });
    }
  } finally {
    Object.assign(console, original);
  }

  assert.ok(!logs.some((l) => l.includes(ID_TOKEN) || l.includes("id-token-de-prueba")), "el ID token no aparece en logs");

  // ---------------- Código ----------------
  const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
  const lib = read("src", "lib", "auth", "googleIdentity.ts");
  const client = read("src", "lib", "auth", "loginClient.ts");
  const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");
  for (const src of [lib, client]) {
    assert.ok(!/\.prompt\(/.test(code(src)), "sin One Tap");
    assert.ok(!/auto_select:\s*true/.test(code(src)), "sin selección automática");
  }
  assert.ok(client.includes("parseGoogleClientId(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID)"), "nombre literal para que Next lo incruste");
  assert.equal(GOOGLE_IDENTITY_SCRIPT_SRC, "https://accounts.google.com/gsi/client");
  assert.ok(client.includes('provider: "google",\n    token: credential.token,\n    nonce: credential.nonce,'));
  // En los logs del cliente solo van códigos de error, nunca el token ni el nonce.
  for (const line of code(client).split("\n").filter((l) => l.includes("console."))) {
    assert.ok(!/token|nonce|credential/i.test(line.replace(/Google Identity Services/, "")), `log sin datos sensibles: ${line.trim()}`);
  }
  assert.ok(/console\.warn\("\[auth\] Google Identity Services: Supabase rechazó el inicio de sesión", \{\n\s+status: error\?\.status \?\? null,\n\s+code: error\?\.code \?\? null,\n\s+\}\);/.test(client));
}

main()
  .then(() => console.log("googleIdentity tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
