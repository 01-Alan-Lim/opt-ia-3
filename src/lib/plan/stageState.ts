// src/lib/plan/stageState.ts
import { z } from "zod";

const OBJECTIVES_STEP_VALUES = ["general", "specific", "review"] as const;
const IMPROVEMENT_STEP_VALUES = ["discover", "build", "refine", "review"] as const;
const PLANNING_STEP_VALUES = ["time_window", "breakdown", "schedule", "review"] as const;
const PROGRESS_STEP_VALUES = ["intro", "report", "clarify", "review"] as const;
const FINAL_DOC_STEP_VALUES = ["await_upload", "review", "needs_v2", "finalized"] as const;

const ObjectivesStateSchema = z.object({
  generalObjective: z.string(),
  specificObjectives: z.array(z.string()),
  linkedCriticalRoots: z.array(z.string()),
  step: z.enum(OBJECTIVES_STEP_VALUES),
});

const ImprovementInitiativeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  linkedRoot: z.string().nullable(),
  linkedObjective: z.string().nullable(),
  measurement: z.object({
    indicator: z.string().nullable(),
    kpi: z.string().nullable(),
    target: z.string().nullable(),
  }),
  feasibility: z.object({
    estimatedWeeks: z.number().nullable(),
    notes: z.string().nullable(),
  }),
});

const ImprovementStateSchema = z.object({
  stageIntroDone: z.boolean(),
  step: z.enum(IMPROVEMENT_STEP_VALUES),
  focus: z.object({
    chosenRoot: z.string().nullable(),
    chosenObjective: z.string().nullable(),
  }),
  initiatives: z.array(ImprovementInitiativeSchema),
  lastSummary: z.string().nullable(),
});

const PlanningMilestoneSchema = z.object({
  id: z.string(),
  title: z.string(),
  week: z.number().nullable(),
  deliverable: z.string().nullable(),
});

const PlanningWeekItemSchema = z.object({
  week: z.number(),
  focus: z.string(),
  tasks: z.array(z.string()),
  evidence: z.string().nullable(),
  measurement: z.string().nullable(),
});

const PlanningStateSchema = z.object({
  stageIntroDone: z.boolean(),
  step: z.enum(PLANNING_STEP_VALUES),
  time: z.object({
    studentWeeks: z.number().nullable(),
    courseCutoffDate: z.string().nullable(),
    effectiveWeeks: z.number().nullable(),
    notes: z.string().nullable(),
  }),
  plan: z.object({
    weekly: z.array(PlanningWeekItemSchema),
    milestones: z.array(PlanningMilestoneSchema),
    risks: z.array(z.string()),
  }),
  lastSummary: z.string().nullable(),
});

const ProgressStateSchema = z.object({
  step: z.enum(PROGRESS_STEP_VALUES),
  reportText: z.string().nullable(),
  progressPercent: z.number().nullable(),
  measurementNote: z.string().nullable(),
  summary: z.string().nullable(),
  updatedAtLocal: z.string().nullable(),
});

