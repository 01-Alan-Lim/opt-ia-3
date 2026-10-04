// src/lib/plan/advisorStates.ts
//
// Modelos de estado del asesor para E1-E10 tal como los maneja el chat (src/app/chat/page.tsx):
// tipos, normalizadores de estados guardados (incluida la compatibilidad con estados antiguos de
// FODA y Pareto) y reglas puras de "listo". Sin React, I/O ni persistencia. Se movió tal cual.
// Los tipos de Ishikawa del chat no están aquí: difieren de los canónicos de ishikawaTree.ts y
// siguen en page.tsx hasta que se unifiquen.

import { normalizeText } from "./advisorClientIntent";
import { normalizeEffectPercent, normalizeJustification } from "./paretoCut";

// -----------------------------
// Etapa 1 (Productividad) Wizard
// -----------------------------
export type ProdStep = 0 | 1 | 2 | 3 | 4 | 5;
// 0=idle, 1=tipo, 2=periodo, 3=ingreso, 4=costos, 5=confirmacion

export type ProductivityDraft = {
  type?: "monetaria" | "fisica";
  unit_reason?: string;         // por qué eligió monetaria/física
  required_costs?: number;      // 3 o 4 (configurable). Default 4
  period_key?: string;          // YYYY-MM
  line?: string;                // línea/producto
  income_bs?: number;           // ingresos del mes
  costs?: { name: string; amount_bs: number; note?: string }[];
  notes?: string;
};

type FodaQuadrant = "F" | "D" | "O" | "A";

export type FodaState = {
  currentQuadrant: FodaQuadrant;
  pendingEvidence?: { quadrant: FodaQuadrant; index: number } | null;
  items: {
    F: { text: string; evidence?: string }[];
    D: { text: string; evidence?: string }[];
    O: { text: string; evidence?: string }[];
    A: { text: string; evidence?: string }[];
  };
};

export function sanitizeFodaState(raw: unknown): FodaState | null {
  const source =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : null;

  if (!source) return null;

  const currentQuadrantRaw = source.currentQuadrant;
  const currentQuadrant: FodaQuadrant =
    currentQuadrantRaw === "F" ||
    currentQuadrantRaw === "D" ||
    currentQuadrantRaw === "O" ||
    currentQuadrantRaw === "A"
      ? currentQuadrantRaw
      : "F";

  const rawItems =
    source.items && typeof source.items === "object"
      ? (source.items as Record<string, unknown>)
      : {};

  const normalizeItemArray = (
    value: unknown
  ): { text: string; evidence?: string }[] => {
    if (!Array.isArray(value)) return [];

    return value
      .map((entry) => {
        if (typeof entry === "string") {
          const text = entry.trim();
          return text ? { text } : null;
        }

        if (!entry || typeof entry !== "object") return null;

        const record = entry as Record<string, unknown>;

        const text =
          typeof record.text === "string"
            ? record.text.trim()
            : typeof record.label === "string"
              ? record.label.trim()
              : typeof record.title === "string"
                ? record.title.trim()
                : "";

        const evidence =
          typeof record.evidence === "string"
            ? record.evidence.trim()
            : typeof record.support === "string"
              ? record.support.trim()
              : typeof record.justification === "string"
                ? record.justification.trim()
                : "";

        if (!text) return null;

        return evidence ? { text, evidence } : { text };
      })
      .filter(
        (item): item is { text: string; evidence?: string } => Boolean(item)
      );
  };

  const pendingRaw =
    source.pendingEvidence && typeof source.pendingEvidence === "object"
      ? (source.pendingEvidence as Record<string, unknown>)
      : null;

  const pendingQuadrantRaw = pendingRaw?.quadrant;
  const pendingIndexRaw = pendingRaw?.index;

  const pendingQuadrant: FodaQuadrant | null =
    pendingQuadrantRaw === "F" ||
    pendingQuadrantRaw === "D" ||
    pendingQuadrantRaw === "O" ||
    pendingQuadrantRaw === "A"
      ? pendingQuadrantRaw
      : null;

  const pendingIndex =
    typeof pendingIndexRaw === "number" &&
    Number.isInteger(pendingIndexRaw) &&
    pendingIndexRaw >= 0
      ? pendingIndexRaw
      : null;

  const pendingEvidence: FodaState["pendingEvidence"] =
    pendingQuadrant !== null && pendingIndex !== null
      ? { quadrant: pendingQuadrant, index: pendingIndex }
      : null;

  return {
    currentQuadrant,
    pendingEvidence,
    items: {
      F: normalizeItemArray(rawItems.F),
      D: normalizeItemArray(rawItems.D),
      O: normalizeItemArray(rawItems.O),
      A: normalizeItemArray(rawItems.A),
    },
  };
}

