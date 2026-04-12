// src/app/api/plans/planning/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { failResponse } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

export const runtime = "nodejs";

const STAGE = 8;
const PERIOD_KEY = getPeriodKeyLaPaz();

const PlanningMilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  week: z.number().int().positive().nullable(),
  deliverable: z.string().nullable(),
});

const PlanningWeekItemSchema = z.object({
  week: z.number().int().positive(),
  focus: z.string().min(1),
  tasks: z.array(z.string().min(1)).default([]),
  evidence: z.string().nullable(),
  measurement: z.string().nullable(),
});

const PlanningStateSchema = z.object({
  stageIntroDone: z.boolean(),
  step: z.enum(["time_window", "breakdown", "schedule", "review"]),
  time: z.object({
    studentWeeks: z.number().int().positive().nullable(),
    courseCutoffDate: z.string().nullable(),
    effectiveWeeks: z.number().int().positive().nullable(),
    notes: z.string().nullable(),
  }),
  plan: z.object({
    weekly: z.array(PlanningWeekItemSchema).default([]),
    milestones: z.array(PlanningMilestoneSchema).default([]),
    risks: z.array(z.string().min(1)).default([]),
  }),
  lastSummary: z.string().nullable(),
});

type PlanningState = z.infer<typeof PlanningStateSchema>;

const PlanningDecisionSchema = z.object({
  intent: z.enum([
    "mutate_state",
    "check_readiness",
    "confirm_close",
    "guide_next",
    "clarify",
  ]),
  shouldMutateState: z.boolean(),
  shouldValidateNow: z.boolean(),
  userFacingResponse: z.string().trim().min(1).max(3000).nullable().optional(),
});

const PlanningReadinessSchema = z.object({
  isReady: z.boolean(),
  missingItems: z.array(z.string()),
  summary: z.string(),
});

const PlanningAssistantResponseSchema = z.object({
  assistantMessage: z.string().min(1),
  updates: z.object({
    nextState: PlanningStateSchema,
    action: z.enum([
      "init",
      "ask_time",
      "propose_schedule",
      "refine_schedule",
      "summarize",
      "ready_to_validate",
    ]),
  }),
  decision: PlanningDecisionSchema.optional(),
  readiness: PlanningReadinessSchema.optional(),
});

type PlanningDecision = z.infer<typeof PlanningDecisionSchema>;
type PlanningReadiness = z.infer<typeof PlanningReadinessSchema>;

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  planningState: z.record(z.string(), z.unknown()),
  caseContext: z.record(z.string(), z.unknown()).optional(),
  recentHistory: z.string().optional(),
});

function extractJsonSafe(text: string): unknown | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  return null;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCourseCutoffDate(ctx: Record<string, unknown> | undefined): string | null {
  const value = ctx?.courseCutoffDate;
  const parsed = asString(value);
  return parsed || null;
}

function normalizePlanningState(input: PlanningState): PlanningState {
  const weekly = [...input.plan.weekly]
    .map((item) => ({
      ...item,
      tasks: item.tasks.filter((task) => task.trim().length > 0),
      focus: item.focus.trim(),
      evidence: item.evidence?.trim() || null,
      measurement: item.measurement?.trim() || null,
    }))
    .filter((item) => item.focus.length > 0)
    .sort((a, b) => a.week - b.week);

  const milestones = input.plan.milestones.map((item) => ({
    ...item,
    id: item.id.trim(),
    title: item.title.trim(),
    deliverable: item.deliverable?.trim() || null,
  }));

  const risks = input.plan.risks
    .map((risk) => risk.trim())
    .filter((risk) => risk.length > 0);

  return {
    ...input,
    time: {
      ...input.time,
      notes: input.time.notes?.trim() || null,
    },
    plan: {
      weekly,
      milestones,
      risks,
    },
    lastSummary: input.lastSummary?.trim() || null,
  };
}

function buildPlanningReadiness(state: PlanningState): PlanningReadiness {
  const missingItems: string[] = [];

  const studentWeeks = safeNumber(state.time.studentWeeks);
  const courseCutoffDate = asString(state.time.courseCutoffDate);

  if (studentWeeks === null && !courseCutoffDate) {
    missingItems.push("Define cuántas semanas quedan o una fecha de corte.");
  }

  if (courseCutoffDate && !/^\d{4}-\d{2}-\d{2}/.test(courseCutoffDate)) {
    missingItems.push("La fecha de corte debe tener formato YYYY-MM-DD.");
  }

  if (state.plan.weekly.length < 1) {
    missingItems.push("Falta definir al menos una semana con actividades.");
  }

  if (state.plan.milestones.length < 2) {
    missingItems.push("Define al menos 2 hitos claros para el cronograma.");
  }

  const hasMeasurement = state.plan.weekly.some((week) => {
    return Boolean(asString(week.measurement));
  });

  if (!hasMeasurement) {
    missingItems.push("Incluye al menos un punto de medición o seguimiento.");
  }

  return {
    isReady: missingItems.length === 0,
    missingItems,
    summary:
      missingItems.length === 0
        ? "La planificación ya está lista para validación."
        : `Todavía faltan ${missingItems.length} ajuste(s) antes de cerrar la etapa.`,
  };
}

