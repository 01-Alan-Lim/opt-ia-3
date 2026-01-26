"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Cohort = {
  id: string;
  name: string;
  is_active: boolean;
  registration_opens_at: string | null;
  access_starts_at: string | null;
  access_ends_at: string | null;
  created_at: string;
  registration_open?: boolean;
};

type FieldErrors = Partial<
  Record<"ru" | "first_name" | "last_name" | "semester" | "company_name" | "cohort_id", string>
>;

export default function OnboardingPage() {
  const router = useRouter();

  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [loadingCohorts, setLoadingCohorts] = useState(false);

  const [ru, setRu] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [semester, setSemester] = useState<"1" | "2">("1");
  const [companyName, setCompanyName] = useState("");
  const [cohortId, setCohortId] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // Load session/token
  useEffect(() => {
    let active = true;

    async function load() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      const t = data.session?.access_token ?? null;
      setToken(t);
      setReady(true);

      if (!t) router.replace("/");
    }

    load();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      const t = s?.access_token ?? null;
      setToken(t);
      setReady(true);
      if (!t) router.replace("/");
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);


  // Load cohorts
  useEffect(() => {
    if (!ready || !token) return;

    let active = true;
    setLoadingCohorts(true);
    setErrorMsg(null);

    (async () => {
      try {
        const res = await fetch("/api/cohorts/active", { headers: { ...authHeaders } });
        const json = await res.json().catch(() => null);

        if (!active) return;

        if (!res.ok || json?.ok === false) {
          setErrorMsg(json?.message ?? "No se pudo cargar cohortes.");
          setCohorts([]);
          return;
        }

        const payload = json?.data ?? json;
        const list = Array.isArray(payload?.cohorts) ? payload.cohorts : [];
        setCohorts(list);

        if (!cohortId && list.length) setCohortId(list[0].id);
      } catch (e) {
        if (!active) return;
        setErrorMsg("Error de red al cargar cohortes.");
      } finally {
        if (active) setLoadingCohorts(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, token, authHeaders, cohortId]);

  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <p className="text-sm text-slate-300">Cargando...</p>
      </main>
    );
  }

  if (!token) return null;

  function setZodFieldErrors(details: unknown) {
    // details esperado: { fieldErrors: { ru: ["..."], ... } }
    const d = details as any;
    const fe = d?.fieldErrors;
    if (!fe || typeof fe !== "object") return;

    const next: FieldErrors = {};
    for (const key of Object.keys(fe)) {
      const arr = fe[key];
      if (Array.isArray(arr) && arr.length && typeof arr[0] === "string") {
        // solo guardamos el primer error por campo para no saturar
        (next as any)[key] = arr[0];
      }
    }
    setFieldErrors(next);
  }

  async function handleSubmit() {
    setErrorMsg(null);
    setInfoMsg(null);
    setFieldErrors({});

    // Validación mínima cliente (sin duplicar toda la lógica Zod del server)
    if (!ru.trim()) {
      setFieldErrors({ ru: "RU es obligatorio." });
      return;
    }
    if (!firstName.trim()) {
      setFieldErrors({ first_name: "Nombres son obligatorios." });
      return;
    }
    if (!lastName.trim()) {
      setFieldErrors({ last_name: "Apellidos son obligatorios." });
      return;
    }
    if (!cohortId) {
      setFieldErrors({ cohort_id: "Selecciona una cohorte." });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          ru,
          first_name: firstName,
          last_name: lastName,
          semester, // "1" | "2"
          company_name: companyName || null,
          cohort_id: cohortId,
        }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        const msg = json?.message ?? "No se pudo guardar el registro.";
        setErrorMsg(msg);

        // Si viene Zod flatten, mostramos por campo
        if (json?.details) {
          setZodFieldErrors(json.details);
        }

        // Mensaje adicional si es “registro aún no habilitado”
        const opensAt = json?.details?.registration_opens_at;
        if (opensAt) {
          setInfoMsg(`El registro se habilita en: ${String(opensAt)}`);
        }
        return;
      }

      setInfoMsg("Registro enviado. Queda pendiente de aprobación del docente.");
      router.replace("/chat");
    } catch (e) {
      setErrorMsg("Error de red al enviar el registro.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-xl font-semibold mb-1">Registro de estudiante</h1>
        <p className="text-sm text-slate-400 mb-6">
          Completa tus datos académicos para habilitar el uso de OPT-IA.
        </p>

        {errorMsg && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">
            {errorMsg}
          </div>
        )}
        {infoMsg && (
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-200">
            {infoMsg}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">RU</label>
            <input
              value={ru}
              onChange={(e) => setRu(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
              placeholder="Ej: 20201234"
              inputMode="numeric"
            />
            {fieldErrors.ru && <p className="mt-1 text-xs text-red-300">{fieldErrors.ru}</p>}
          </div>

          <div>
            <label className="text-xs text-slate-400">Semestre</label>
            <select
              value={semester}
              onChange={(e) => setSemester(e.target.value as "1" | "2")}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
            >
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
            {fieldErrors.semester && (
              <p className="mt-1 text-xs text-red-300">{fieldErrors.semester}</p>
            )}
          </div>

          <div>
            <label className="text-xs text-slate-400">Nombres</label>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
              placeholder="Ej: Alan"
            />
            {fieldErrors.first_name && (
              <p className="mt-1 text-xs text-red-300">{fieldErrors.first_name}</p>
            )}
          </div>

          <div>
            <label className="text-xs text-slate-400">Apellidos</label>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
              placeholder="Ej: Gómez"
            />
            {fieldErrors.last_name && (
              <p className="mt-1 text-xs text-red-300">{fieldErrors.last_name}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className="text-xs text-slate-400">Empresa (opcional)</label>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
              placeholder="Ej: Empresa X (sin nombre real si es sensible)"
            />
            {fieldErrors.company_name && (
              <p className="mt-1 text-xs text-red-300">{fieldErrors.company_name}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className="text-xs text-slate-400">Cohorte</label>
            <select
              value={cohortId}
              onChange={(e) => setCohortId(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2 text-sm"
              disabled={loadingCohorts}
            >
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {fieldErrors.cohort_id && (
              <p className="mt-1 text-xs text-red-300">{fieldErrors.cohort_id}</p>
            )}
            {!loadingCohorts && cohorts.length === 0 && (
              <p className="mt-2 text-xs text-slate-500">
                No hay cohortes activas. Pide al docente/admin que cree una.
              </p>
            )}
          </div>
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting || loadingCohorts || cohorts.length === 0}
          className="mt-5 w-full rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-sm font-semibold"
        >
          {submitting ? "Enviando..." : "Enviar registro"}
        </button>

        <p className="mt-3 text-xs text-slate-500">
          Al enviar, tu cuenta queda <b>pendiente de aprobación</b>. El acceso se habilita según el cohorte.
        </p>
      </div>
    </main>
  );
}