type ParetoCriterion = { id: string; name: string; weight?: number };

export type ParetoState = {
  roots: string[];              // viene de ishikawa_final.validate
  selectedRoots: string[];      // todas las raíces de Ishikawa (para trabajar en Excel)
  criteria: ParetoCriterion[];  // 0..3 durante la conversación; 3 al validar
  criticalRoots: string[];      // grupo crítico (el estudiante vuelve del Excel y lo pega)
  criticalEffectPercent: number | null; // % del problema que concentra el grupo crítico (Excel)
  criticalJustification: string | null;
  step:
    | "select_roots"
    | "define_criteria"
    | "set_weights"
    | "excel_work"
    | "collect_critical"
    | "done";
};

const PARETO_STEPS = [
  "select_roots",
  "define_criteria",
  "set_weights",
  "excel_work",
  "collect_critical",
  "done",
] as const;

function normalizeParetoStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function normalizeParetoCriterionKey(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLegacyAutoParetoCriteria(criteria: ParetoCriterion[]) {
  if (criteria.length !== 3) return false;

  const names = criteria.map((item) => normalizeParetoCriterionKey(item.name)).sort();
  const expected = ["impacto", "frecuencia", "controlabilidad"].sort();

  const sameNames = names.every((value, index) => value === expected[index]);

  const hasAnyWeight = criteria.some((item) => {
    const weight = Number(item.weight);
    return Number.isFinite(weight) && weight >= 1 && weight <= 10;
  });

  return sameNames && !hasAnyWeight;
}

export function normalizeParetoStateClient(input: unknown): ParetoState | null {
  if (!input || typeof input !== "object") return null;

  const source = input as Record<string, unknown>;

  const roots = normalizeParetoStringArray(source.roots);

  // Pareto no tiene mínimo ni tope propio (CLAUDE.md): recibe todas las raíces de Ishikawa.
  // minSelected/maxSelected de estados antiguos se ignoran.
  const selectedRootsRaw = normalizeParetoStringArray(source.selectedRoots);
  const selectedRoots = selectedRootsRaw.length > 0 ? selectedRootsRaw : roots;

  const selectedSet = new Set(selectedRoots.map((item) => item.toLowerCase()));
  const criticalRoots = normalizeParetoStringArray(source.criticalRoots).filter((item) =>
    selectedSet.size === 0 ? true : selectedSet.has(item.toLowerCase())
  );

  const rawCriteria = Array.isArray(source.criteria) ? source.criteria : [];
  const parsedCriteria: ParetoCriterion[] = rawCriteria
    .map((item) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};

      const name = String(record.name ?? "").trim();
      const id = String(record.id ?? "").trim() || crypto.randomUUID();
      const weightRaw = Number(record.weight);
      const weight =
        Number.isFinite(weightRaw) && weightRaw >= 1 && weightRaw <= 10
          ? weightRaw
          : undefined;

      if (!name) return null;

      return {
        id,
        name,
        ...(weight !== undefined ? { weight } : {}),
      };
    })
    .filter((item): item is ParetoCriterion => Boolean(item))
    .slice(0, 3);

  const criteria = isLegacyAutoParetoCriteria(parsedCriteria) ? [] : parsedCriteria;

  const rawStep = String(source.step ?? "").trim();
  const step = (PARETO_STEPS as readonly string[]).includes(rawStep)
    ? (rawStep as ParetoState["step"])
    : "select_roots";

  return {
    roots,
    selectedRoots,
    criteria,
    criticalRoots,
    criticalEffectPercent: normalizeEffectPercent(source.criticalEffectPercent),
    criticalJustification: normalizeJustification(source.criticalJustification),
    step,
  };
}

