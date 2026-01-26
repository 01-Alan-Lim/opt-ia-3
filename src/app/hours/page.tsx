// src/app/hours/page.tsx
"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

type HoursItem = {
  id: string;
  period_start: string;
  period_end: string;
  hours: number;
  activity: string;
  created_at: string;
};

export default function HoursPage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [hours, setHours] = useState<number>(0);
  const [activity, setActivity] = useState<string>("");
  const [items, setItems] = useState<HoursItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  // 1) Cargar sesión y mantener token actualizado
  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      const t = data.session?.access_token ?? null;
      setToken(t);
      setAuthReady(true);
    }

    loadSession();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setToken(session?.access_token ?? null);
      setAuthReady(true);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function load(tk?: string | null) {
    setMsg("");
    setLoading(true);
    try {
      const useToken = tk ?? token;

      if (!useToken) {
        setMsg("No encuentro tu sesión. Inicia sesión y vuelve a intentar.");
        return;
      }

      const res = await fetch("/api/hours?limit=20", {
        headers: { Authorization: `Bearer ${useToken}` },
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        setMsg(json?.message ?? "No se pudo cargar tus horas.");
        return;
      }

      setItems(json.data.items ?? []);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    setMsg("");
    setLoading(true);
    try {
      if (!token) {
        setMsg("No encuentro tu sesión. Inicia sesión y vuelve a intentar.");
        return;
      }

      const res = await fetch("/api/hours", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ hours, activity }),
      });

      const json = await res.json().catch(() => null);

      if (res.status === 409) {
        setMsg("Ya registraste tus horas para este periodo. No se permite editar.");
        return;
      }

      if (!res.ok || json?.ok === false) {
        setMsg(json?.message ?? "No se pudo registrar horas.");
        return;
      }

      setMsg(
        `Guardado ✅ Periodo: ${json.data.period.period_start} → ${json.data.period.period_end}`
      );

      setHours(0);
      setActivity("");

      await load(token);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  // 2) Al estar authReady:
  //    - si no hay token => redirige al home (opcional, pero recomendado)
  //    - si hay token => carga lista
  useEffect(() => {
    if (!authReady) return;

    if (!token) {
      router.replace("/");
      return;
    }

    load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, token]);

  // UI: loading auth
  if (!authReady) {
    return (
      <div style={{ maxWidth: 760, margin: "24px auto", padding: 16 }}>
        Cargando sesión...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: "24px auto", padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Registrar horas (semanal)
      </h1>

      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        Ingresa tus horas y actividades de la semana. Solo se permite 1 registro por periodo.
      </p>

      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <label>
          Horas (0–200)
          <input
            type="number"
            min={0}
            max={200}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          />
        </label>

        <label>
          Actividades (mín 3 caracteres)
          <textarea
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            rows={4}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          />
        </label>

        <button
          onClick={submit}
          disabled={loading}
          style={{
            padding: 12,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Guardando..." : "Guardar horas"}
        </button>

        {msg ? (
          <div style={{ padding: 10, background: "#111827", color: "white" }}>{msg}</div>
        ) : null}
      </div>

      <hr style={{ margin: "18px 0" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Mis registros</h2>
        <button onClick={() => load(token)} disabled={loading} style={{ padding: 10 }}>
          {loading ? "Cargando..." : "Refrescar"}
        </button>
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {items.map((it) => (
          <div key={it.id} style={{ padding: 12, border: "1px solid #ddd" }}>
            <div style={{ fontWeight: 700 }}>
              Periodo: {it.period_start} → {it.period_end}
            </div>
            <div>Horas: {it.hours}</div>
            <div style={{ marginTop: 6, opacity: 0.9 }}>{it.activity}</div>
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              Creado: {new Date(it.created_at).toLocaleString()}
            </div>
          </div>
        ))}
        {items.length === 0 && <div style={{ opacity: 0.8 }}>Aún no tienes registros.</div>}
      </div>
    </div>
  );
}
