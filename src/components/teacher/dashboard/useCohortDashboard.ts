// src/components/teacher/dashboard/useCohortDashboard.ts
//
// Datos del panel nativo: opciones de cohorte (GET /api/teacher/cohorts/list) y el panel de la
// cohorte elegida (GET /api/teacher/dashboard). Sin cohortId la API devuelve la más reciente.
// La autoridad es del servidor: aquí solo se manda el token de la sesión y se pinta lo que
// responde; un 401/403 no deja datos en pantalla.

import { useEffect, useRef, useState } from "react";

import { supabase } from "@/lib/supabaseClient";
import type { TeacherDashboard as TeacherDashboardData } from "@/lib/teacher/dashboard/aggregate";
import {
  readCohortOptions,
  readDashboardResponse,
  type CohortOption,
} from "@/lib/teacher/dashboard/view";

export type CohortDashboardState =
  | { status: "loading" }
  | { status: "ready"; data: TeacherDashboardData }
  | { status: "empty"; message: string }
  | { status: "denied" }
  | { status: "error"; message: string };

// Mismo patrón que CohortsPanel: token fresco de la sesión en cada petición.
async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useCohortDashboard() {
  // null = la cohorte más reciente (la resuelve la API).
  const [cohortId, setCohortId] = useState<string | null>(null);
  const [cohorts, setCohorts] = useState<CohortOption[]>([]);
  const [state, setState] = useState<CohortDashboardState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  // Opciones del selector. Si falla, el selector muestra solo la cohorte cargada.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch("/api/teacher/cohorts/list", { headers });
        const json: unknown = await res.json().catch(() => null);
        if (!active || !res.ok) return;
        setCohorts(readCohortOptions(json));
      } catch {
        // sin lista: queda la cohorte del panel
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // El estado pasa a "loading" en selectCohort/reload (y al montar), no aquí: el effect solo
  // pide y aplica la respuesta más reciente.
  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    (async () => {
      try {
        const headers = await getAuthHeaders();
        const query = cohortId ? `?cohortId=${encodeURIComponent(cohortId)}` : "";
        const res = await fetch(`/api/teacher/dashboard${query}`, { headers });
        const json: unknown = await res.json().catch(() => null);
        if (requestIdRef.current !== requestId) return;

        if (res.status === 401 || res.status === 403) {
          setState({ status: "denied" });
          return;
        }

        if (res.status === 404) {
          setState(
            cohortId
              ? { status: "error", message: "La cohorte seleccionada no existe." }
              : { status: "empty", message: "Todavía no hay cohortes creadas." }
          );
          return;
        }

        const data = res.ok ? readDashboardResponse(json) : null;
        if (!data) {
          setState({ status: "error", message: "No se pudo cargar el panel. Intenta de nuevo." });
          return;
        }

        setState({ status: "ready", data });
      } catch {
        if (requestIdRef.current !== requestId) return;
        setState({ status: "error", message: "Error de red al cargar el panel." });
      }
    })();
  }, [cohortId, reloadKey]);

  function selectCohort(nextCohortId: string) {
    if (nextCohortId === cohortId) return;
    setState({ status: "loading" });
    setCohortId(nextCohortId);
  }

  function reload() {
    setState({ status: "loading" });
    setReloadKey((key) => key + 1);
  }

  return { cohortId, cohorts, state, selectCohort, reload };
}
