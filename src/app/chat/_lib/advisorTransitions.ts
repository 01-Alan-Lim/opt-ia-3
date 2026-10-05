// src/app/chat/_lib/advisorTransitions.ts
//
// Piezas puras de las transiciones del asesor, movidas tal cual desde page.tsx:
// - cómo se lee la etapa siguiente que autoriza el servidor al validar (next.toStage: solo 3-10)
//   y las causas críticas que devuelve Pareto; el cliente no inventa la etapa siguiente;
// - cuándo conservar el estado local si /api/plans/active-stage falla;
// - asRecordOrNull, que usan la sincronización y el refresco de la etapa activa.
// Las transiciones con estado (applyBackendAdvisorAdvance, applyResolvedAdvisorStage,
// restoreLatestAdvisorStageToNewChat) siguen en page.tsx.

import type { AdvisorRuntimeStage } from "@/lib/plan/advisorStates";

export function shouldPreserveAdvisorStateOnRefreshFailure(args: {
  currentStage: AdvisorRuntimeStage;
  status: number;
  errorCode?: string | null;
}) {
  if (args.currentStage == null || args.currentStage <= 0) return false;

  if (args.status >= 500) return true;
  if (args.errorCode === "AUTH_UPSTREAM_TIMEOUT") return true;

  return false;
}

export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type ValidationPayloadLike = {
  next?: { toStage?: number | null; hint?: string | null } | null;
  roots?: string[] | null;
  final?: {
    criticalRoots?: string[] | null;
    selectedRoots?: string[] | null;
  } | null;
};

export function readNextStageFromValidation(
  payload: ValidationPayloadLike | null | undefined
): 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null {
  const raw = payload?.next?.toStage;
  return raw === 3 ||
    raw === 4 ||
    raw === 5 ||
    raw === 6 ||
    raw === 7 ||
    raw === 8 ||
    raw === 9 ||
    raw === 10
    ? raw
    : null;
}

export function readCriticalRootsFromValidation(
  payload: ValidationPayloadLike | null | undefined
): string[] {
  const raw = payload?.final?.criticalRoots;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const text = String(item ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out;
}
