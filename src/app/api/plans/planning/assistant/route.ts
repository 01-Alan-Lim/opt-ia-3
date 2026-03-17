// src/app/api/plans/planning/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
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
});

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

    const gate = await assertChatAccess(req);
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

    responseData.assistantMessage = sanitizeStudentPlaceholder(
      responseData.assistantMessage,
      preferredFirstName
    );

    return NextResponse.json({ ok: true, data: responseData }, { status: 200 });
  } catch (error: unknown) {
    const err = error as { message?: string };
    const msg = err?.message ?? "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(
        { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." },
        { status: 401 }
      );
    }

    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN_DOMAIN", message: "Dominio no permitido." },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { ok: false, code: "INTERNAL", message: "Error interno.", detail: msg },
      { status: 500 }
    );
  }
}