const FinalDocStateSchema = z.object({
  step: z.enum(FINAL_DOC_STEP_VALUES),
  versionNumber: z.union([z.literal(1), z.literal(2)]),
  lastFeedback: z.string().nullable(),
  upload: z.object({
    fileName: z.string().nullable(),
    storagePath: z.string().nullable(),
    extractedText: z.string().nullable(),
    uploadedAt: z.string().nullable(),
  }),
  extractedSections: z
    .object({
      resumen_ejecutivo: z.string().nullable().optional(),
      diagnostico: z.string().nullable().optional(),
      objetivos: z.string().nullable().optional(),
      propuesta_mejora: z.string().nullable().optional(),
      plan_implementacion: z.string().nullable().optional(),
      conclusiones: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  evaluation: z
    .object({
      total_score: z.number().optional(),
      total_label: z.enum(["Deficiente", "Regular", "Adecuado", "Bien"]).optional(),
      detail: z.record(z.string(), z.unknown()).optional(),
      signals: z.record(z.string(), z.unknown()).optional(),
      mejoras: z.array(z.string()).optional(),
      needs_resubmission: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

type JsonRecord = Record<string, unknown>;

function asRecord(input: unknown): JsonRecord {
  return typeof input === "object" && input !== null ? (input as JsonRecord) : {};
}

function asString(input: unknown): string {
  return String(input ?? "").trim();
}

function asNullableString(input: unknown): string | null {
  const value = asString(input);
  return value.length > 0 ? value : null;
}

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function asBoolean(input: unknown, fallback = false): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") {
    const value = input.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function asNullableInt(input: unknown, opts?: { min?: number; max?: number }): number | null {
  if (input === null || input === undefined || input === "") return null;

  const n = Number(input);
  if (!Number.isFinite(n)) return null;

  const rounded = Math.round(n);
  if (opts?.min !== undefined && rounded < opts.min) return null;
  if (opts?.max !== undefined && rounded > opts.max) return null;

  return rounded;
}

function normalizeStep<T extends readonly string[]>(
  raw: unknown,
  validSteps: T,
  fallback: T[number],
  legacyMap?: Record<string, T[number]>
): T[number] {
  const value = asString(raw);

  if ((validSteps as readonly string[]).includes(value)) {
    return value as T[number];
  }

  if (legacyMap && legacyMap[value]) {
    return legacyMap[value];
  }

  return fallback;
}

function normalizeObjectivesState(input: unknown) {
  const source = asRecord(input);

  const normalized = {
    generalObjective: asString(source.generalObjective),
    specificObjectives: dedupeStrings(asStringArray(source.specificObjectives)),
    linkedCriticalRoots: dedupeStrings(asStringArray(source.linkedCriticalRoots)),
    step: normalizeStep(source.step, OBJECTIVES_STEP_VALUES, "general", {
      init: "general",
      start: "general",
      intro: "general",
      specifics: "specific",
      specifics_review: "review",
      final: "review",
      done: "review",
    }),
  };

  return ObjectivesStateSchema.parse(normalized);
}

function normalizeImprovementState(input: unknown) {
  const source = asRecord(input);
  const focus = asRecord(source.focus);

  const initiativesRaw = Array.isArray(source.initiatives) ? source.initiatives : [];

  const initiatives = initiativesRaw.map((item) => {
    const record = asRecord(item);
    const measurement = asRecord(record.measurement);
    const feasibility = asRecord(record.feasibility);

    return {
      id: asString(record.id) || crypto.randomUUID(),
      title: asString(record.title),
      description: asString(record.description),
      linkedRoot: asNullableString(record.linkedRoot),
      linkedObjective: asNullableString(record.linkedObjective),
      measurement: {
        indicator: asNullableString(measurement.indicator),
        kpi: asNullableString(measurement.kpi),
        target: asNullableString(measurement.target),
      },
      feasibility: {
        estimatedWeeks: asNullableInt(feasibility.estimatedWeeks, { min: 1, max: 104 }),
        notes: asNullableString(feasibility.notes),
      },
    };
  });

  const normalized = {
    stageIntroDone: asBoolean(source.stageIntroDone, false),
    step: normalizeStep(source.step, IMPROVEMENT_STEP_VALUES, "discover", {
      init: "discover",
      start: "discover",
      draft: "build",
      refine_v2: "refine",
      final: "review",
      done: "review",
    }),
    focus: {
      chosenRoot: asNullableString(focus.chosenRoot),
      chosenObjective: asNullableString(focus.chosenObjective),
    },
    initiatives,
    lastSummary: asNullableString(source.lastSummary),
  };

  return ImprovementStateSchema.parse(normalized);
}

function normalizePlanningState(input: unknown) {
  const source = asRecord(input);
  const time = asRecord(source.time);
  const plan = asRecord(source.plan);

  const weeklyRaw = Array.isArray(plan.weekly) ? plan.weekly : [];
  const milestonesRaw = Array.isArray(plan.milestones) ? plan.milestones : [];

  const weekly = weeklyRaw
    .map((item, index) => {
      const record = asRecord(item);
      const week = asNullableInt(record.week, { min: 1, max: 104 }) ?? index + 1;

      return {
        week,
        focus: asString(record.focus),
        tasks: dedupeStrings(asStringArray(record.tasks)),
        evidence: asNullableString(record.evidence),
        measurement: asNullableString(record.measurement),
      };
    })
    .filter((item) => item.focus.length > 0 || item.tasks.length > 0 || item.evidence || item.measurement);

  const milestones = milestonesRaw
    .map((item) => {
      const record = asRecord(item);

      return {
        id: asString(record.id) || crypto.randomUUID(),
        title: asString(record.title),
        week: asNullableInt(record.week, { min: 1, max: 104 }),
        deliverable: asNullableString(record.deliverable),
      };
    })
    .filter((item) => item.title.length > 0 || item.deliverable);

  const normalized = {
    stageIntroDone: asBoolean(source.stageIntroDone, false),
    step: normalizeStep(source.step, PLANNING_STEP_VALUES, "time_window", {
      init: "time_window",
      start: "time_window",
      breakdown_v1: "breakdown",
      calendar: "schedule",
      final: "review",
      done: "review",
    }),
    time: {
      studentWeeks: asNullableInt(time.studentWeeks, { min: 1, max: 104 }),
      courseCutoffDate: asNullableString(time.courseCutoffDate),
      effectiveWeeks: asNullableInt(time.effectiveWeeks, { min: 1, max: 104 }),
      notes: asNullableString(time.notes),
    },
    plan: {
      weekly,
      milestones,
      risks: dedupeStrings(asStringArray(plan.risks)),
    },
    lastSummary: asNullableString(source.lastSummary),
  };

  return PlanningStateSchema.parse(normalized);
}

function normalizeProgressState(input: unknown) {
  const source = asRecord(input);

  const normalized = {
    step: normalizeStep(source.step, PROGRESS_STEP_VALUES, "intro", {
      init: "intro",
      start: "intro",
      draft: "report",
      revise: "clarify",
      final: "review",
      done: "review",
    }),
    reportText: asNullableString(source.reportText),
    progressPercent: asNullableInt(source.progressPercent, { min: 0, max: 100 }) ?? 0,
    measurementNote: asNullableString(source.measurementNote),
    summary: asNullableString(source.summary),
    updatedAtLocal: asNullableString(source.updatedAtLocal),
  };

  return ProgressStateSchema.parse(normalized);
}

function normalizeFinalDocState(input: unknown) {
  const source = asRecord(input);
  const upload = asRecord(source.upload);
  const extractedSections = asRecord(source.extractedSections);
  const evaluation = asRecord(source.evaluation);

  const totalScoreRaw = Number(evaluation.total_score);
  const totalScore = Number.isFinite(totalScoreRaw) ? totalScoreRaw : undefined;

  const normalized = {
    step: normalizeStep(source.step, FINAL_DOC_STEP_VALUES, "await_upload", {
      init: "await_upload",
      start: "await_upload",
      upload: "await_upload",
      pending_review: "review",
      v2: "needs_v2",
      done: "finalized",
      final: "finalized",
    }),
    versionNumber: source.versionNumber === 2 ? 2 : 1,
    lastFeedback: asNullableString(source.lastFeedback),
    upload: {
      fileName: asNullableString(upload.fileName),
      storagePath: asNullableString(upload.storagePath),
      extractedText: asNullableString(upload.extractedText),
      uploadedAt: asNullableString(upload.uploadedAt),
    },
    extractedSections:
      Object.keys(extractedSections).length === 0
        ? null
        : {
            resumen_ejecutivo: asNullableString(extractedSections.resumen_ejecutivo),
            diagnostico: asNullableString(extractedSections.diagnostico),
            objetivos: asNullableString(extractedSections.objetivos),
            propuesta_mejora: asNullableString(extractedSections.propuesta_mejora),
            plan_implementacion: asNullableString(extractedSections.plan_implementacion),
            conclusiones: asNullableString(extractedSections.conclusiones),
          },
    evaluation:
      Object.keys(evaluation).length === 0
        ? null
        : {
            ...(totalScore !== undefined ? { total_score: totalScore } : {}),
            ...(typeof evaluation.total_label === "string"
              ? { total_label: evaluation.total_label }
              : {}),
            ...(typeof evaluation.detail === "object" && evaluation.detail !== null
              ? { detail: evaluation.detail as Record<string, unknown> }
              : {}),
            ...(typeof evaluation.signals === "object" && evaluation.signals !== null
              ? { signals: evaluation.signals as Record<string, unknown> }
              : {}),
            ...(Array.isArray(evaluation.mejoras)
              ? { mejoras: asStringArray(evaluation.mejoras) }
              : {}),
            ...(typeof evaluation.needs_resubmission === "boolean"
              ? { needs_resubmission: evaluation.needs_resubmission }
              : {}),
          },
  };

  return FinalDocStateSchema.parse(normalized);
}

export function normalizeStageState(stage: number, input: unknown): Record<string, unknown> {
  switch (stage) {
    case 6:
      return normalizeObjectivesState(input);
    case 7:
      return normalizeImprovementState(input);
    case 8:
      return normalizePlanningState(input);
    case 9:
      return normalizeProgressState(input);
    case 10:
      return normalizeFinalDocState(input);
    default:
      return asRecord(input);
  }
}

export function mergeStageState(
  stage: number,
  baseRaw: unknown,
  incomingRaw: unknown
): Record<string, unknown> {
  const base = normalizeStageState(stage, baseRaw);
  const incoming = asRecord(incomingRaw);

  switch (stage) {
    case 6:
      return normalizeStageState(stage, {
        generalObjective:
          Object.prototype.hasOwnProperty.call(incoming, "generalObjective")
            ? incoming.generalObjective
            : base.generalObjective,
        specificObjectives:
          Object.prototype.hasOwnProperty.call(incoming, "specificObjectives")
            ? incoming.specificObjectives
            : base.specificObjectives,
        linkedCriticalRoots:
          Object.prototype.hasOwnProperty.call(incoming, "linkedCriticalRoots")
            ? incoming.linkedCriticalRoots
            : base.linkedCriticalRoots,
        step:
          Object.prototype.hasOwnProperty.call(incoming, "step")
            ? incoming.step
            : base.step,
      });

    case 7:
      return normalizeStageState(stage, {
        stageIntroDone:
          Object.prototype.hasOwnProperty.call(incoming, "stageIntroDone")
            ? incoming.stageIntroDone
            : base.stageIntroDone,
        step:
          Object.prototype.hasOwnProperty.call(incoming, "step")
            ? incoming.step
            : base.step,
        focus:
          Object.prototype.hasOwnProperty.call(incoming, "focus")
            ? incoming.focus
            : base.focus,
        initiatives:
          Object.prototype.hasOwnProperty.call(incoming, "initiatives")
            ? incoming.initiatives
            : base.initiatives,
        lastSummary:
          Object.prototype.hasOwnProperty.call(incoming, "lastSummary")
            ? incoming.lastSummary
            : base.lastSummary,
      });

    case 8:
      return normalizeStageState(stage, {
        stageIntroDone:
          Object.prototype.hasOwnProperty.call(incoming, "stageIntroDone")
            ? incoming.stageIntroDone
            : base.stageIntroDone,
        step:
          Object.prototype.hasOwnProperty.call(incoming, "step")
            ? incoming.step
            : base.step,
        time:
          Object.prototype.hasOwnProperty.call(incoming, "time")
            ? incoming.time
            : base.time,
        plan:
          Object.prototype.hasOwnProperty.call(incoming, "plan")
            ? incoming.plan
            : base.plan,
        lastSummary:
          Object.prototype.hasOwnProperty.call(incoming, "lastSummary")
            ? incoming.lastSummary
            : base.lastSummary,
      });

    case 9:
      return normalizeStageState(stage, {
        step:
          Object.prototype.hasOwnProperty.call(incoming, "step")
            ? incoming.step
            : base.step,
        reportText:
          Object.prototype.hasOwnProperty.call(incoming, "reportText")
            ? incoming.reportText
            : base.reportText,
        progressPercent:
          Object.prototype.hasOwnProperty.call(incoming, "progressPercent")
            ? incoming.progressPercent
            : base.progressPercent,
        measurementNote:
          Object.prototype.hasOwnProperty.call(incoming, "measurementNote")
            ? incoming.measurementNote
            : base.measurementNote,
        summary:
          Object.prototype.hasOwnProperty.call(incoming, "summary")
            ? incoming.summary
            : base.summary,
        updatedAtLocal:
          Object.prototype.hasOwnProperty.call(incoming, "updatedAtLocal")
            ? incoming.updatedAtLocal
            : base.updatedAtLocal,
      });

    case 10:
      return normalizeStageState(stage, {
        step:
          Object.prototype.hasOwnProperty.call(incoming, "step")
            ? incoming.step
            : base.step,
        versionNumber:
          Object.prototype.hasOwnProperty.call(incoming, "versionNumber")
            ? incoming.versionNumber
            : base.versionNumber,
        lastFeedback:
          Object.prototype.hasOwnProperty.call(incoming, "lastFeedback")
            ? incoming.lastFeedback
            : base.lastFeedback,
        upload:
          Object.prototype.hasOwnProperty.call(incoming, "upload")
            ? incoming.upload
            : base.upload,
        extractedSections:
          Object.prototype.hasOwnProperty.call(incoming, "extractedSections")
            ? incoming.extractedSections
            : base.extractedSections,
        evaluation:
          Object.prototype.hasOwnProperty.call(incoming, "evaluation")
            ? incoming.evaluation
            : base.evaluation,
      });

    default:
      return asRecord(incomingRaw);
  }
}