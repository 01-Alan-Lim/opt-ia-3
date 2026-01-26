// src/app/auth/callback/page.tsx
// Callback de OAuth (Google) para Supabase Auth.
// - Finaliza el login (guarda la sesión en el cliente)
// - Llama a /api/auth/after-login para obtener rol (student/teacher)
// - Redirige a /chat o /docente

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Role = "student" | "teacher";

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

        // 2) Obtener sesión ya guardada
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;

        if (!active) return;

        if (!token) {
          setStatus("No se pudo obtener sesión. Intenta iniciar sesión nuevamente.");
          router.replace("/");
          return;
        }

        setStatus("Verificando perfil...");

        // 3) Server decide rol y crea/actualiza profile
        const res = await fetch("/api/auth/after-login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        });

        const json = await res.json().catch(() => null);
        const ok = res.ok && json?.ok !== false;
        const payload = json?.data ?? json;

        if (!active) return;

                // ✅ 403: correo no autorizado -> cerrar sesión y volver con mensaje
        if (res.status === 403) {
          setStatus("Acceso restringido. Usa un correo institucional autorizado.");
          await supabase.auth.signOut();
          router.replace("/?reason=forbidden");
          return;
        }

        // 401: sesión inválida -> volver al home normal
        if (res.status === 401) {
          setStatus("Sesión inválida. Inicia sesión nuevamente.");
          await supabase.auth.signOut();
          router.replace("/");
          return;
        }

        // Si falla por otro motivo, volvemos al home
        if (!ok) {
          setStatus("No se pudo verificar tu perfil. Intenta nuevamente.");
          router.replace("/");
          return;
        }

        // OK: redirigir según rol
        const role: Role = ((payload?.role as Role) ?? "student");
        router.replace(role === "teacher" ? "/docente" : "/chat");
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
