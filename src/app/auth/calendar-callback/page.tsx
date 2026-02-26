// src/app/auth/calendar-callback/page.tsx

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export default function CalendarCallbackPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp.get("returnTo") || "/hours";
  const [status, setStatus] = useState("Conectando Google Calendar...");

  useEffect(() => {
    let active = true;

    async function finalize() {
      try {
        // 1) En Supabase JS v2 (PKCE) hay que intercambiar ?code=... por sesión
        const code = sp.get("code");
        if (code) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            setStatus("No se pudo finalizar el OAuth (exchangeCodeForSession).");
            router.replace(returnTo);
            return;
          }
          // preferimos la sesión recién intercambiada
          const session = data.session;

          if (!active) return;

          const accessToken = session?.access_token ?? null;
          const refreshToken = (session as any)?.provider_refresh_token ?? null;
          const scope = (session as any)?.provider_token ? "google_oauth" : undefined;

          if (!accessToken) {
            setStatus("No se pudo obtener sesión. Intenta nuevamente.");
            router.replace(returnTo);
            return;
          }

          if (!refreshToken) {
            setStatus(
              "No se recibió refresh_token de Google. " +
                "Esto puede pasar si Google no lo devuelve. Prueba revocar acceso de OPT-IA en tu cuenta Google y reintentar."
            );
            router.replace(returnTo);
            return;
          }

          setStatus("Guardando permisos de calendario...");

          const res = await fetch("/api/integrations/google-calendar/store", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              refresh_token: refreshToken,
              scope,
              calendar_id: "primary",
            }),
          });

          const json = await res.json().catch(() => null);
          if (!res.ok || json?.ok === false) {
            setStatus(json?.message ?? "No se pudo guardar el token de calendario.");
            router.replace(returnTo);
            return;
          }

          setStatus("✅ Google Calendar conectado. Sincronizando eventos...");

          try {
            // Best-effort: si falla, igual dejamos conectado
            await fetch("/api/integrations/google-calendar/sync", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({ dryRun: false }),
            });
          } catch {
            // no bloqueamos la UX por esto
          }

          setStatus("✅ Listo. Redirigiendo...");
          router.replace(returnTo);
          return;

        }

        // 2) Si NO hay code, caemos al comportamiento anterior: usar sesión existente
        const { data } = await supabase.auth.getSession();
        const session = data.session;

        if (!active) return;

        const accessToken = session?.access_token ?? null;
        const refreshToken = (session as any)?.provider_refresh_token ?? null; // <- Supabase OAuth
        const scope = (session as any)?.provider_token ? "google_oauth" : undefined;

        if (!accessToken) {
          setStatus("No se pudo obtener sesión. Intenta nuevamente.");
          router.replace(returnTo);
          return;
        }

        // Si no hay refresh token, no se puede automatizar
        if (!refreshToken) {
          setStatus(
            "No se recibió refresh_token de Google. " +
              "Solución: vuelve a conectar con 'prompt=consent' y 'access_type=offline'."
          );
          router.replace(returnTo);
          return;
        }

        setStatus("Guardando permisos de calendario...");

        // 3) Guardar refresh token en Supabase (vía API segura)
        const res = await fetch("/api/integrations/google-calendar/store", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            refresh_token: refreshToken,
            scope,
            calendar_id: "primary",
          }),
        });

        const json = await res.json().catch(() => null);
        if (!res.ok || json?.ok === false) {
          setStatus(json?.message ?? "No se pudo guardar el token de calendario.");
          router.replace(returnTo);
          return;
        }

        setStatus("✅ Google Calendar conectado. Redirigiendo...");
        router.replace(returnTo);
      } catch (e) {
        console.error(e);
        router.replace(returnTo);
      }
    }

    finalize();
    return () => {
      active = false;
    };
  }, [router, returnTo, sp]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
      <div className="text-center">
        <p className="text-sm text-slate-300">{status}</p>
        <p className="mt-2 text-xs text-slate-500">Si esto tarda, vuelve e intenta otra vez.</p>
      </div>
    </main>
  );
}
