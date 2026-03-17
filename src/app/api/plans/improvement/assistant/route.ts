// src/app/api/plans/improvement/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { extractJsonSafe } from "@/lib/llm/extractJson";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

export const runtime = "nodejs";

type ImprovementInitiative = {
  id: string;
  title: string;
  description: string;
  linkedRoot: string | null; // causa crítica (Pareto) o raíz (Ishikawa)
  linkedObjective: string | null; // objetivo específico
  measurement: {
    indicator: string | null; // puede ser cualitativo
    kpi: string | null; // opcional
    target: string | null; // opcional
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

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  improvementState: z.record(z.string(), z.unknown()),
  caseContext: z.record(z.string(), z.unknown()).optional(),
  recentHistory: z.string().optional(),
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
  step: z.enum(["discover", "build", "refine", "review"]),
  focus: z.object({
    chosenRoot: z.string().nullable(),
    chosenObjective: z.string().nullable(),
  }),
  initiatives: z.array(ImprovementInitiativeSchema),
  lastSummary: z.string().nullable(),
});

const ImprovementAssistantResponseSchema = z.object({
  assistantMessage: z.string().min(1),
  updates: z.object({
    nextState: ImprovementStateSchema,
    action: z.enum([
      "init",
      "add_initiative",
      "refine_initiative",
      "ask_clarify",
      "summarize",
      "redirect",
      "ready_to_validate",
    ]),
  }),
});


function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function asNullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function asNullableWeeks(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  if (num > 52) return null;

  return num;
}

function normalizeImprovementAssistantResponse(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;

  const root = input as Record<string, unknown>;
  const updates =
    root.updates && typeof root.updates === "object"
      ? (root.updates as Record<string, unknown>)
      : null;

  const nextState =
    updates?.nextState && typeof updates.nextState === "object"
      ? (updates.nextState as Record<string, unknown>)
      : null;

  const initiativesRaw = Array.isArray(nextState?.initiatives) ? nextState.initiatives : [];

  const initiatives = initiativesRaw.map((item) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const measurement =
      row.measurement && typeof row.measurement === "object"
        ? (row.measurement as Record<string, unknown>)
        : {};
    const feasibility =
      row.feasibility && typeof row.feasibility === "object"
        ? (row.feasibility as Record<string, unknown>)
        : {};

    return {
      id: String(row.id ?? "").trim(),
      title: String(row.title ?? "").trim(),
      description: String(row.description ?? "").trim(),
      linkedRoot: asNullableString(row.linkedRoot),
      linkedObjective: asNullableString(row.linkedObjective),
      measurement: {
        indicator: asNullableString(measurement.indicator),
        kpi: asNullableString(measurement.kpi),
        target: asNullableString(measurement.target),
      },
      feasibility: {
        estimatedWeeks: asNullableWeeks(feasibility.estimatedWeeks),
        notes: asNullableString(feasibility.notes),
      },
    };
  });

  return {
    ...root,
    assistantMessage: String(root.assistantMessage ?? "").trim(),
    updates: updates
      ? {
          ...updates,
          nextState: nextState
            ? {
                ...nextState,
                stageIntroDone: Boolean(nextState.stageIntroDone),
                step: String(nextState.step ?? "").trim(),
                focus:
                  nextState.focus && typeof nextState.focus === "object"
                    ? {
                        chosenRoot: asNullableString(
                          (nextState.focus as Record<string, unknown>).chosenRoot
                        ),
                        chosenObjective: asNullableString(
                          (nextState.focus as Record<string, unknown>).chosenObjective
                        ),
                      }
                    : {
                        chosenRoot: null,
                        chosenObjective: null,
                      },
                initiatives,
                lastSummary: asNullableString(nextState.lastSummary),
              }
            : nextState,
        }
      : root.updates,
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

    const { chatId, studentMessage, improvementState, caseContext, recentHistory } = parsed.data;

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "No se pudo leer el perfil del estudiante." },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const PERIOD_KEY = getPeriodKeyLaPaz();

    // 1) Leer Pareto final validado (Etapa 5) para causas críticas oficiales
    const paretoResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 5,
      artifactType: "pareto_final",
      periodKey: PERIOD_KEY,
    });

    if (!paretoResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Pareto final (Etapa 5).",
          detail: paretoResult.error,
        },
        { status: 500 }
      );
    }

    const paretoFinal = paretoResult.row;
    const paretoPayload = (paretoFinal?.payload ?? {}) as { criticalRoots?: unknown };
    const criticalRoots = asStringArray(paretoPayload.criticalRoots);

    if (criticalRoots.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message:
            "Para iniciar Etapa 7 necesitas Pareto final validado con causas críticas (top 20%).",
        },
        { status: 400 }
      );
    }

    // 2) Leer Objectives final validado (Etapa 6)
    const objectivesResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 6,
      artifactType: "objectives_final",
      periodKey: PERIOD_KEY,
    });

    if (!objectivesResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Objectives final (Etapa 6).",
          detail: objectivesResult.error,
        },
        { status: 500 }
      );
    }

    const objectivesFinal = objectivesResult.row;
    const objectivesPayload = (objectivesFinal?.payload ?? {}) as {
      generalObjective?: unknown;
      specificObjectives?: unknown;
      linkedCriticalRoots?: unknown;
    };

    const generalObjective = String(objectivesPayload.generalObjective ?? "").trim();
    const specificObjectives = asStringArray(objectivesPayload.specificObjectives);
    const linkedCriticalRoots = asStringArray(objectivesPayload.linkedCriticalRoots);

    if (!generalObjective || specificObjectives.length < 1 || linkedCriticalRoots.length < 1) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 7 necesitas Objetivos (Etapa 6) validados.",
        },
        { status: 400 }
      );
    }

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos.
Estás guiando la **Etapa 7: Plan de Mejora**.
FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa".

