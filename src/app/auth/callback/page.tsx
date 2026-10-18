// src/app/auth/callback/page.tsx
// Callback de OAuth (Google) para Supabase Auth: el camino de respaldo cuando no se usa el botón
// de Google Identity Services.
// - Finaliza el login (guarda la sesión en el cliente)
// - Termina con la rutina común (src/lib/auth/finishLogin.ts): after-login decide el rol y se
//   redirige a /chat o /docente

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { finishBrowserLogin } from "@/lib/auth/loginClient";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string>("Finalizando inicio de sesión...");

  useEffect(() => {
    let active = true;

    async function finalize() {
      try {
        // 1) Supabase procesa el callback y guarda la sesión
        // (en algunos flujos ya queda lista solo con getSession, pero esto ayuda a asegurar)
        // Nota: si tu versión de supabase-js no expone getSessionFromUrl,
        // hacemos fallback con getSession.
        // @ts-expect-error: dependiendo de versión, puede no existir
        if (typeof supabase.auth.getSessionFromUrl === "function") {
          // @ts-expect-error
          await supabase.auth.getSessionFromUrl({ storeSession: true });
        }

        if (!active) return;

        // 2) after-login decide el rol (y rechaza correos no autorizados) y redirige.
        await finishBrowserLogin(
          (path) => router.replace(path),
          (message) => {
            if (active) setStatus(message);
          },
        );
      } catch (e) {
        console.error("Error en auth callback:", e);
        router.replace("/");
      }
    }

    finalize();

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
      <div className="text-center">
        <p className="text-sm text-slate-300">{status}</p>
        <p className="mt-2 text-xs text-slate-500">Si esto tarda, vuelve a la página principal e intenta otra vez.</p>
      </div>
    </main>
  );
}
