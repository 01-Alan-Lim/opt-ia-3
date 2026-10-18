"use client";

// Botón de inicio de sesión del landing (LandingPage lo usa dos veces).
//   - Sin sesión y con Google Identity Services disponible: el botón oficial de Google
//     (src/lib/auth/googleIdentity.ts), que entrega un ID token a Supabase Auth. Debajo, un
//     enlace al inicio OAuth de siempre por si el botón no carga o falla.
//   - Sin sesión y sin GIS (falta NEXT_PUBLIC_GOOGLE_CLIENT_ID, o el script está bloqueado o
//     falló): el botón de siempre, con el OAuth de Supabase.
//   - Con sesión: "Entrar a OPT-IA", que termina en la rutina común (finishLogin.ts).
// El controlador de GIS es uno por página: aunque haya dos botones, se inicializa una vez.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { supabase } from "@/lib/supabaseClient";
import { googleBlockLayoutClasses, googleButtonWidth } from "@/lib/auth/googleIdentity";
import { finishBrowserLogin, getGoogleSignInController, setLoginNavigator } from "@/lib/auth/loginClient";

const PRIMARY_BUTTON_CLASSES = [
  // ✅ estilo consistente con tus tarjetas
  "inline-flex items-center justify-center h-12 px-5 rounded-2xl",
  // Texto blanco sobre sky-700 (5.85:1) y sky-800 en hover (7.52:1): AA para texto normal.
  "bg-sky-700 hover:bg-sky-800 disabled:opacity-60",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300",
  "text-white text-sm font-semibold",
  "shadow-lg shadow-sky-500/10",
  "transition",
];

export function LoginButton({ className }: { className?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const googleContainer = useRef<HTMLDivElement | null>(null);

  const controller = getGoogleSignInController();
  const google = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

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

  // Al terminar un inicio con Google, navega con el router de este botón.
  useEffect(() => setLoginNavigator((path) => router.push(path)), [router]);

  const isAuthed = useMemo(() => Boolean(sessionEmail), [sessionEmail]);
  const showGoogle = !isAuthed && google.status !== "unavailable";
  const signingIn = google.status === "signing_in";
  const busy = loading || signingIn;

  useEffect(() => {
    const container = googleContainer.current;
    if (!showGoogle || !container) return;
    return controller.mount(container, {
      type: "standard",
      theme: "filled_blue",
      size: "large",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
      width: googleButtonWidth(container.getBoundingClientRect().width),
      locale: "es",
    });
  }, [controller, showGoogle]);

  // Respaldo: el inicio OAuth de siempre (Supabase redirige a Google y vuelve a /auth/callback).
  async function signInWithOAuth() {
    setLoading(true);
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });

      if (error) console.error("[auth] OAuth de Google no disponible", { status: error.status ?? null });
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
      <button type="button" onClick={goToApp} disabled={busy} className={clsx(PRIMARY_BUTTON_CLASSES, className)}>
        {busy ? "Ingresando..." : "Entrar a OPT-IA"}
      </button>
    );
  }

  if (!showGoogle) {
    return (
      <button type="button" onClick={signInWithOAuth} disabled={loading} className={clsx(PRIMARY_BUTTON_CLASSES, className)}>
        {loading ? "Ingresando..." : "Iniciar sesión con Google"}
      </button>
    );
  }

  const statusText =
    google.status === "idle" || google.status === "loading"
      ? "Cargando inicio de sesión con Google…"
      : signingIn
        ? "Ingresando…"
        : google.status === "ready" && google.error
          ? google.error
          : "";

  return (
    <div className={clsx("flex flex-col items-center gap-1.5", googleBlockLayoutClasses(className))}>
      {/* GIS dibuja aquí su botón; React no pone hijos dentro de este contenedor. */}
      <div ref={googleContainer} className="flex h-12 w-full items-center justify-center" aria-busy={busy} />
      <p aria-live="polite" className="text-center text-xs text-slate-400">
        {statusText}
      </p>
      <button
        type="button"
        onClick={signInWithOAuth}
        disabled={busy}
        className="rounded-md px-1 text-xs font-medium text-slate-300 underline underline-offset-4 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-60"
      >
        {loading ? "Abriendo Google…" : "¿Problemas? Ingresa con el método alternativo"}
      </button>
    </div>
  );
}
