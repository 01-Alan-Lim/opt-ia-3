import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GOOGLE_BUTTON_DEFAULT_WIDTH, googleButtonWidth } from "../auth/googleIdentity";

// LoginButton y LoginAlternative con Google Identity Services (src/components/LoginButton.tsx) y
// su colocación en el landing. Los componentes no se montan aquí (no hay navegador): se prueba el
// ancho del botón de Google y se comprueba en el código el diseño (botón oficial medium, sin
// personalización, alineado con "Ver flujo metodológico"), el respaldo OAuth y el control de
// inicializaciones. Esto no sustituye la prueba visual ni el inicio de sesión real en Preview.

const read = (...p: string[]) => readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

function main() {
  // ---------------- Ancho del botón de Google (200-400 px) ----------------
  assert.equal(googleButtonWidth(0), GOOGLE_BUTTON_DEFAULT_WIDTH, "sin ancho medido: el de siempre");
  assert.equal(googleButtonWidth(150), GOOGLE_BUTTON_DEFAULT_WIDTH);
  assert.equal(googleButtonWidth(Number.NaN), GOOGLE_BUTTON_DEFAULT_WIDTH);
  assert.equal(googleButtonWidth(240), 240, "escritorio: w-60");
  assert.equal(googleButtonWidth(343.8), 343, "móvil: ocupa la fila");
  assert.equal(googleButtonWidth(1024), 400, "nunca más de lo que admite GIS");

  const button = read("src", "components", "LoginButton.tsx");
  const live = code(button);

  // ---------------- Botón oficial de Google, sin personalización ----------------
  const options = live.slice(live.indexOf("return controller.mount(container, {"), live.indexOf("}, [controller, showGoogle]);"));
  assert.ok(options.includes('type: "standard"'));
  assert.ok(options.includes('size: "medium"'), "medium: Google no muestra nombre, foto ni correo");
  assert.ok(options.includes('theme: "outline"'));
  assert.ok(options.includes('text: "signin_with"'));
  assert.ok(options.includes('locale: "es"'));
  assert.ok(options.includes('shape: "pill"'));
  assert.ok(!/size: "large"|type: "icon"/.test(options));
  // GIS dibuja dentro del contenedor (sin hijos de React), que reserva su alto mientras carga.
  assert.ok(/<div\s+ref=\{googleContainer\}[\s\S]*?className=\{clsx\("flex min-h-8 items-center justify-center", className\)\}\s*\/>/.test(live));
  assert.ok(!/iframe/i.test(live), "no se toca el iframe de Google");

  // Un controlador compartido por página, leído como store externo.
  assert.ok(live.includes("const controller = getGoogleSignInController();"));
  assert.ok(live.includes("useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)"));
  assert.ok(live.includes("return controller.mount(container, {"), "cada botón registra su contenedor y lo quita al desmontar");

  // ---------------- Respaldo OAuth y estado, debajo del grupo ----------------
  assert.ok(live.includes('await supabase.auth.signInWithOAuth({\n    provider: "google",\n    options: { redirectTo },\n  });'));
  assert.ok(live.includes("const redirectTo = `${window.location.origin}/auth/callback`;"));
  assert.ok(live.includes("export function LoginAlternative("));
  assert.ok(live.includes("¿Problemas con el botón? Usa el acceso alternativo"));
  assert.ok(live.includes('className={clsx("min-h-5 text-xs leading-5 text-slate-400", className)}'), "una línea fija: sin saltos");
  assert.ok(live.includes("focus-visible:outline-sky-300"), "foco visible");
  assert.equal(live.match(/onClick=\{signInWithOAuth\}/g)?.length, 2, "botón sin GIS y enlace alternativo");
  // El botón sin GIS no imita al de Google: solo texto, mismo alto que la fila.
  assert.ok(live.includes('"inline-flex h-8 items-center justify-center rounded-full px-4"'));
  assert.ok(live.includes('"Iniciar sesión con Google"'));
  assert.ok(!/bg-sky-700[^"]*"[^\n]*Iniciar sesión/.test(live), "sin el botón azul como inicio de sesión");

  // Con sesión, la rutina común; mientras GIS inicia sesión, el botón queda ocupado.
  assert.ok(live.includes('"Entrar a OPT-IA"'));
  assert.ok(live.includes("await finishBrowserLogin((path) => router.push(path));"));
  assert.ok(live.includes('const busy = loading || google.status === "signing_in";'));
  assert.ok(live.includes("setLoginNavigator((path) => router.push(path))"));

  // Sin One Tap, sin selección automática y sin datos sensibles en logs.
  assert.ok(!/\.prompt\(|auto_select/.test(live));
  for (const line of live.split("\n").filter((l) => l.includes("console."))) {
    assert.ok(!/token|credential|nonce|session/i.test(line), `log sin datos sensibles: ${line.trim()}`);
  }

  // ---------------- Landing: los dos lugares ----------------
  const landing = code(read("src", "components", "landing", "LandingPage.tsx"));
  assert.equal(landing.match(/<LoginButton /g)?.length, 2);
  assert.equal(landing.match(/<LoginAlternative /g)?.length, 2, "acceso alternativo bajo cada botón");
  // Hero: fila alineada al centro con 12-16 px de separación; columna en móvil.
  assert.ok(landing.includes('<div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">'));
  assert.ok(landing.includes('<LoginButton className="w-full sm:w-60" />'));
  const hero = landing.slice(landing.indexOf('<LoginButton className="w-full sm:w-60" />'), landing.indexOf("Ver flujo metodológico"));
  assert.ok(hero.includes("inline-flex h-8 w-full items-center justify-center rounded-full"), "mismo alto que el botón medium");
  // El enlace alternativo va fuera de la fila, debajo.
  const rowEnd = landing.indexOf("Ver flujo metodológico");
  assert.ok(landing.indexOf('<LoginAlternative className="mt-3 text-center sm:text-left" />') > rowEnd);
  // CTA final: botón y acceso alternativo en columna.
  assert.ok(landing.includes('<div className="flex w-full max-w-sm flex-shrink-0 flex-col items-stretch gap-3 md:w-60">'));

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