export type ObjectivesState = {
  generalObjective: string;
  specificObjectives: string[];
  linkedCriticalRoots: string[];
  step: "general" | "specific" | "review";
};

type ImprovementInitiative = {
  id: string;
  title: string;
  description: string;
  linkedRoot: string | null;       // causa crítica (Pareto) o raíz (Ishikawa)
  linkedObjective: string | null;  // objetivo específico (Etapa 6)
  measurement: {
    indicator: string | null;      // puede ser cualitativo
    kpi: string | null;            // opcional
    target: string | null;         // opcional
  };
  feasibility: {
    estimatedWeeks: number | null;
    notes: string | null;
  };
};

export type ImprovementState = {
  stageIntroDone: boolean;
  step: "discover" | "build" | "refine" | "review";
  focus: {
    chosenRoot: string | null;
    chosenObjective: string | null;
  };
  initiatives: ImprovementInitiative[];
  lastSummary: string | null;
};

// ================================
// ETAPA 8: Planificación (types + gate helper)
// ================================
type PlanningMilestone = {
  id: string;
  title: string;
  week: number | null; // 1..N
  deliverable: string | null;
};

type PlanningWeekItem = {
  week: number;
  focus: string;
  tasks: string[];
  evidence: string | null;
  measurement: string | null;
};

export type PlanningState = {
  stageIntroDone: boolean;
  step: "time_window" | "breakdown" | "schedule" | "review";
  time: {
    studentWeeks: number | null;
    courseCutoffDate: string | null; // opcional si el contexto lo trae
    effectiveWeeks: number | null;   // opcional
    notes: string | null;
  };
  plan: {
    weekly: PlanningWeekItem[];
    milestones: PlanningMilestone[];
    risks: string[];
  };
  lastSummary: string | null;
};

// ================================
// ETAPA 9: Reporte de avances
// ================================
export type ProgressState = {
  step: "intro" | "report" | "clarify" | "review";
  reportText: string | null;
  progressPercent: number | null; // 0–100
  measurementNote: string | null; // solo textual
  summary: string | null;
  updatedAtLocal: string | null;
};

export function isProgressReadyForValidation(st: ProgressState) {
  if (!st) return false;

  const textOk =
    typeof st.reportText === "string" &&
    st.reportText.trim().length >= 12;

  return textOk;
}

// ================================
// ETAPA 10: Documento final (Word/PDF) - 2 versiones máximo
// ================================
export type FinalDocState = {
  // Nota: "review" coincide con lo que devuelve /api/plans/final_doc/assistant
  step: "await_upload" | "review" | "needs_v2" | "finalized";
  versionNumber: 1 | 2;
  lastFeedback: string | null;

  upload: {
    fileName: string | null;
    storagePath: string | null;
    extractedText: string | null;
    uploadedAt: string | null;
  };

  // Campo esperado por /api/plans/final_doc/validate (no es obligatorio en UI, pero se guarda)
  extractedSections?: {
    resumen_ejecutivo?: string | null;
    diagnostico?: string | null;
    objetivos?: string | null;
    propuesta_mejora?: string | null;
    plan_implementacion?: string | null;
    conclusiones?: string | null;
  } | null;

  // Campo esperado por /api/plans/final_doc/validate (sale desde la IA)
  evaluation?: {
    total_score?: number;
    total_label?: "Deficiente" | "Regular" | "Adecuado" | "Bien";
    detail?: Record<string, unknown>;
    signals?: Record<string, unknown>;
    mejoras?: string[];
    needs_resubmission?: boolean;
  } | null;
};

export function isFinalDocReadyForUpload(st: FinalDocState | null) {
  if (!st) return false;

  return (
    st.step === "await_upload" ||
    st.step === "review" ||
    st.step === "needs_v2"
  );
}

export function canShowFinalDocUploadButton(
  mode: "general" | "plan_mejora",
  canInteract: boolean,
  activeAdvisorStage: AdvisorRuntimeStage,
  st: FinalDocState | null
) {
  if (mode !== "plan_mejora") return false;
  if (!canInteract) return false;
  if (activeAdvisorStage !== 10) return false;

  // Si aún no cargó state desde BD, igual mostramos el botón
  // porque Etapa 10 sí permite adjuntar.
  if (!st) return true;

  return isFinalDocReadyForUpload(st);
}

