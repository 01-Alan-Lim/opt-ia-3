"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type TeacherChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type TeacherChatContext = {
  studentId?: string;
  studentName?: string;
  ru?: string;
  stage?: number;
};

type ApiOk = {
  ok: true;
  data: {
    reply: string;
    context: TeacherChatContext;
  };
};

type ApiFail = {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
};

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function TeacherChat() {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeacherChatMsg[]>([
    {
      id: uid(),
      role: "assistant",
      content:
        "Hola Inge 👋 Este es el Chat Docente. Pídeme un reporte de un estudiante por RU, email o nombre.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<TeacherChatContext>({});

  const authHeaders = useMemo<HeadersInit>(() => {
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }, [token]);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setToken(data.session?.access_token ?? null);
    }

    load();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setToken(s?.access_token ?? null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  function resetChat() {
    setCtx({});
    setError(null);
    setInput("");
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Hola Inge 👋 Chat reiniciado. Puedes pedirme un reporte por RU, nombre o email, o también un resumen general de uso del agente.",
      },
    ]);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setBusy(true);
    setInput("");

    const userMsg: TeacherChatMsg = { id: uid(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch("/api/teacher/chat", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ message: text, context: ctx }),
      });

      const json = (await res.json().catch(() => null)) as ApiOk | ApiFail | null;

      if (!json) throw new Error("Respuesta inválida del servidor.");
      if (!json.ok) throw new Error(json.message || "Error del servidor.");

      setCtx(json.data.context ?? {});

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: json.data.reply ?? "No pude generar una respuesta.",
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error";
      setError(msg);
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", content: `No pude procesar eso. ${msg}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={[
        "relative overflow-hidden",
        "rounded-3xl",
        "border border-slate-800/60",
        "bg-gradient-to-b from-slate-950/30 to-slate-950/10",
        "shadow-[0_0_50px_rgba(0,0,0,0.35)]",
      ].join(" ")}
    >
      {/* Glow sutil */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[520px] -translate-x-1/2 rounded-full bg-sky-500/10 blur-3xl"
      />

      {/* Header */}
      <div
        className={[
          "px-5 py-4",
          "border-b border-slate-800/40",
          "bg-slate-950/10 backdrop-blur-sm",
          "flex items-center justify-between gap-3",
        ].join(" ")}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100 tracking-wide">Chat Docente</div>
          <div className="text-[12px] text-slate-400 truncate">
            {ctx.studentId ? (
              <>
                En foco:{" "}
                <span className="text-slate-200">
                  {ctx.studentName ?? ctx.ru ?? ctx.studentId}
                </span>
              </>
            ) : (
              "Sin estudiante en foco"
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={resetChat}
          className={[
            "shrink-0",
            "rounded-full",
            "border border-slate-700/60",
            "bg-slate-950/20",
            "px-4 py-2",
            "text-xs text-slate-200",
            "hover:bg-slate-900/30",
            "transition",
            "disabled:opacity-60",
          ].join(" ")}
          disabled={busy}
          title="Reiniciar chat"
        >
          Reiniciar
        </button>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className={[
          "h-[68vh] md:h-[72vh]",
          "overflow-y-auto",
          "px-5 pt-5 pb-24", // 👈 deja espacio para que el input “flote” sin tapar
          "space-y-3",
        ].join(" ")}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={[
                "max-w-[85%]",
                "px-4 py-3",
                "text-sm leading-relaxed",
                "border",
                "shadow-[0_10px_30px_rgba(0,0,0,0.25)]",
                m.role === "user"
                  ? [
                      "rounded-3xl rounded-br-xl",
                      "bg-sky-700/30 border-sky-600/25",
                      "text-slate-50",
                    ].join(" ")
                  : [
                      "rounded-3xl rounded-bl-xl",
                      "bg-slate-950/25 border-slate-800/60",
                      "text-slate-100 whitespace-pre-line",
                    ].join(" "),
              ].join(" ")}
            >
              {m.content}
            </div>
          </div>
        ))}

        {error && (
          <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Input “flotante” (SIN línea arriba) */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4">
        <div
          className={[
            "mx-auto max-w-4xl",
            "rounded-3xl",
            "border border-slate-800/55",
            "bg-slate-950/30 backdrop-blur-md",
            "shadow-[0_20px_60px_rgba(0,0,0,0.45)]",
            "px-4 py-3",
          ].join(" ")}
        >
          <div className="flex items-center gap-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe tu mensaje aquí..."
              className={[
                "h-[44px] w-full resize-none",
                "overflow-hidden",                 
                "rounded-2xl",
                "bg-transparent",
                "px-4 py-3",
                "text-sm text-slate-100 placeholder:text-slate-500",
                "focus:outline-none",
              ].join(" ")}
              style={{ scrollbarWidth: "none" }}   
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={!token || busy}
            />

            <button
              type="button"
              onClick={() => void send()}
              disabled={!token || busy || !input.trim()}
              className={[
                "h-[44px] shrink-0",
                "rounded-2xl",
                "bg-sky-700 hover:bg-sky-600",
                "px-6",
                "text-sm font-medium text-white",
                "shadow-[0_12px_30px_rgba(2,132,199,0.20)]",
                "transition",
                "disabled:opacity-60",
              ].join(" ")}
            >
              Enviar
            </button>
          </div>

          {!token && (
            <div className="mt-2 text-xs text-slate-400">
              Necesitas iniciar sesión para usar el chat.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}