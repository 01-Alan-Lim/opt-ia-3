// src/lib/teacher/dashboard/aggregate.ts
//
// Agregación pura del panel docente nativo (GET /api/teacher/dashboard): recibe las filas ya
// leídas de UNA cohorte y arma el resumen, los totales por etapa y el avance de cada
// estudiante. Sin React, Supabase ni fetch.
//
// Reglas:
// - E0 está cerrada si el contexto del caso del estudiante está en "confirmed".
// - E1-E10 están cerradas si existe su artefacto final (FINAL_ARTIFACT_BY_STAGE) con status
//   "validated", en CUALQUIER mes: period_key no se mira. resolveActivePlanStage sí filtra por
//   el mes actual y por eso perdería avances de meses anteriores.
// - plan_stage_states NO cierra etapas: solo dice en qué etapa se guardó estado por última vez.
// - La nota de una etapa es la última evaluación de su artefacto final; sin evaluación es null.
// - Sin registros de horas el total es null, no 0: son horas declaradas, no verificadas.
// - Las filas de usuarios que no están en la cohorte se ignoran.

import {
  FINAL_ARTIFACT_BY_STAGE,
  FINAL_DOC_VERSION_ARTIFACT_TYPES,
  type PlanStageNumber,
} from "@/lib/plan/stageArtifacts";
import type {
  DashboardArtifactRow,
  DashboardCaseContextRow,
  DashboardCohortRow,
  DashboardEvaluationRow,
  DashboardHoursRow,
  DashboardStateRow,
  DashboardStudentRow,
  DashboardUsageRow,
} from "./rows";

export const DASHBOARD_STAGES: readonly PlanStageNumber[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export type DashboardStageKey = `e${PlanStageNumber}`;

export type StageProgress = {
  stage: PlanStageNumber;
  completed: boolean;
  // E1-E10: created_at más antiguo de su artefacto final validado. E0: siempre null, porque
  // plan_case_contexts no guarda cuándo se confirmó.
  validatedAt: string | null;
  score: number | null;
  scoreLabel: string | null;
};

export type DashboardStudent = {
  userId: string;
  ru: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  registrationStatus: string | null;
  progress: StageProgress[];
  completedStages: number;
  // Etapa cerrada más alta (0-10). No implica que las anteriores estén cerradas: E1 se puede
  // saltar (allowSkipProductivity en el chat).
  lastValidatedStage: PlanStageNumber | null;
  // Etapa del plan_stage_states guardado más reciente: dónde estaba trabajando, no lo cerrado.
  activeStateStage: number | null;
  activeStateUpdatedAt: string | null;
  hours: { entries: number; total: number | null };
  // v_student_usage: mensajes del estudiante en todos sus chats (asesor y general).
  activity: { messagesSent: number | null; lastMessageAt: string | null };
  finalDocument: { latestVersion: 1 | 2 | null; closed: boolean };
};

export type TeacherDashboard = {
  cohort: {
    id: string;
    name: string;
    isActive: boolean;
    createdAt: string;
    accessStartsAt: string | null;
    accessEndsAt: string | null;
  };
  summary: {
    totalStudents: number;
    approved: number;
    pending: number;
    rejected: number;
    // registration_status null o con otro valor.
    otherStatus: number;
    contextConfirmed: number;
    planClosed: number;
    studentsWithHours: number;
    totalHours: number | null;
  };
  stageTotals: Record<DashboardStageKey, number>;
  students: DashboardStudent[];
};

export type TeacherDashboardInput = {
  cohort: DashboardCohortRow;
  students: DashboardStudentRow[];
  caseContexts: DashboardCaseContextRow[];
  artifacts: DashboardArtifactRow[];
  states: DashboardStateRow[];
  evaluations: DashboardEvaluationRow[];
  hours: DashboardHoursRow[];
  usage: DashboardUsageRow[];
};

const CONTEXT_CONFIRMED = "confirmed";
const ARTIFACT_VALIDATED = "validated";

// Etapa a la que cierra cada artefacto final (inverso de FINAL_ARTIFACT_BY_STAGE).
const STAGE_BY_FINAL_ARTIFACT: ReadonlyMap<string, number> = new Map(
  [...FINAL_ARTIFACT_BY_STAGE].map(([stage, artifactType]) => [artifactType, stage] as const)
);

// profiles.user_id es text y otras tablas lo guardan como uuid: se comparan normalizados.
export function normalizeUserId(id: string): string {
  return id.trim().toLowerCase();
}

function toFiniteNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function timeOf(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function groupByUser<T extends { user_id: string | null }>(
  rows: T[],
  members: ReadonlySet<string>
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    if (row.user_id === null) continue;
    const id = normalizeUserId(row.user_id);
    if (!members.has(id)) continue;
    const list = out.get(id);
    if (list) list.push(row);
    else out.set(id, [row]);
  }
  return out;
}

function latestBy<T>(rows: T[], at: (row: T) => string): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || timeOf(at(row)) > timeOf(at(best))) best = row;
  }
  return best;
}