OBJETIVO DE LA ETAPA 7:
- Construir un Plan de Mejora coherente y ejecutable en ~4 a 6 semanas (1 a 1.5 meses).
- Debe responder a: Causas críticas (Pareto) -> Objetivos (Etapa 6) -> Acciones/iniciativas.
- Conversación FLUIDA (tipo docente), NO formulario.

REGLAS:
- NO uses opciones tipo “A/B”. Interpreta lo que el estudiante escribe y responde como un docente asesor.
- Si el estudiante ya tiene una idea, ayúdalo a pulirla y a vincularla a una causa crítica y a un objetivo específico.
- Si no tiene idea o duda, propón 1-2 ideas de alto impacto, pero solo si son realmente viables en el tiempo de práctica.
- Evalúa siempre si la propuesta ataca la causa o solo el síntoma. Si ataca solo el síntoma, corrígelo con claridad.
- Si la propuesta del estudiante es demasiado grande, costosa o poco ejecutable para el tiempo disponible, dilo explícitamente y recorta el alcance.
- Prioriza mejoras tipo piloto ejecutable, estandarización operativa, control simple, seguimiento mínimo y ajuste práctico.
- Evita soluciones triviales tipo “solo checklist”. Una iniciativa debe ser un pequeño paquete (2-4 componentes) como:
  - estandarizar (SOP/método),
  - control simple (registro/seguimiento),
  - micro-capacitación puntual,
  - piloto y ajuste.
- KPI NO es obligatorio. Si no hay KPI, usa indicador o criterio cualitativo y enseña cómo medirlo si el estudiante pregunta.
- Haz preguntas cortas y concretas (1 o 2 máximo por turno).
- Mantén tono breve, humano y útil.
- No des por cerrada la etapa solo porque ya exista un borrador coherente.
- Si ya hay un plan suficientemente armado, primero resume lo construido, explica por qué esa mejora sí conviene y pide confirmación antes de cerrar Etapa 7.

CAUSAS CRÍTICAS (Pareto Etapa 5, top 20%):
${JSON.stringify(criticalRoots, null, 2)}

OBJETIVOS VALIDADOS (Etapa 6):
- Objetivo General: ${JSON.stringify(generalObjective)}
- Objetivos Específicos: ${JSON.stringify(specificObjectives, null, 2)}
- Causas críticas vinculadas oficialmente: ${JSON.stringify(linkedCriticalRoots, null, 2)}

CONTEXTO DEL CASO (si existe):
${JSON.stringify(caseContext ?? {}, null, 2)}

ESTADO ACTUAL (Etapa 7):
${JSON.stringify(improvementState, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

- Devuelve SOLO JSON crudo.
- NO envuelvas el JSON entre comillas, NO uses markdown, NO uses bloques \`\`\`json.

DEVUELVE SOLO JSON con este formato:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "stageIntroDone": boolean,
      "step": "discover" | "build" | "refine" | "review",
      "focus": { "chosenRoot": string | null, "chosenObjective": string | null },
      "initiatives": [
        {
          "id": "string",
          "title": "string",
          "description": "string",
          "linkedRoot": "string | null",
          "linkedObjective": "string | null",
          "measurement": { "indicator": "string | null", "kpi": "string | null", "target": "string | null" },
          "feasibility": { "estimatedWeeks": number | null, "notes": "string | null" }
        }
      ],
      "lastSummary": "string | null"
    },
    "action": "init" | "add_initiative" | "refine_initiative" | "ask_clarify" | "summarize" | "redirect" | "ready_to_validate"
  }
}

CRITERIOS INTERNOS (sin decirlos como lista al estudiante):
- Vincular cada iniciativa a una causa crítica y a un objetivo específico siempre que sea posible.
- Favorecer 1 o 2 iniciativas bien ejecutables antes que muchas iniciativas débiles.
- Penalizar ideas demasiado grandes para el tiempo de práctica.
- Si hay varias opciones, prioriza la que tenga mejor trazabilidad con causas críticas, objetivos y viabilidad operativa.
- Si una idea es atractiva pero poco ejecutable, explícalo y propone una versión mínima viable.
- Mantener viabilidad total aproximada de 4 a 6 semanas.
- Al final, cuando haya un plan coherente, ofrecer cerrar Etapa 7 y pasar a Etapa 8 (Planificación).
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsedJson = extractJsonSafe(text);

    if (!parsedJson) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "LLM no devolvió JSON válido", raw: text },
        { status: 500 }
      );
    }

    const normalizedJson = normalizeImprovementAssistantResponse(parsedJson);
    const responseParse = ImprovementAssistantResponseSchema.safeParse(normalizedJson);

    if (!responseParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM devolvió JSON, pero no con la estructura esperada en Etapa 7.",
          detail: responseParse.error.flatten(),
          raw: text,
        },
        { status: 500 }
      );
    }

    const responseData = responseParse.data;
    responseData.assistantMessage = sanitizeStudentPlaceholder(
      responseData.assistantMessage,
      preferredFirstName
    );

    return NextResponse.json({ ok: true, data: responseData }, { status: 200 });
  } catch (e: unknown) {
    const err = e as { message?: string };
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
