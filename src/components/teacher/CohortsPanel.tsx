//src/components/teacher/CohortsPanel.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Cohort = {
  id: string;
  name: string;
  is_active: boolean;
  registration_opens_at: string | null;
  access_starts_at: string | null;
  access_ends_at: string | null;

  // ✅ nuevos
  hours_start_at: string | null; // DATE (YYYY-MM-DD)
  form_initial_url: string | null;
  form_monthly_url: string | null;
  form_final_url: string | null;
  reminder_hour: number | null;
  reminder_minute: number | null;

  created_at?: string | null;
};

type FormState = {
  name: string;
  is_active: boolean;
  registration_opens_at: string; // date (YYYY-MM-DD)
  access_starts_at: string; // date
  access_ends_at: string; // date

  // ✅ nuevos
  hours_start_at: string; // date-only YYYY-MM-DD
  form_initial_url: string;
  form_monthly_url: string;
  form_final_url: string;
  reminder_hour: string; // lo guardamos como string en input, convertimos al enviar
  reminder_minute: string;
};

type EventKind = "FORM_INITIAL" | "FORM_MONTHLY" | "FORM_FINAL" | "ADVANCE";

type CohortEventRow = {
  id?: string;
  cohort_id: string;
  event_kind: EventKind;
  event_index: number | null;      // mensual: 1..3, avance: 1..3, otros: null
  event_date: string;              // "YYYY-MM-DD"
  remind_before_days?: number;
  is_enabled?: boolean;
};

type EventsFormState = {
  form_initial_date: string;
  form_monthly_base: string; // ✅ una sola fecha base
  form_final_date: string;

  advance_1: string;
  advance_2: string;
  advance_3: string;
};




function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateOnlyValue(dateOnly: string | null): string {
  if (!dateOnly) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return "";
  return dateOnly;
}

