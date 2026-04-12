// src/app/api/plans/improvement/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { failResponse } from "@/lib/api/response";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
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

const ImprovementDecisionSchema = z.object({
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

const ImprovementReadinessSchema = z.object({
  isReady: z.boolean(),
  missingItems: z.array(z.string()),
  summary: z.string(),
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
  decision: ImprovementDecisionSchema.optional(),
  readiness: ImprovementReadinessSchema.optional(),
});

type ImprovementDecision = z.infer<typeof ImprovementDecisionSchema>;
type ImprovementReadiness = z.infer<typeof ImprovementReadinessSchema>;

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

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function buildImprovementReadiness(
  state: ImprovementState,
  specificObjectives: string[],
  linkedCriticalRoots: string[]
): ImprovementReadiness {
  const missingItems: string[] = [];

  if (state.initiatives.length < 2) {
    missingItems.push("Define al menos 2 iniciativas concretas y ejecutables.");
  }

  const specificSet = new Set(specificObjectives);
  const linkedRootsSet = new Set(linkedCriticalRoots);

  const invalidObjectiveLinks = state.initiatives.filter(
    (initiative) =>
      initiative.linkedObjective &&
      !specificSet.has(initiative.linkedObjective)
  );

  const missingObjectiveLinks = state.initiatives.filter(
    (initiative) => !initiative.linkedObjective
  );

  const missingMeasurement = state.initiatives.filter(
    (initiative) =>
      !initiative.measurement.indicator?.trim() &&
      !initiative.measurement.kpi?.trim()
  );

  const missingTitle = state.initiatives.filter(
    (initiative) => initiative.title.trim().length < 6
  );

  if (missingTitle.length > 0) {
    missingItems.push("Al menos una iniciativa todavía necesita un título claro.");
  }

  if (missingObjectiveLinks.length > 0) {
    missingItems.push("Cada iniciativa debe vincularse a un objetivo específico validado.");
  }

  if (invalidObjectiveLinks.length > 0) {
    missingItems.push("Hay iniciativas vinculadas a objetivos que no coinciden con la Etapa 6.");
  }

  if (missingMeasurement.length > 0) {
    missingItems.push("Cada iniciativa debe tener al menos un indicador o KPI simple.");
  }

  const coveredRoots = new Set(
    state.initiatives
      .map((initiative) => initiative.linkedRoot)
      .filter((root): root is string => !!root && linkedRootsSet.has(root))
  );

  const missingCoverage = linkedCriticalRoots.filter((root) => !coveredRoots.has(root));
  if (missingCoverage.length > 0) {
    missingItems.push(
      `Aún falta cubrir estas causas críticas: ${missingCoverage.join("; ")}.`
    );
  }

  const weeks = state.initiatives
    .map((initiative) => initiative.feasibility.estimatedWeeks)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const totalWeeks = weeks.length > 0 ? weeks.reduce((acc, value) => acc + value, 0) : null;
  if (totalWeeks !== null && totalWeeks > 7) {
    missingItems.push(
      `El alcance actual parece demasiado largo (${totalWeeks} semanas aprox.). Ajusta a ~4 a 6 semanas.`
    );
  }

  return {
    isReady: missingItems.length === 0,
    missingItems,
    summary:
      missingItems.length === 0
        ? "El plan ya está suficientemente armado para validación."
        : `Todavía faltan ${missingItems.length} ajuste(s) antes de cerrar la etapa.`,
  };
}

function buildImprovementReadinessMessage(
  readiness: ImprovementReadiness
) {
  if (readiness.isReady) {
    return (
      "Tu **Plan de Mejora** ya está lo bastante sólido para cerrar la etapa.\n\n" +
      "Si estás de acuerdo, en este turno lo tomo como confirmación de cierre y pasamos a la **Etapa 8: Planificación**."
    );
  }

  return (
    "Todavía no conviene cerrar la **Etapa 7**.\n\n" +
    readiness.missingItems.map((item) => `- ${item}`).join("\n") +
    "\n\nDime cuál de esos puntos quieres ajustar primero y lo trabajamos juntos."
  );
}

async function generateImprovementIntent(prompt: string) {
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

async function generateImprovementJson(prompt: string) {
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
      "step": "discover" | "build" | "refine" | "review",
      "focus": {
        "chosenRoot": "string | null",
        "chosenObjective": "string | null"
      },
      "initiatives": [
        {
          "id": "string",
          "title": "string",
          "description": "string",
          "linkedRoot": "string | null",
          "linkedObjective": "string | null",
          "measurement": {
            "indicator": "string | null",
            "kpi": "string | null",
            "target": "string | null"
          },
          "feasibility": {
            "estimatedWeeks": "number | null",
            "notes": "string | null"
          }
        }
      ],
      "lastSummary": "string | null"
    },
    "action": "init" | "add_initiative" | "refine_initiative" | "ask_clarify" | "summarize" | "redirect" | "ready_to_validate"
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

    const { chatId, studentMessage, improvementState, caseContext, recentHistory } = parsed.data;

    const stateParse = ImprovementStateSchema.safeParse(improvementState);
    if (!stateParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "improvementState inválido.",
          detail: stateParse.error.flatten(),
        },
        { status: 400 }
      );
    }

    const currentImprovementState = stateParse.data;

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

    const currentReadiness = buildImprovementReadiness(
      currentImprovementState,
      specificObjectives,
      linkedCriticalRoots
    );

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

    const intentPrompt = `
    Eres un docente asesor de Ingeniería Industrial.

    Tu tarea primero NO es reescribir el plan.
    Tu tarea primero es interpretar qué quiso hacer el estudiante en este turno de la Etapa 7.

    Clasifica la intención del mensaje en una de estas opciones:
    - "mutate_state": el estudiante está proponiendo, corrigiendo o ajustando contenido real del plan.
    - "check_readiness": el estudiante quiere saber si ya está bien, qué falta o cómo va.
    - "confirm_close": el estudiante da a entender que quiere cerrar, avanzar o pasar de etapa.
    - "guide_next": el estudiante quiere continuar guiado, aunque no necesariamente cerrar.
    - "clarify": el mensaje es ambiguo y necesitas pedir una aclaración breve.

    REGLAS:
    - No te bases en una sola palabra exacta. Interpreta el sentido completo.
    - Si el estudiante expresa conformidad, cierre, avance o pregunta si ya está listo, normalmente eso es "confirm_close" o "check_readiness".
    - Si pregunta "qué falta", "cómo vamos", "ya está bien", "con esto basta", eso es "check_readiness".
    - Si añade o corrige iniciativas, medición, vinculación, alcance o factibilidad, eso es "mutate_state".
    - Si el mensaje es corto pero claramente busca continuar la conversación, puedes usar "guide_next".

    Devuelve SOLO JSON:
    {
      "intent": "mutate_state" | "check_readiness" | "confirm_close" | "guide_next" | "clarify",
      "shouldMutateState": boolean,
      "shouldValidateNow": boolean,
      "userFacingResponse": "string | null"
    }

    CONTEXTO:
    - Estado actual Etapa 7:
    ${JSON.stringify(currentImprovementState, null, 2)}

    - Resumen de readiness:
    ${JSON.stringify(currentReadiness, null, 2)}

    - Historial reciente:
    ${String(recentHistory ?? "")}

    - Mensaje del estudiante:
    "${studentMessage}"
    `;

    const intentResult = await generateImprovementIntent(intentPrompt);

    const fallbackDecision: ImprovementDecision = {
      intent: "guide_next",
      shouldMutateState: true,
      shouldValidateNow: false,
      userFacingResponse: null,
    };

    const intentParse = ImprovementDecisionSchema.safeParse(intentResult.json);
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
        decision.userFacingResponse?.trim() || buildImprovementReadinessMessage(currentReadiness),
        preferredFirstName
      );

      return NextResponse.json(
        {
          ok: true,
          data: {
            assistantMessage,
            updates: {
              nextState: currentImprovementState,
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

FORMATO DEL MENSAJE:
- Escribe en párrafos cortos y claros.
- Separa ideas distintas con una línea en blanco.
- Evita bloques largos de texto continuo.
- Usa viñetas o numeración solo cuando realmente ayuden a ordenar pasos, semanas, ajustes, criterios, causas o elementos pendientes.
- No conviertas todo en lista; si basta con 1 o 2 párrafos, responde así.
- Si haces una pregunta final, colócala en un párrafo aparte.
- Puedes usar un emoji discreto solo cuando aporte cercanía o claridad, no en todos los mensajes.
- El mensaje debe verse bien en chat: legible, espaciado y fácil de seguir.

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
${JSON.stringify(currentImprovementState, null, 2)}

RESUMEN DE PREPARACIÓN ACTUAL:
${JSON.stringify(currentReadiness, null, 2)}

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

    const llmResult = await generateImprovementJson(prompt);

    if (!llmResult.json) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM no devolvió JSON válido",
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const normalizedJson = normalizeImprovementAssistantResponse(llmResult.json);
    const responseParse = ImprovementAssistantResponseSchema.safeParse(normalizedJson);

    if (!responseParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM devolvió JSON, pero no con la estructura esperada en Etapa 7.",
          detail: responseParse.error.flatten(),
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const responseData = responseParse.data;
    const nextReadiness = buildImprovementReadiness(
      responseData.updates.nextState,
      specificObjectives,
      linkedCriticalRoots
    );

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
