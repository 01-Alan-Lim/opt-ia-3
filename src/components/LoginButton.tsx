"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { supabase } from "@/lib/supabaseClient";
import { finishBrowserLogin } from "@/lib/auth/loginClient";

export function LoginButton({ className }: { className?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
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

  const isAuthed = useMemo(() => Boolean(sessionEmail), [sessionEmail]);

  async function signInWithGoogle() {
    setLoading(true);
    try {
      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });

      if (error) console.error(error);
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

  async function handleClick() {
    if (!isAuthed) await signInWithGoogle();
    else await goToApp();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={clsx(
        // ✅ estilo consistente con tus tarjetas
        "inline-flex items-center justify-center h-12 px-5 rounded-2xl",
        // Texto blanco sobre sky-700 (5.85:1) y sky-800 en hover (7.52:1): AA para texto normal.
        "bg-sky-700 hover:bg-sky-800 disabled:opacity-60",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300",
        "text-white text-sm font-semibold",
        "shadow-lg shadow-sky-500/10",
        "transition",
        className
      )}
    >
      {loading ? "Ingresando..." : isAuthed ? "Entrar a OPT-IA" : "Iniciar sesión con Google"}
    </button>
  );
}