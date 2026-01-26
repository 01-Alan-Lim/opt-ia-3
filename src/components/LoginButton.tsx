"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Role = "student" | "teacher";

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export function LoginButton() {
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
      // ⚠️ Importante: debe coincidir con tu route /auth/callback
      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });

      if (error) {
        console.error(error);
      }
    } finally {
      setLoading(false);
    }
  }

  async function goToApp() {
    setLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        router.push("/");
        return;
      }

      const res = await fetch("/api/auth/after-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

       const json = await res.json().catch(() => null);

      // Si el backend dice "no autorizado", volvemos al home con mensaje
      if (res.status === 403) {
        await supabase.auth.signOut();
        router.push("/?reason=forbidden");
        return;
      }


      if (res.status === 403) {
        await supabase.auth.signOut();
        router.push("/?reason=forbidden");
        return;
      }

      if (!res.ok || json?.ok === false) {
        router.push("/");
        return;
      }

      // ✅ Respuesta estándar: { ok:true, data:{ role } }
      const payload = (json?.data ?? json) as { role?: Role } | null;
      const role = payload?.role ?? "student";


      router.push(role === "teacher" ? "/docente" : "/chat");

    } finally {
      setLoading(false);
    }
  }

  async function handleClick() {
    if (!isAuthed) {
      await signInWithGoogle();
    } else {
      await goToApp();
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="px-4 py-2 rounded bg-sky-500 hover:bg-sky-600 disabled:opacity-60 text-white text-sm font-medium"
    >
      {loading ? "Ingresando..." : isAuthed ? "Entrar a OPT-IA" : "Iniciar sesión con Google"}
    </button>
  );
}
