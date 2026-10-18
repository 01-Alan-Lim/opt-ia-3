import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GOOGLE_BUTTON_DEFAULT_WIDTH, googleBlockLayoutClasses, googleButtonWidth } from "../auth/googleIdentity";

// LoginButton con Google Identity Services (src/components/LoginButton.tsx). El componente no se
// monta aquí (no hay navegador): se prueban sus funciones de layout y se comprueba en el código
// que conserva el respaldo OAuth, el diseño del landing y el control de inicializaciones.

const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

function main() {
  // ---------------- Ancho del botón de Google (200-400 px) ----------------
  assert.equal(googleButtonWidth(0), GOOGLE_BUTTON_DEFAULT_WIDTH, "sin ancho medido: el de siempre");
  assert.equal(googleButtonWidth(150), GOOGLE_BUTTON_DEFAULT_WIDTH);
  assert.equal(googleButtonWidth(Number.NaN), GOOGLE_BUTTON_DEFAULT_WIDTH);
  assert.equal(googleButtonWidth(200), 200);
  assert.equal(googleButtonWidth(343.8), 343, "móvil: ocupa la fila");
  assert.equal(googleButtonWidth(1024), 400, "nunca más de lo que admite GIS");

  // ---------------- Layout responsive del landing ----------------
  const hero = "w-full rounded-2xl transition-[background-color,box-shadow] duration-200 ease-out hover:shadow-[0_0_18px_-8px_rgba(34,211,238,0.65)] sm:w-auto";
  assert.equal(googleBlockLayoutClasses(hero), "w-full sm:w-auto", "solo ancho: sin brillo ni bordes en el bloque");
  assert.equal(googleBlockLayoutClasses("rounded-2xl transition-[background-color,box-shadow] duration-200"), "");
  assert.equal(googleBlockLayoutClasses(undefined), "");
  assert.equal(googleBlockLayoutClasses("md:max-w-xs self-start lg:min-w-60"), "md:max-w-xs self-start lg:min-w-60");

  const landing = read("src", "components", "landing", "LandingPage.tsx");
  assert.equal(landing.match(/<LoginButton className="[^"]*" \/>/g)?.length, 2, "el landing no cambia: dos botones");
  assert.ok(landing.includes(`<LoginButton className="${hero}" />`));

  // ---------------- Componente ----------------
  const button = read("src", "components", "LoginButton.tsx");
  const live = code(button);

  // Un controlador compartido por página, leído como store externo.
  assert.ok(live.includes("const controller = getGoogleSignInController();"));
  assert.ok(live.includes("useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)"));
  assert.ok(live.includes("return controller.mount(container, {"), "cada botón registra su contenedor y lo quita al desmontar");
  // GIS dibuja dentro del contenedor: React no le pone hijos.
  assert.ok(/<div ref=\{googleContainer\}[^>]*\/>/.test(live));

  // Respaldo OAuth intacto y accesible.
  assert.ok(live.includes('await supabase.auth.signInWithOAuth({\n        provider: "google",\n        options: { redirectTo },\n      });'));
  assert.ok(live.includes("const redirectTo = `${window.location.origin}/auth/callback`;"));
  assert.equal(live.match(/onClick=\{signInWithOAuth\}/g)?.length, 2, "botón de siempre sin GIS y enlace alternativo con GIS");
  assert.ok(live.includes("¿Problemas? Ingresa con el método alternativo"));
  assert.ok(live.includes("focus-visible:outline-sky-300"), "el enlace alternativo tiene foco visible");

  // Sin GIS, el botón de siempre con las mismas clases.
  for (const cls of [
    "inline-flex items-center justify-center h-12 px-5 rounded-2xl",
    "bg-sky-700 hover:bg-sky-800 disabled:opacity-60",
    "text-white text-sm font-semibold",
  ]) {
    assert.ok(button.includes(cls), `clase conservada: ${cls}`);
  }
  assert.ok(live.includes('"Iniciar sesión con Google"'));
  assert.ok(live.includes('"Entrar a OPT-IA"'));

  // Con sesión, la rutina común; mientras GIS inicia sesión, el botón queda ocupado.
  assert.ok(live.includes("await finishBrowserLogin((path) => router.push(path));"));
  assert.ok(live.includes("const busy = loading || signingIn;"));
  assert.ok(live.includes("setLoginNavigator((path) => router.push(path))"));

  // Sin One Tap, sin selección automática y sin datos sensibles en logs.
  assert.ok(!/\.prompt\(|auto_select/.test(live));
  for (const line of live.split("\n").filter((l) => l.includes("console."))) {
    assert.ok(!/token|credential|nonce|session/i.test(line), `log sin datos sensibles: ${line.trim()}`);
  }

  // Calendar sigue con su flujo propio: el login no pide permisos de Calendar.
  assert.ok(!/calendar/i.test(live));
  assert.ok(!/calendar/i.test(code(read("src", "lib", "auth", "loginClient.ts"))));
  assert.ok(read("src", "app", "api", "integrations", "google-calendar", "start", "route.ts").includes("https://www.googleapis.com/auth/calendar.events"));
}

try {
  main();
  console.log("loginButton tests passed");
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
