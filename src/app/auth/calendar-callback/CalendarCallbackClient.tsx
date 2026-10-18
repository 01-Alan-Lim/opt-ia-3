"use client";

// Retorno de Google al conectar la cuenta organizadora de Calendar desde el panel docente. El
// código se envía al servidor, que comprueba el CSRF, lo canjea y guarda el acceso cifrado: el
// navegador nunca recibe tokens de Google.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const PANEL = "/docente";

export default function CalendarCallbackClient() {
  const router = useRouter();
  const params = useSearchParams();

  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("Conectando la cuenta organizadora...");

  useEffect(() => {
    let mounted = true;

    async function run() {
      try {
        const code = params.get("code");
        const state = params.get("state");

        if (params.get("error")) {
          setStatus("error");
          setMessage("Se canceló la autorización en Google. No se conectó ninguna cuenta.");
          return;
        }
        if (!code || !state) {
          setStatus("error");
          setMessage("Google no devolvió la autorización. Vuelve a intentarlo desde el panel docente.");
          return;
        }

        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        if (!accessToken) {
          setStatus("error");
          setMessage("No encuentro tu sesión. Inicia sesión y vuelve a intentarlo.");
          return;
        }

        const r = await fetch("/api/teacher/calendar-organizer/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ code, state }),
        });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (!mounted) return;
        if (!r.ok || !j?.ok) {
          setStatus("error");
          setMessage(j?.message || "No se pudo conectar la cuenta organizadora.");
          return;
        }

        setStatus("ok");
        setMessage("Cuenta organizadora conectada. Volviendo al panel docente...");
        setTimeout(() => {
          if (mounted) router.replace(`${PANEL}?calendario=conectado`);
        }, 700);
      } catch {
        if (!mounted) return;
        setStatus("error");
        setMessage("Ocurrió un error inesperado al conectar el calendario.");
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
      <p className="text-sm opacity-80" role={status === "error" ? "alert" : "status"}>
        {message}
      </p>

      {status === "error" && (
        <button className="mt-4 rounded-md border px-4 py-2 text-sm" onClick={() => router.replace(PANEL)}>
          Volver al panel docente
        </button>
      )}
    </div>
  );
}