function buildPlanningReadinessMessage(readiness: PlanningReadiness) {
  if (readiness.isReady) {
    return (
      "Tu **Planificación** ya quedó suficientemente consistente para cerrar la etapa.\n\n" +
      "Si estás de acuerdo, en este turno lo tomo como confirmación y pasamos a la **Etapa 9**."
    );
  }

  return (
    "Todavía no conviene cerrar la **Etapa 8**.\n\n" +
    readiness.missingItems.map((item) => `- ${item}`).join("\n") +
    "\n\nDime qué punto quieres completar primero y lo ajustamos."
  );
}

async function generatePlanningIntent(prompt: string) {
  const model = getGeminiModel();

  const first = await model.generateContent(prompt);
  const firstText = first.response.text();
  const firstJson = extractJsonSafe(firstText);

  if (firstJson) {
    return { json: firstJson, raw: firstText };
  }

  const repairPrompt = `
Convierte la siguiente respuesta a JSON válido, sin agregar explicaciones.

Debes devolver SOLO JSON crudo con este formato exacto:
{
  "intent": "mutate_state" | "check_readiness" | "confirm_close" | "guide_next" | "clarify",
  "shouldMutateState": boolean,
  "shouldValidateNow": boolean,
  "userFacingResponse": "string | null"
}

RESPUESTA ORIGINAL A CONVERTIR:
${firstText}
`;

  const repaired = await model.generateContent(repairPrompt);
  const repairedText = repaired.response.text();
  const repairedJson = extractJsonSafe(repairedText);

  return {
    json: repairedJson,
    raw: firstText,
    repairedRaw: repairedText,
  };
}


