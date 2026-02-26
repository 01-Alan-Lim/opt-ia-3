"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 1) Lee `code`/`state` del callback
 * 2) POST /api/integrations/google-calendar/callback  (code -> tokens)
 * 3) POST /api/integrations/google-calendar/sync      (crea/actualiza eventos)
 * 4) Redirige al panel docente
 */
export default function CalendarCallbackClient() {
  const router = useRouter();
  const params = useSearchParams();

  const [status, setStatus] = useState<"idle" | "sync" | "ok" | "error">("idle");
  const [message, setMessage] = useState("Conectando Google Calendar...");

  useEffect(() => {
    let mounted = true;

    async function run() {
      try {
        setStatus("sync");

        const code = params.get("code");
        const state = params.get("state");
        const oauthError = params.get("error");

        if (oauthError) {
          setStatus("error");
          setMessage(`Autorización cancelada: ${oauthError}`);
          return;
        }

        if (!code) {
          setStatus("error");
          setMessage("Falta el parámetro code.");
          return;
        }

        // 1) Intercambiar code por tokens (server)
        const r = await fetch("/api/integrations/google-calendar/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, state }),
        });

        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) {
          setStatus("error");
          setMessage(j?.message || "No se pudo completar OAuth.");
          return;
        }

        // 2) Sincronizar eventos (server)
        setMessage("Sincronizando eventos...");
        const sync = await fetch("/api/integrations/google-calendar/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false }),
        });

        const sj = await sync.json().catch(() => null);
        if (!sync.ok || !sj?.ok) {
          setStatus("error");
          setMessage(sj?.message || "No se pudo sincronizar eventos.");
          return;
        }

        setStatus("ok");
        setMessage("¡Google Calendar conectado! Redirigiendo...");

        setTimeout(() => {
          if (!mounted) return;
          router.replace("/teacher/cohorts");
        }, 700);
      } catch (e) {
        console.error(e);
        setStatus("error");
        setMessage("Ocurrió un error inesperado.");
      }
    }

    run();
    return () => {
      mounted = false;
    };
  }, [params, router]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">Google Calendar</h1>
      <p className="text-sm opacity-80">{message}</p>

      {status === "error" && (
        <button
          className="mt-4 rounded-md border px-4 py-2 text-sm"
          onClick={() => router.replace("/teacher/cohorts")}
        >
          Volver
        </button>
      )}
    </div>
  );
}