// Convierte YYYY-MM-DD a ISO string.
// - startOfDay: 00:00:00 local
// - endOfDay:   23:59:59.999 local (para que “termine ese día”)
function toIsoFromDateInput(date: string, endOfDay = false): string | null {
  if (!date.trim()) return null;

  const local = endOfDay ? `${date}T23:59:59.999` : `${date}T00:00:00.000`;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

function normalizeUrlOrNull(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

function parseDateOnlyOrNull(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function isSaturdayUtc(dateOnly: string): boolean {
  const d = new Date(dateOnly); // YYYY-MM-DD => UTC 00:00
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCDay() === 6;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function CohortsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [selected, setSelected] = useState<Cohort | null>(null);
  const [creating, setCreating] = useState(false);

  const initialForm: FormState = useMemo(
    () => ({
      name: "",
      is_active: true,
      registration_opens_at: "",
      access_starts_at: "",
      access_ends_at: "",

      hours_start_at: "",
      form_initial_url: "",
      form_monthly_url: "",
      form_final_url: "",
      reminder_hour: "11",
      reminder_minute: "0",
    }),
    []
  );

  const [form, setForm] = useState<FormState>(initialForm);
  const initialEventsForm: EventsFormState = useMemo(
    () => ({
      form_initial_date: "",
      form_monthly_base: "",
      form_final_date: "",
      advance_1: "",
      advance_2: "",
      advance_3: "",
    }),
    []
  );

  const [eventsForm, setEventsForm] = useState<EventsFormState>(initialEventsForm);
  const [eventsLoading, setEventsLoading] = useState(false);


  function fillFormFromCohort(c: Cohort) {
    setForm({
      name: c.name ?? "",
      is_active: Boolean(c.is_active),
      registration_opens_at: toDateInputValue(c.registration_opens_at),
      access_starts_at: toDateInputValue(c.access_starts_at),
      access_ends_at: toDateInputValue(c.access_ends_at),

      hours_start_at: toDateOnlyValue(c.hours_start_at),
      form_initial_url: c.form_initial_url ?? "",
      form_monthly_url: c.form_monthly_url ?? "",
      form_final_url: c.form_final_url ?? "",
      reminder_hour: String(c.reminder_hour ?? 11),
      reminder_minute: String(c.reminder_minute ?? 0),
    });
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/teacher/cohorts/list", { headers });
      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        setError(json?.message ?? "No se pudo cargar cohortes.");
        setCohorts([]);
        return;
      }

      const list: Cohort[] = json?.data?.cohorts ?? [];
      setCohorts(list);

      // Mantener seleccionado si existe
      if (selected) {
        const next = list.find((x) => x.id === selected.id) ?? null;
        setSelected(next);
        if (next) fillFormFromCohort(next);
      }
    } catch {
      setError("Error de red cargando cohortes.");
      setCohorts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildPayload() {
    const hour = Number(form.reminder_hour);
    const minute = Number(form.reminder_minute);

    return {
      name: form.name.trim(),
      is_active: form.is_active,
      registration_opens_at: toIsoFromDateInput(form.registration_opens_at, false),
      access_starts_at: toIsoFromDateInput(form.access_starts_at, false),
      access_ends_at: toIsoFromDateInput(form.access_ends_at, true), // fin del día

      // ✅ nuevos
      hours_start_at: parseDateOnlyOrNull(form.hours_start_at),
      form_initial_url: normalizeUrlOrNull(form.form_initial_url),
      form_monthly_url: normalizeUrlOrNull(form.form_monthly_url),
      form_final_url: normalizeUrlOrNull(form.form_final_url),
      reminder_hour: Number.isFinite(hour) ? hour : 11,
      reminder_minute: 0,

    };
  }

  function validateDates(): string | null {
    if (form.access_starts_at && form.access_ends_at) {
      const start = new Date(`${form.access_starts_at}T00:00:00.000`);
      const end = new Date(`${form.access_ends_at}T00:00:00.000`);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
        return "Acceso termina debe ser posterior o igual a Acceso inicia.";
      }
    }
    return null;
  }

  function validateFollowup(): string | null {
    // hours_start_at: si está seteado, debe ser sábado
    if (form.hours_start_at.trim()) {
      const d = parseDateOnlyOrNull(form.hours_start_at);
      if (!d) return "Sábado inicial de horas inválido (usa YYYY-MM-DD).";
      if (!isSaturdayUtc(d)) return "El sábado inicial de horas debe caer en sábado.";
    }

    const hour = Number(form.reminder_hour);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return "Hora de recordatorio inválida (0–23).";
    
    return null;
  }


  function toDateValueFromDb(d: string | null | undefined): string {
    if (!d) return "";
    // Si viene como "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;

    // Si viene como ISO
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }

  function fillEventsFromRows(rows: CohortEventRow[]) {
    const get = (kind: EventKind, idx: number | null) =>
      rows.find((r) => r.event_kind === kind && (r.event_index ?? null) === idx)?.event_date ?? "";

    setEventsForm({
      form_initial_date: toDateValueFromDb(get("FORM_INITIAL", null)),
      form_monthly_base: toDateValueFromDb(get("FORM_MONTHLY", 1)), // ✅ base = mensual #1
      form_final_date: toDateValueFromDb(get("FORM_FINAL", null)),
      advance_1: toDateValueFromDb(get("ADVANCE", 1)),
      advance_2: toDateValueFromDb(get("ADVANCE", 2)),
      advance_3: toDateValueFromDb(get("ADVANCE", 3)),
    });
  }

  function addMonthsSameDay(base: string, add: number): string | null {
    const t = base.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;

    const d = new Date(`${t}T00:00:00.000`);
    if (Number.isNaN(d.getTime())) return null;

    const year = d.getFullYear();
    const month = d.getMonth();
    const day = d.getDate();

    const x = new Date(year, month + add, day);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }

  function buildEventsPayload(cohortId: string) {
    const events: {
      event_kind: "FORM_INITIAL" | "FORM_MONTHLY" | "FORM_FINAL" | "ADVANCE";
      event_index?: number | null;
      event_date: string; // YYYY-MM-DD
      remind_before_days?: number;
      is_enabled?: boolean;
    }[] = [];

    const push = (event_kind: any, event_index: number | null, date: string) => {
      const t = date.trim();
      if (!t) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return;

      // ✅ Zod refine: initial/final -> null; monthly/advance -> 1..3
      if (event_kind === "FORM_INITIAL" || event_kind === "FORM_FINAL") {
        events.push({
          event_kind,
          event_index: null,
          event_date: t,
          remind_before_days: 2,
          is_enabled: true,
        });
        return;
      }

      // MONTHLY / ADVANCE requieren 1..3
      if (event_index === null) return;
      if (event_index < 1 || event_index > 3) return;

      events.push({
        event_kind,
        event_index,
        event_date: t,
        remind_before_days: 2,
        is_enabled: true,
      });
    };

    push("FORM_INITIAL", null, eventsForm.form_initial_date);

    // ✅ Mensual: a partir de una sola fecha base, generamos 3 meses
    const m1 = addMonthsSameDay(eventsForm.form_monthly_base, 0);
    const m2 = addMonthsSameDay(eventsForm.form_monthly_base, 1);
    const m3 = addMonthsSameDay(eventsForm.form_monthly_base, 2);

    if (m1) push("FORM_MONTHLY", 1, m1);
    if (m2) push("FORM_MONTHLY", 2, m2);
    if (m3) push("FORM_MONTHLY", 3, m3);

    push("FORM_FINAL", null, eventsForm.form_final_date);

    push("ADVANCE", 1, eventsForm.advance_1);
    push("ADVANCE", 2, eventsForm.advance_2);
    push("ADVANCE", 3, eventsForm.advance_3);

    // Si no hay eventos, devolvemos null para que el caller decida
    if (events.length === 0) return null;

    return { events };
  }

  async function handleCreate() {
    const v = validateDates() ?? validateFollowup();
    if (v) {
      setError(v);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const headers = await getAuthHeaders();
      const payload = buildPayload();

      // ✅ 1) Crear cohorte
      const res = await fetch("/api/teacher/cohorts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setError(json?.message ?? "No se pudo crear la cohorte.");
        return;
      }

      // ✅ 2) ID real de la cohorte creada
      const newCohortId: string | undefined = json?.data?.cohort?.id;

      // ✅ 3) Guardar eventos si hay fechas
      if (newCohortId) {
        const eventsPayload = buildEventsPayload(newCohortId); // null si no hay fechas

        if (eventsPayload) {
          const res2 = await fetch(`/api/teacher/cohorts/${newCohortId}/events`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(eventsPayload),
          });

          const json2 = await res2.json().catch(() => null);
          if (!res2.ok || json2?.ok === false) {
            setError(json2?.message ?? "Se creó la cohorte, pero falló guardar las fechas.");
            // no retornamos; igual recargamos
          }
        }
      }

      // ✅ 4) limpiar UI y recargar
      setCreating(false);
      setForm(initialForm);
      setEventsForm(initialEventsForm);
      await load();
    } catch {
      setError("Error de red creando cohorte.");
    } finally {
      setSaving(false);
    }
  }


  async function handleSaveEdit() {
    if (!selected) return;

    const v = validateDates() ?? validateFollowup();
    if (v) {
      setError(v);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const payload = buildPayload();

      const res = await fetch(`/api/teacher/cohorts/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setError(json?.message ?? "No se pudo actualizar la cohorte.");
        return;
      }

      // ✅ Guardar eventos si hay fechas
      const eventsPayload = buildEventsPayload(selected.id);

      // ✅ buildEventsPayload puede devolver null
      if (eventsPayload) {
        const res2 = await fetch(`/api/teacher/cohorts/${selected.id}/events`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(eventsPayload),
        });

        const json2 = await res2.json().catch(() => null);
        if (!res2.ok || json2?.ok === false) {
          setError(json2?.message ?? "Se guardó la cohorte, pero falló guardar las fechas.");
        }
      }

      await load();

    } catch {
      setError("Error de red actualizando cohorte.");
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(c: Cohort) {
    setSaving(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/teacher/cohorts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ is_active: true }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        setError(json?.message ?? "No se pudo activar la cohorte.");
        return;
      }
      await load();
    } catch {
      setError("Error de red activando cohorte.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Cohortes</h2>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setSelected(null);
              setForm(initialForm);
              setEventsForm(initialEventsForm); // ✅ limpiar fechas
              setError(null);
            }}
            className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-60"
            disabled={saving}
          >
            Nueva cohorte
          </button>
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900 disabled:opacity-60"
            disabled={saving}
          >
            Recargar
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-xl border border-red-900/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* LISTA */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="mb-2 text-xs text-slate-400">Lista</div>

          {loading ? (
            <div className="text-sm text-slate-300">Cargando...</div>
          ) : cohorts.length === 0 ? (
            <div className="text-sm text-slate-300">No hay cohortes.</div>
          ) : (
            <ul className="space-y-2">
              {cohorts.map((c) => (
                <li key={c.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(c);
                        setCreating(false);
                        setError(null);
                        fillFormFromCohort(c);

                        // ✅ cargar fechas desde cohort_events
                        (async () => {
                          setEventsLoading(true);
                          try {
                            const headers = await getAuthHeaders();
                            const res = await fetch(`/api/teacher/cohorts/${c.id}/events`, { headers });
                            const json = await res.json().catch(() => null);

                            if (!res.ok || json?.ok === false) {
                              // si no existe nada todavía, dejamos vacío
                              fillEventsFromRows([]);
                              return;
                            }

                            const rows: CohortEventRow[] = json?.data?.events ?? [];
                            fillEventsFromRows(rows);
                          } catch {
                            fillEventsFromRows([]);
                          } finally {
                            setEventsLoading(false);
                          }
                        })();
                      }}

                      className="text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">{c.name}</span>
                        {c.is_active ? (
                          <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-[11px] text-emerald-200">
                            Activa
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-700/40 px-2 py-0.5 text-[11px] text-slate-200">
                            Inactiva
                          </span>
                        )}
                      </div>

                      <div className="mt-1 text-xs text-slate-400">
                        Acceso:{" "}
                        <span className="text-slate-300">
                          {c.access_starts_at ? new Date(c.access_starts_at).toLocaleString() : "—"}
                        </span>{" "}
                        →{" "}
                        <span className="text-slate-300">
                          {c.access_ends_at ? new Date(c.access_ends_at).toLocaleString() : "—"}
                        </span>
                      </div>
                    </button>

                    {!c.is_active && (
                      <button
                        type="button"
                        onClick={() => handleActivate(c)}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900 disabled:opacity-60"
                        disabled={saving}
                      >
                        Activar
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* FORM */}
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="mb-2 text-xs text-slate-400">
            {creating ? "Crear cohorte" : selected ? "Editar cohorte" : "Selecciona una cohorte"}
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Nombre</span>
              <input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                placeholder="Ej: 2026-1 Ing. Métodos"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
              />
              Marcar como activa
            </label>

            {/* FECHAS (registro + acceso)*/}
            <div className="grid grid-cols-1 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">Registro abre</span>
                <input
                  type="date"
                  value={form.registration_opens_at}
                  onChange={(e) => setForm((p) => ({ ...p, registration_opens_at: e.target.value }))}
                  className="
                    w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                    pr-1 cursor-pointer
                    [&::-webkit-calendar-picker-indicator]:opacity-80
                    [&::-webkit-calendar-picker-indicator]:invert
                    [&::-webkit-calendar-picker-indicator]:cursor-pointer
                  "
                />
              </label>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">Acceso inicia</span>
                  <input
                    type="date"
                    value={form.access_starts_at}
                    onChange={(e) => setForm((p) => ({ ...p, access_starts_at: e.target.value }))}
                    className="
                      w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                      pr-1 cursor-pointer
                      [&::-webkit-calendar-picker-indicator]:opacity-80
                      [&::-webkit-calendar-picker-indicator]:invert
                      [&::-webkit-calendar-picker-indicator]:cursor-pointer
                    "
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">Acceso termina</span>
                  <input
                    type="date"
                    value={form.access_ends_at}
                    onChange={(e) => setForm((p) => ({ ...p, access_ends_at: e.target.value }))}
                    className="
                      w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                      pr-1 cursor-pointer
                      [&::-webkit-calendar-picker-indicator]:opacity-80
                      [&::-webkit-calendar-picker-indicator]:invert
                      [&::-webkit-calendar-picker-indicator]:cursor-pointer
                    "
                  />
                </label>
              </div>
            </div>

            {/* ✅ Seguimiento */}
            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="text-xs font-semibold text-slate-200">Seguimiento (Horas + formularios)</div>
              <div className="mt-2 grid grid-cols-1 gap-3">
          
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Sábado inicial</span>
                    <input
                      type="date"
                      value={form.hours_start_at}
                      onChange={(e) => setForm((p) => ({ ...p, hours_start_at: e.target.value }))}
                      className="
                        w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                        pr-1 cursor-pointer
                        [&::-webkit-calendar-picker-indicator]:opacity-80
                        [&::-webkit-calendar-picker-indicator]:invert
                        [&::-webkit-calendar-picker-indicator]:cursor-pointer
                      "
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Hora recordatorio (0–23)</span>
                    <input
                      inputMode="numeric"
                      value={form.reminder_hour}
                      onChange={(e) => setForm((p) => ({ ...p, reminder_hour: e.target.value }))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      placeholder="11"
                    />
                  </label>
                </div>
              </div>
            </div>

            {/* ✅ Formularios: URL + Fecha (2 columnas x 3 filas) */}
            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="text-xs font-semibold text-slate-200">Formularios</div>
              {eventsLoading ? (
                <div className="mt-2 text-sm text-slate-300">Cargando fechas...</div>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {/* Fila 1: Inicial */}
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Formulario inicial (URL)</span>
                    <input
                          value={form.form_initial_url}
                          onChange={(e) => setForm((p) => ({ ...p, form_initial_url: e.target.value }))}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                          placeholder="https://forms.gle/..."
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Fecha form inicial</span>
                    <input
                          type="date"
                          value={eventsForm.form_initial_date}
                          onChange={(e) => setEventsForm((p) => ({ ...p, form_initial_date: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />
                  </label>

                  {/* Fila 2: Mensual */}
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Formulario de productividad (URL)</span>
                    <input
                          value={form.form_monthly_url}
                          onChange={(e) => setForm((p) => ({ ...p, form_monthly_url: e.target.value }))}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                          placeholder="https://forms.gle/..."
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Fecha form mensual (base)</span>
                    <input
                          type="date"
                          value={eventsForm.form_monthly_base}
                          onChange={(e) => setEventsForm((p) => ({ ...p, form_monthly_base: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />

                  </label>

                  {/* Fila 3: Final */}
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Formulario de sistematización (URL)</span>
                    <input
                          value={form.form_final_url}
                          onChange={(e) => setForm((p) => ({ ...p, form_final_url: e.target.value }))}
                          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                          placeholder="https://forms.gle/..."
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Fecha form final</span>
                    <input
                          type="date"
                          value={eventsForm.form_final_date}
                          onChange={(e) => setEventsForm((p) => ({ ...p, form_final_date: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />
                   </label>
                </div>
              )}
            </div>

            {/* ✅ Avances */}
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="text-xs font-semibold text-slate-200">Fechas de avances</div>

              {eventsLoading ? (
                <div className="mt-2 text-sm text-slate-300">Cargando fechas...</div>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Avance 1</span>
                    <input
                          type="date"
                          value={eventsForm.advance_1}
                          onChange={(e) => setEventsForm((p) => ({ ...p, advance_1: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Avance 2</span>
                    <input
                          type="date"
                          value={eventsForm.advance_2}
                          onChange={(e) => setEventsForm((p) => ({ ...p, advance_2: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs text-slate-400">Avance 3</span>
                    <input
                          type="date"
                          value={eventsForm.advance_3}
                          onChange={(e) => setEventsForm((p) => ({ ...p, advance_3: e.target.value }))}
                          className="
                            w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100
                            pr-1 cursor-pointer
                            [&::-webkit-calendar-picker-indicator]:opacity-80
                            [&::-webkit-calendar-picker-indicator]:invert
                            [&::-webkit-calendar-picker-indicator]:cursor-pointer
                          "
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Botonera */}
            <div className="flex items-center gap-2">
              {creating ? (
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={saving || !form.name.trim()}
                  className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-60"
                >
                  {saving ? "Guardando..." : "Crear"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving || !selected || !form.name.trim()}
                  className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-60"
                >
                  {saving ? "Guardando..." : "Guardar cambios"}
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setSelected(null);
                  setForm(initialForm);
                  setEventsForm(initialEventsForm);
                  setError(null);
                }}
                className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900"
                disabled={saving}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
