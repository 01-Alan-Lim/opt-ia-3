"use client";

// Inicio de sesión del landing (LandingPage lo usa en el hero y en el CTA final).
//   - LoginButton: un solo elemento, para alinearse con los demás botones de la fila.
//       · Sin sesión y con Google Identity Services disponible: el botón oficial de Google
//         (src/lib/auth/googleIdentity.ts), tamaño medium (sin nombre, foto ni correo del
//         usuario), que entrega un ID token a Supabase Auth. Su contenedor reserva el alto
//         para que nada se mueva mientras carga.
//       · Sin sesión y sin GIS (falta NEXT_PUBLIC_GOOGLE_CLIENT_ID, o el script está bloqueado
//         o falló): un botón de texto con el inicio OAuth de Supabase.
//       · Con sesión: "Entrar a OPT-IA", que termina en la rutina común (finishLogin.ts).
//   - LoginAlternative: debajo del grupo de botones, el estado del inicio con Google y, solo si
//     ese inicio falló, el acceso alternativo (OAuth). Para soporte, ?acceso=alternativo lo
//     muestra siempre (p. ej. si el botón de Google no responde en un navegador concreto). Ocupa
//     siempre una línea, haya o no texto.
// El controlador de GIS es uno por página: aunque haya dos botones, se inicializa una vez.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { supabase } from "@/lib/supabaseClient";
import { googleButtonWidth } from "@/lib/auth/googleIdentity";
import { finishBrowserLogin, getGoogleSignInController, setLoginNavigator } from "@/lib/auth/loginClient";

// Mismo alto que el botón medium de Google (32 px) y forma de píldora, como él.
const COMPACT_BUTTON_CLASSES = [
  "inline-flex h-8 items-center justify-center rounded-full px-4",
  "text-sm font-semibold transition-colors disabled:opacity-60",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300",
];

// Texto blanco sobre sky-700 (5.85:1) y sky-800 en hover (7.52:1): AA para texto normal.
const ENTER_BUTTON_CLASSES = [...COMPACT_BUTTON_CLASSES, "bg-sky-700 text-white hover:bg-sky-800"];

// Respaldo sin GIS: claro sobre el fondo oscuro, como el botón de Google, pero solo con texto.
const FALLBACK_BUTTON_CLASSES = [...COMPACT_BUTTON_CLASSES, "bg-white text-slate-900 hover:bg-slate-200"];

function useSessionEmail(): string | null {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setSessionEmail(data.session?.user?.email ?? null);
    }

    load();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSessionEmail(newSession?.user?.email ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return sessionEmail;
}

function useGoogleSignIn() {
  const controller = getGoogleSignInController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { controller, state };
}

// Inicio OAuth de siempre: Supabase redirige a Google y vuelve a /auth/callback.
async function startOAuthSignIn() {
  const redirectTo = `${window.location.origin}/auth/callback`;

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });

  if (error) console.error("[auth] OAuth de Google no disponible", { status: error.status ?? null });
}

export function LoginButton({ className }: { className?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isAuthed = Boolean(useSessionEmail());
  const { controller, state: google } = useGoogleSignIn();
  const googleContainer = useRef<HTMLDivElement | null>(null);

  // Al terminar un inicio con Google, navega con el router de este botón.
  useEffect(() => setLoginNavigator((path) => router.push(path)), [router]);

  const showGoogle = !isAuthed && google.status !== "unavailable";
  const busy = loading || google.status === "signing_in";

  useEffect(() => {
    const container = googleContainer.current;
    if (!showGoogle || !container) return;
    return controller.mount(container, {
      type: "standard",
      theme: "outline",
      size: "medium",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
      width: googleButtonWidth(container.getBoundingClientRect().width),
      locale: "es",
    });
  }, [controller, showGoogle]);

  async function signInWithOAuth() {
    setLoading(true);
    try {
      await startOAuthSignIn();
    } finally {
      setLoading(false);
    }
  }

  // Con sesión: la rutina común decide el rol en el servidor y redirige (finishLogin.ts).
  async function goToApp() {
    setLoading(true);
    try {
      await finishBrowserLogin((path) => router.push(path));
    } finally {
      setLoading(false);
    }
  }

  if (isAuthed) {
    return (
      <button type="button" onClick={goToApp} disabled={busy} className={clsx(ENTER_BUTTON_CLASSES, className)}>
        {busy ? "Ingresando..." : "Entrar a OPT-IA"}
      </button>
    );
  }

  if (!showGoogle) {
    return (
      <button type="button" onClick={signInWithOAuth} disabled={loading} className={clsx(FALLBACK_BUTTON_CLASSES, className)}>
        {loading ? "Ingresando..." : "Iniciar sesión con Google"}
      </button>
    );
  }

  // GIS dibuja aquí su botón; React no pone hijos dentro de este contenedor.
  return (
    <div
      ref={googleContainer}
      aria-busy={busy}
      className={clsx("flex min-h-8 items-center justify-center", className)}
    />
  );
}

const subscribeToNothing = () => () => {};
const readForcedAlternative = () => new URLSearchParams(window.location.search).get("acceso") === "alternativo";

export function LoginAlternative({ className }: { className?: string }) {
  const [loading, setLoading] = useState(false);
  const isAuthed = Boolean(useSessionEmail());
  const { state: google } = useGoogleSignIn();
  const forced = useSyncExternalStore(subscribeToNothing, readForcedAlternative, () => false);

  const signingIn = google.status === "signing_in";
  const error = google.status === "ready" ? google.error : null;
  // Sin GIS el botón principal ya es el OAuth; con sesión no hace falta. Con GIS, solo si el
  // inicio con Google falló o si se pidió con ?acceso=alternativo.
  const visible = !isAuthed && google.status !== "unavailable" && (Boolean(error) || forced);

  async function signInWithOAuth() {
    setLoading(true);
    try {
      await startOAuthSignIn();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div aria-live="polite" className={clsx("min-h-5 text-xs leading-5 text-slate-400", className)}>
      {!isAuthed && signingIn && "Ingresando…"}
      {visible && !signingIn && (
        <>
          {error && <span className="mr-1">{error}</span>}
          <button
            type="button"
            onClick={signInWithOAuth}
            disabled={loading}
            className="rounded-sm text-slate-400 underline decoration-slate-600 underline-offset-4 transition-colors hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-60"
          >
            {loading ? "Abriendo Google…" : error ? "Acceso alternativo" : "¿Problemas con el botón? Usa el acceso alternativo"}
          </button>
        </>
      )}
    </div>
  );
}