function buildStudent(
  profile: DashboardStudentRow,
  rows: {
    contexts: DashboardCaseContextRow[];
    artifacts: DashboardArtifactRow[];
    states: DashboardStateRow[];
    evaluations: DashboardEvaluationRow[];
    hours: DashboardHoursRow[];
    usage: DashboardUsageRow[];
  }
): DashboardStudent {
  const contextConfirmed = rows.contexts.some((row) => row.status === CONTEXT_CONFIRMED);

  // Primera validación de cada etapa E1-E10, sin importar el mes.
  const validatedAt = new Map<number, string>();
  for (const row of rows.artifacts) {
    if (row.status !== ARTIFACT_VALIDATED) continue;
    const stage = STAGE_BY_FINAL_ARTIFACT.get(row.artifact_type);
    if (stage === undefined || row.stage !== stage) continue;
    const current = validatedAt.get(stage);
    if (current === undefined || timeOf(row.created_at) < timeOf(current)) {
      validatedAt.set(stage, row.created_at);
    }
  }

  const progress: StageProgress[] = DASHBOARD_STAGES.map((stage) => {
    if (stage === 0) {
      return { stage, completed: contextConfirmed, validatedAt: null, score: null, scoreLabel: null };
    }

    const finalArtifact = FINAL_ARTIFACT_BY_STAGE.get(stage);
    const evaluation = latestBy(
      rows.evaluations.filter((row) => row.stage === stage && row.artifact_type === finalArtifact),
      (row) => row.created_at
    );
    const at = validatedAt.get(stage) ?? null;

    return {
      stage,
      completed: at !== null,
      validatedAt: at,
      score: evaluation ? toFiniteNumber(evaluation.total_score) : null,
      scoreLabel: evaluation ? evaluation.total_label : null,
    };
  });

  const completed = progress.filter((item) => item.completed);
  const lastValidatedStage = completed.length ? completed[completed.length - 1].stage : null;

  const latestState = latestBy(rows.states, (row) => row.updated_at);

  let hoursTotal = 0;
  for (const row of rows.hours) hoursTotal += toFiniteNumber(row.hours) ?? 0;

  const usage = rows.usage[0] ?? null;

  const stage10Types = new Set(
    rows.artifacts.filter((row) => row.stage === 10).map((row) => row.artifact_type)
  );
  const latestVersion = stage10Types.has(FINAL_DOC_VERSION_ARTIFACT_TYPES[2])
    ? 2
    : stage10Types.has(FINAL_DOC_VERSION_ARTIFACT_TYPES[1])
    ? 1
    : null;

  return {
    userId: profile.user_id,
    ru: profile.ru,
    firstName: profile.first_name,
    lastName: profile.last_name,
    email: profile.email,
    registrationStatus: profile.registration_status,
    progress,
    completedStages: completed.length,
    lastValidatedStage,
    activeStateStage: latestState ? latestState.stage : null,
    activeStateUpdatedAt: latestState ? latestState.updated_at : null,
    hours: {
      entries: rows.hours.length,
      total: rows.hours.length ? roundHours(hoursTotal) : null,
    },
    activity: {
      messagesSent: usage ? toFiniteNumber(usage.messages_user) : null,
      lastMessageAt: usage ? usage.last_message_at : null,
    },
    finalDocument: {
      latestVersion,
      closed: progress[10].completed,
    },
  };
}

function compareStudents(a: DashboardStudent, b: DashboardStudent): number {
  const keys: Array<(s: DashboardStudent) => string> = [
    (s) => s.lastName ?? "",
    (s) => s.firstName ?? "",
    (s) => s.email ?? "",
    (s) => s.userId,
  ];
  for (const key of keys) {
    const diff = key(a).localeCompare(key(b), "es", { sensitivity: "base" });
    if (diff !== 0) return diff;
  }
  return 0;
}

export function buildTeacherDashboard(input: TeacherDashboardInput): TeacherDashboard {
  // Un perfil por usuario (el primero si llegara repetido).
  const profiles = new Map<string, DashboardStudentRow>();
  for (const row of input.students) {
    const id = normalizeUserId(row.user_id);
    if (!profiles.has(id)) profiles.set(id, row);
  }
  const members: ReadonlySet<string> = new Set(profiles.keys());

  const contexts = groupByUser(input.caseContexts, members);
  const artifacts = groupByUser(input.artifacts, members);
  const states = groupByUser(input.states, members);
  const evaluations = groupByUser(input.evaluations, members);
  const hours = groupByUser(input.hours, members);
  const usage = groupByUser(input.usage, members);

  const students = [...profiles].map(([id, profile]) =>
    buildStudent(profile, {
      contexts: contexts.get(id) ?? [],
      artifacts: artifacts.get(id) ?? [],
      states: states.get(id) ?? [],
      evaluations: evaluations.get(id) ?? [],
      hours: hours.get(id) ?? [],
      usage: usage.get(id) ?? [],
    })
  );
  students.sort(compareStudents);

  const stageTotals = Object.fromEntries(
    DASHBOARD_STAGES.map((stage) => [
      `e${stage}`,
      students.filter((student) => student.progress[stage].completed).length,
    ])
  ) as Record<DashboardStageKey, number>;

  const withHours = students.filter((student) => student.hours.total !== null);
  const countStatus = (status: string) =>
    students.filter((student) => student.registrationStatus === status).length;
  const approved = countStatus("approved");
  const pending = countStatus("pending");
  const rejected = countStatus("rejected");

  return {
    cohort: {
      id: input.cohort.id,
      name: input.cohort.name,
      isActive: input.cohort.is_active,
      createdAt: input.cohort.created_at,
      accessStartsAt: input.cohort.access_starts_at,
      accessEndsAt: input.cohort.access_ends_at,
    },
    summary: {
      totalStudents: students.length,
      approved,
      pending,
      rejected,
      otherStatus: students.length - approved - pending - rejected,
      contextConfirmed: stageTotals.e0,
      planClosed: stageTotals.e10,
      studentsWithHours: withHours.length,
      totalHours: withHours.length
        ? roundHours(withHours.reduce((sum, student) => sum + (student.hours.total ?? 0), 0))
        : null,
    },
    stageTotals,
    students,
  };
}
