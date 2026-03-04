"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type OAuthState = {
  rt?: string; // returnTo
  csrf?: string;
};

function safeReturnTo(rt: string | null | undefined, fallback: string) {
  if (!rt) return fallback;
  if (!rt.startsWith("/")) return fallback;
  if (rt.startsWith("//")) return fallback;
  return rt;
}

function decodeState(raw: string | null): OAuthState | null {
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("")
    );
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as OAuthState;
  } catch {
    return null;
  }
}

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

        const decoded = decodeState(state);
        const returnTo = safeReturnTo(decoded?.rt, "/chat");

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

        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        if (!accessToken) {
          setStatus("error");
          setMessage("No encuentro tu sesión. Inicia sesión y vuelve a intentar.");
          return;
        }

        const r = await fetch("/api/integrations/google-calendar/callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code, state }),
        });

        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) {
          setStatus("error");
          setMessage(j?.message || "No se pudo completar OAuth.");
          return;
        }

        setMessage("Sincronizando eventos...");
        const sync = await fetch("/api/integrations/google-calendar/sync", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
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
          router.replace(returnTo);
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
          onClick={() => {
            const decoded = decodeState(params.get("state"));
            const returnTo = safeReturnTo(decoded?.rt, "/chat");
            router.replace(returnTo);
          }}
        >
          Volver
        </button>
      )}
    </div>
  );
}