async function generatePlanningJson(prompt: string) {
  const model = getGeminiModel();

  const first = await model.generateContent(prompt);
  const firstText = first.response.text();
  const firstJson = extractJsonSafe(firstText);

  if (firstJson) {
    return { json: firstJson, raw: firstText };
  }

  const repairPrompt = `
Convierte la siguiente respuesta a JSON válido, sin agregar explicaciones.

Debes devolver SOLO JSON crudo con este formato exacto:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "stageIntroDone": boolean,
      "step": "time_window" | "breakdown" | "schedule" | "review",
      "time": {
        "studentWeeks": number | null,
        "courseCutoffDate": "string | null",
        "effectiveWeeks": number | null,
        "notes": "string | null"
      },
      "plan": {
        "weekly": [
          {
            "week": number,
            "focus": "string",
            "tasks": ["string"],
            "evidence": "string | null",
            "measurement": "string | null"
          }
        ],
        "milestones": [
          {
            "id": "string",
            "title": "string",
            "week": number | null,
            "deliverable": "string | null"
          }
        ],
        "risks": ["string"]
      },
      "lastSummary": "string | null"
    },
    "action": "init" | "ask_time" | "propose_schedule" | "refine_schedule" | "summarize" | "ready_to_validate"
  }
}

RESPUESTA ORIGINAL A CONVERTIR:
${firstText}
`;

  const repaired = await model.generateContent(repairPrompt);
  const repairedText = repaired.response.text();
  const repairedJson = extractJsonSafe(repairedText);

  return {
    json: repairedJson,
    raw: firstText,
    repairedRaw: repairedText,
  };
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return NextResponse.json(
        { ok: false, code: gate.reason, message: gate.message },
        { status: 403 }
      );
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Body inválido.",
        },
        { status: 400 }
      );
    }

    const { chatId, studentMessage, planningState, caseContext, recentHistory } = parsed.data;

    const planningStateParse = PlanningStateSchema.safeParse(planningState);
    if (!planningStateParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "planningState inválido.",
          detail: planningStateParse.error.flatten(),
        },
        { status: 400 }
      );
    }

    const currentPlanningState = planningStateParse.data;
    const currentReadiness = buildPlanningReadiness(currentPlanningState);

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "No se pudo leer el perfil del estudiante.",
        },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const improvementResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 7,
      artifactType: "improvement_final",
      periodKey: PERIOD_KEY,
    });

    if (!improvementResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Plan de Mejora final (Etapa 7).",
          detail: improvementResult.error,
        },
        { status: 500 }
      );
    }

    const improvementFinal = improvementResult.row;

    if (!improvementFinal?.payload) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 8 necesitas Etapa 7 (Plan de Mejora) validada.",
        },
        { status: 400 }
      );
    }

    const improvementPayload = improvementFinal.payload as Record<string, unknown>;
    const initiativesRaw = improvementPayload?.initiatives;
    const initiatives = Array.isArray(initiativesRaw) ? initiativesRaw : [];

    if (initiatives.length < 1) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "El Plan de Mejora (Etapa 7) no tiene iniciativas.",
        },
        { status: 400 }
      );
    }

    const courseCutoffDate = parseCourseCutoffDate(caseContext);

    const intentPrompt = `
    Eres un docente asesor de Ingeniería Industrial.

    Tu tarea primero NO es reescribir el cronograma.
    Tu tarea primero es interpretar qué quiso hacer el estudiante en este turno de la Etapa 8.

    Clasifica el mensaje en una de estas opciones:
    - "mutate_state": está ajustando cronograma, semanas, hitos, riesgos o medición.
    - "check_readiness": quiere saber si ya está bien o qué falta.
    - "confirm_close": quiere cerrar, pasar o continuar a la siguiente etapa.
    - "guide_next": quiere seguir guiado sin cerrar todavía.
    - "clarify": el mensaje es ambiguo.

    REGLAS:
    - Interpreta el sentido, no una palabra aislada.
    - Si el estudiante pregunta si ya está listo, qué falta o cómo va, eso es "check_readiness".
    - Si da a entender que quiere avanzar o cerrar, eso es "confirm_close".
    - Si agrega semanas, tareas, hitos o cambios al cronograma, eso es "mutate_state".
    - Si escribe algo breve pero claramente quiere continuar, eso es "guide_next".

    Devuelve SOLO JSON:
    {
      "intent": "mutate_state" | "check_readiness" | "confirm_close" | "guide_next" | "clarify",
      "shouldMutateState": boolean,
      "shouldValidateNow": boolean,
      "userFacingResponse": "string | null"
    }

    CONTEXTO:
    - Estado actual Etapa 8:
    ${JSON.stringify(currentPlanningState, null, 2)}

    - Resumen de readiness:
    ${JSON.stringify(currentReadiness, null, 2)}

    - Historial reciente:
    ${String(recentHistory ?? "")}

    - Mensaje del estudiante:
    "${studentMessage}"
    `;

    const intentResult = await generatePlanningIntent(intentPrompt);

    const fallbackDecision: PlanningDecision = {
      intent: "guide_next",
      shouldMutateState: true,
      shouldValidateNow: false,
      userFacingResponse: null,
    };

    const intentParse = PlanningDecisionSchema.safeParse(intentResult.json);
    const decision = intentParse.success ? intentParse.data : fallbackDecision;

    if (
      decision.intent === "check_readiness" ||
      decision.intent === "confirm_close" ||
      decision.intent === "clarify" ||
      !decision.shouldMutateState
    ) {
      const shouldValidateNow =
        currentReadiness.isReady &&
        (decision.intent === "confirm_close" || decision.shouldValidateNow === true);

      const assistantMessage = sanitizeStudentPlaceholder(
        decision.userFacingResponse?.trim() || buildPlanningReadinessMessage(currentReadiness),
        preferredFirstName
      );

      return NextResponse.json(
        {
          ok: true,
          data: {
            assistantMessage,
            updates: {
              nextState: currentPlanningState,
              action: shouldValidateNow ? "ready_to_validate" : "summarize",
            },
            decision: {
              ...decision,
              shouldValidateNow,
            },
            readiness: currentReadiness,
          },
        },
        { status: 200 }
      );
    }

    const prompt = `
Eres un DOCENTE asesor de Ingeniería Industrial. Estás guiando la Etapa 8: Planificación.

FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No reveles nombres reales de empresas o personas. Si aparecen, reemplázalos por "la empresa".

FORMATO DEL MENSAJE:
- Escribe en párrafos cortos y claros.
- Separa ideas distintas con una línea en blanco.
- Evita bloques largos de texto continuo.
- Usa viñetas o numeración solo cuando ayuden a ordenar semanas, tareas, responsables, recursos, riesgos o elementos pendientes.
- No conviertas todo en lista.
- Si haces una pregunta final, colócala en un párrafo aparte.
- El mensaje debe verse legible en chat.

OBJETIVO:
- Convertir el Plan de Mejora validado en un cronograma realista por semanas.
- Ajustar alcance si el tiempo es corto.
- Mantener una conversación fluida.
- Máximo 1 o 2 preguntas por turno.

REGLAS:
- Si el estudiante escribe algo corto como "continuemos", "cómo avanzamos", "sigamos" o parecido, no lo bloquees.
- En ese caso, retoma la etapa según el estado actual y guía el siguiente paso útil.
- Si faltan semanas o ventana de tiempo, pide solo ese dato.
- Si el tiempo real es corto, recorta alcance y prioriza piloto + medición mínima + ajuste básico.
- No intentes meter todo si no cabe.
- Construye secuencia lógica: preparar -> implementar/pilotear -> medir -> ajustar/cerrar.
- Cada iniciativa debe quedar con actividades base, hito(s) y medición mínima.
- No cierres automáticamente la etapa solo porque el cronograma parezca razonable.
- Si el cronograma ya está bastante completo, resume lo acordado y pide confirmación antes de dejar la etapa lista para validación.

DATOS DISPONIBLES:
- Corte del curso: ${JSON.stringify(courseCutoffDate)}
- Plan de Mejora validado (Etapa 7):
${JSON.stringify(
  {
    generalObjective: improvementPayload.generalObjective ?? null,
    linkedCriticalRoots: improvementPayload.linkedCriticalRoots ?? null,
    initiatives: initiatives.map((initiative) => {
      const item =
        typeof initiative === "object" && initiative !== null
          ? (initiative as Record<string, unknown>)
          : {};

      return {
        title: item.title ?? null,
        description: item.description ?? null,
        linkedObjective: item.linkedObjective ?? null,
        linkedRoot: item.linkedRoot ?? null,
        measurement: item.measurement ?? null,
        feasibility: item.feasibility ?? null,
      };
    }),
  },
  null,
  2
)}

ESTADO ACTUAL (Etapa 8):
${JSON.stringify(currentPlanningState, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

IMPORTANTE:
- Devuelve SOLO JSON crudo.
- NO uses markdown.
- NO uses bloques \`\`\`.
- NO agregues texto antes ni después del JSON.
- NO expliques que vas a responder en JSON.

DEVUELVE SOLO JSON con este formato exacto:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "stageIntroDone": boolean,
      "step": "time_window" | "breakdown" | "schedule" | "review",
      "time": {
        "studentWeeks": number | null,
        "courseCutoffDate": string | null,
        "effectiveWeeks": number | null,
        "notes": string | null
      },
      "plan": {
        "weekly": [
          {
            "week": number,
            "focus": "string",
            "tasks": ["string"],
            "evidence": "string | null",
            "measurement": "string | null"
          }
        ],
        "milestones": [
          {
            "id": "string",
            "title": "string",
            "week": number | null,
            "deliverable": "string | null"
          }
        ],
        "risks": ["string"]
      },
      "lastSummary": "string | null"
    },
    "action": "init" | "ask_time" | "propose_schedule" | "refine_schedule" | "summarize" | "ready_to_validate"
  }
}
`;

    const llmResult = await generatePlanningJson(prompt);

    if (!llmResult.json) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM no devolvió JSON válido.",
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const responseParse = PlanningAssistantResponseSchema.safeParse(llmResult.json);
    if (!responseParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "El assistant devolvió JSON, pero no con la estructura esperada en Etapa 8.",
          detail: responseParse.error.flatten(),
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const responseData = responseParse.data;

    if (courseCutoffDate) {
      responseData.updates.nextState.time.courseCutoffDate = courseCutoffDate;
    }

    responseData.updates.nextState = normalizePlanningState(responseData.updates.nextState);

    const nextReadiness = buildPlanningReadiness(responseData.updates.nextState);

    responseData.assistantMessage = sanitizeStudentPlaceholder(
      responseData.assistantMessage,
      preferredFirstName
    );

    responseData.decision = {
      intent: "mutate_state",
      shouldMutateState: true,
      shouldValidateNow:
        responseData.updates.action === "ready_to_validate" && nextReadiness.isReady,
      userFacingResponse: null,
    };

    responseData.readiness = nextReadiness;

    return NextResponse.json({ ok: true, data: responseData }, { status: 200 });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    if (err instanceof z.ZodError) {
      return failResponse(
        "BAD_REQUEST",
        err.issues[0]?.message ?? "Payload inválido.",
        400,
        err.flatten()
      );
    }

    return failResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "Error interno.",
      500
    );
  }
}