export function isFodaComplete(st: FodaState) {
  const quadrants: Array<keyof FodaState["items"]> = ["F", "D", "O", "A"];
  const okCounts = quadrants.every((q) => Array.isArray(st.items?.[q]) && st.items[q].length >= 3);
  const noPending = !st.pendingEvidence;
  return okCounts && noPending;
}

export function isObjectivesReadyForValidation(st: {
  generalObjective: string;
  specificObjectives: string[];
  linkedCriticalRoots: string[];
}) {
  const generalOk = (st.generalObjective ?? "").trim().length >= 15;

  const specificOk =
    Array.isArray(st.specificObjectives) &&
    st.specificObjectives.filter((s) => (s ?? "").trim().length > 0).length >= 3;

  const linkedOk =
    Array.isArray(st.linkedCriticalRoots) &&
    st.linkedCriticalRoots.filter((r) => (r ?? "").trim().length > 0).length >= 1;

  return generalOk && specificOk && linkedOk;
}

export type AdvisorRuntimeStage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;

export function isAdvisorRuntimeStageValue(value: unknown): value is Exclude<AdvisorRuntimeStage, null> {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10
  );
}

export function isObjectivesStateLike(value: unknown): value is ObjectivesState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.generalObjective === "string" &&
    Array.isArray(record.specificObjectives) &&
    Array.isArray(record.linkedCriticalRoots) &&
    (record.step === "general" || record.step === "specific" || record.step === "review")
  );
}

export function getObjectivesMissingItems(st: ObjectivesState | null) {
  if (!st) return ["estado guardado de Objetivos"];

  const missing: string[] = [];
  if ((st.generalObjective ?? "").trim().length < 15) {
    missing.push("objetivo general claro");
  }

  const specificCount = Array.isArray(st.specificObjectives)
    ? st.specificObjectives.filter((item) => (item ?? "").trim().length > 0).length
    : 0;
  if (specificCount < 3) {
    missing.push(`3 objetivos especificos (${specificCount}/3)`);
  }

  const linkedCount = Array.isArray(st.linkedCriticalRoots)
    ? st.linkedCriticalRoots.filter((item) => (item ?? "").trim().length > 0).length
    : 0;
  if (linkedCount < 1) {
    missing.push("vinculo con al menos una causa critica priorizada");
  }

  return missing;
}

type ProdAssistantPatch = {
  unit_type?: "monetaria" | "fisica" | null;
  unit_reason?: string | null;
  period?: string | null;          // YYYY-MM
  income_bs?: number | null;
  income_line?: string | null;
};

type ProdAssistantCost = { name: string; amount_bs: number; note?: string };

export type ProdAssistantResponse = {
  assistantMessage: string;
  updates: {
    step: number;
    patch: ProdAssistantPatch;
    addCosts: ProdAssistantCost[];
  };
  control: {
    needsClarification: boolean;
    doneWithStage: boolean;
  };
  signals?: {
    uncertainty?: number;
    confusion?: number;
    confidence_extract?: number;
  };
};

export function mergeCosts(existing: any, add: ProdAssistantCost[], requiredCosts: number) {
  const prev: ProdAssistantCost[] = Array.isArray(existing) ? existing : [];

  const seen = new Set(prev.map((c) => normalizeText(c.name)));
  const merged: ProdAssistantCost[] = [...prev];

  for (const c of add) {
    const key = normalizeText(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      name: c.name,
      amount_bs: c.amount_bs,
      note: c.note,
    });
    if (merged.length >= requiredCosts) break;
  }

  return merged;
}

export function applyAssistantPatchToDraft(
  current: ProductivityDraft,
  patch: ProdAssistantPatch
): ProductivityDraft {
  const next: ProductivityDraft = { ...current };

  // ✅ MAPEO (para que no se rompa tu estado)
  if (patch.unit_type) next.type = patch.unit_type;
  if (typeof patch.unit_reason === "string" && patch.unit_reason.trim()) next.unit_reason = patch.unit_reason.trim();

  if (patch.period) next.period_key = patch.period;
  if (typeof patch.income_bs === "number") next.income_bs = patch.income_bs;
  if (patch.income_line) next.line = patch.income_line;

  return next;
}
