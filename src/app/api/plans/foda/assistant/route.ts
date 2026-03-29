// src/app/api/plans/foda/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { extractJsonSafe } from "@/lib/llm/extractJson";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

export const runtime = "nodejs";

const FodaQuadrantSchema = z.enum(["F", "D", "O", "A"]);
type FodaQuadrant = z.infer<typeof FodaQuadrantSchema>;

const FodaItemSchema = z.object({
  text: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(1200).optional(),
});

const FodaStateSchema = z.object({
  currentQuadrant: FodaQuadrantSchema,
  items: z.object({
    F: z.array(FodaItemSchema),
    D: z.array(FodaItemSchema),
    O: z.array(FodaItemSchema),
    A: z.array(FodaItemSchema),
  }),
  pendingEvidence: z
    .object({
      quadrant: FodaQuadrantSchema,
      index: z.number().int().min(0).max(20),
    })
    .nullable()
    .optional(),
});

type FodaState = z.infer<typeof FodaStateSchema>;

const BodySchema = z.object({
  studentMessage: z.string().trim().min(1).max(4000),
  fodaState: FodaStateSchema,
  caseContext: z.unknown().optional(),
  recentHistory: z.string().max(12000).optional(),
});

const AssistantActionSchema = z.enum([
  "add_item",
  "ask_clarify",
  "ask_evidence",
  "add_evidence",
  "reject_generic",
  "advance_quadrant",
  "complete",
]);

const AssistantResponseSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(4000),
  updates: z.object({
    nextState: FodaStateSchema,
    action: AssistantActionSchema,
  }),
});

const IntentNameSchema = z.enum([
  "propose_item",
  "provide_supporting_evidence",
  "ask_rephrase_help",
  "ask_process_help",
  "continue_or_confirm",
  "unclear_or_other",
]);

const IntentResponseSchema = z.object({
  intent: IntentNameSchema,
  needsStateMutation: z.boolean(),
  candidateText: z.string().trim().max(700).nullable().optional(),
  userFacingResponse: z.string().trim().min(1).max(2000),
});

type IntentResponse = z.infer<typeof IntentResponseSchema>;

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function getNextQuadrant(q: FodaQuadrant): FodaQuadrant | null {
  if (q === "F") return "D";
  if (q === "D") return "O";
  if (q === "O") return "A";
  return null;
}

function cloneState(state: FodaState): FodaState {
  return {
    currentQuadrant: state.currentQuadrant,
    items: {
      F: [...state.items.F],
      D: [...state.items.D],
      O: [...state.items.O],
      A: [...state.items.A],
    },
    pendingEvidence: state.pendingEvidence ?? null,
  };
}

function sanitizeStateLoose(input: unknown, fallback: FodaState): FodaState {
  const parsed = FodaStateSchema.safeParse(input);
  if (!parsed.success) return cloneState(fallback);

  return {
    currentQuadrant: parsed.data.currentQuadrant,
    items: {
      F: parsed.data.items.F.map((item) => ({
        text: item.text.trim(),
        ...(item.evidence ? { evidence: item.evidence.trim() } : {}),
      })),
      D: parsed.data.items.D.map((item) => ({
        text: item.text.trim(),
        ...(item.evidence ? { evidence: item.evidence.trim() } : {}),
      })),
      O: parsed.data.items.O.map((item) => ({
        text: item.text.trim(),
        ...(item.evidence ? { evidence: item.evidence.trim() } : {}),
      })),
      A: parsed.data.items.A.map((item) => ({
        text: item.text.trim(),
        ...(item.evidence ? { evidence: item.evidence.trim() } : {}),
      })),
    },
    pendingEvidence: parsed.data.pendingEvidence ?? null,
  };
}

function isCompleteState(state: FodaState) {
  return (
    state.items.F.length >= 3 &&
    state.items.D.length >= 3 &&
    state.items.O.length >= 3 &&
    state.items.A.length >= 3 &&
    !state.pendingEvidence
  );
}

function enforceServerState(prev: FodaState, candidate: FodaState, action: z.infer<typeof AssistantActionSchema>) {
  const lockedQuadrant = prev.currentQuadrant;
  const safeNext = cloneState(prev);

  // Nunca permitimos que el LLM reescriba cuadrantes anteriores o ajenos
  safeNext.items.F = lockedQuadrant === "F" ? candidate.items.F : prev.items.F;
  safeNext.items.D = lockedQuadrant === "D" ? candidate.items.D : prev.items.D;
  safeNext.items.O = lockedQuadrant === "O" ? candidate.items.O : prev.items.O;
  safeNext.items.A = lockedQuadrant === "A" ? candidate.items.A : prev.items.A;

  // Si había evidencia pendiente, NO permitimos cambiar de cuadrante
  if (prev.pendingEvidence) {
    safeNext.currentQuadrant = prev.currentQuadrant;

    const pending = candidate.pendingEvidence ?? null;
    if (
      pending &&
      pending.quadrant === prev.pendingEvidence.quadrant &&
      pending.index === prev.pendingEvidence.index
    ) {
      safeNext.pendingEvidence = pending;
    } else {
      safeNext.pendingEvidence = null;
    }

    return {
      action,
      nextState: safeNext,
    };
  }

  // Si no había evidencia pendiente, solo aceptamos pendingEvidence válido del cuadrante actual
  if (
    candidate.pendingEvidence &&
    candidate.pendingEvidence.quadrant === lockedQuadrant &&
    candidate.pendingEvidence.index >= 0 &&
    candidate.pendingEvidence.index < safeNext.items[lockedQuadrant].length
  ) {
    safeNext.pendingEvidence = candidate.pendingEvidence;
  } else {
    safeNext.pendingEvidence = null;
  }

  // Por defecto NO cambiamos de cuadrante
  safeNext.currentQuadrant = lockedQuadrant;

  const currentCount = safeNext.items[lockedQuadrant].length;
  const canAdvance = currentCount >= 3 && !safeNext.pendingEvidence;
  const nextQuadrant = getNextQuadrant(lockedQuadrant);

  if (isCompleteState(safeNext)) {
    return {
      action: "complete" as const,
      nextState: safeNext,
    };
  }

  if (action === "advance_quadrant" && canAdvance && nextQuadrant) {
    safeNext.currentQuadrant = nextQuadrant;
    safeNext.pendingEvidence = null;

    return {
      action: "advance_quadrant" as const,
      nextState: safeNext,
    };
  }

  return {
    action,
    nextState: safeNext,
  };
}

function buildQuadrantLabel(q: FodaQuadrant) {
  if (q === "F") return "Fortalezas";
  if (q === "D") return "Debilidades";
  if (q === "O") return "Oportunidades";
  return "Amenazas";
}

function buildStateSummary(state: FodaState) {
  return {
    currentQuadrant: state.currentQuadrant,
    currentQuadrantLabel: buildQuadrantLabel(state.currentQuadrant),
    counts: {
      F: state.items.F.length,
      D: state.items.D.length,
      O: state.items.O.length,
      A: state.items.A.length,
    },
    currentQuadrantItems: state.items[state.currentQuadrant],
    pendingEvidence: state.pendingEvidence ?? null,
  };
}

function buildQuadrantNoun(q: FodaQuadrant) {
  if (q === "F") return "fortaleza";
  if (q === "D") return "debilidad";
  if (q === "O") return "oportunidad";
  return "amenaza";
}

function buildEmergencyFallbackMessage(state: FodaState) {
  const label = buildQuadrantLabel(state.currentQuadrant);
  const noun = buildQuadrantNoun(state.currentQuadrant);
  const count = state.items[state.currentQuadrant].length;

  if (state.pendingEvidence) {
    return `Seguimos en **${label}**. Antes de registrar un nuevo punto, necesito que completes la evidencia pendiente del ítem actual para que quede bien sustentado.`;
  }

  return `Seguimos en **${label}**. Puedes contarme una ${noun} concreta de la empresa o del proceso y yo te ayudo a reformularla para que quede técnica y útil en el FODA. Ya llevas **${count}** punto(s) en este cuadrante.`;
}

function buildStableNoMutationResult(state: FodaState, assistantMessage: string) {
  return {
    assistantMessage,
    updates: {
      action: "ask_clarify" as const,
      nextState: cloneState(state),
    },
  };
}

function buildIntentPrompt(params: {
  preferredFirstName: string | null;
  currentQuadrant: FodaQuadrant;
  stateSummary: ReturnType<typeof buildStateSummary>;
  recentHistory: string;
  caseContext: unknown;
  studentMessage: string;
}) {
  const {
    preferredFirstName,
    currentQuadrant,
    stateSummary,
    recentHistory,
    caseContext,
    studentMessage,
  } = params;

  return `
Eres un docente de Ingeniería Industrial que está guiando al estudiante en la Etapa 2 (FODA).

Tu tarea en ESTA PRIMERA FASE no es modificar el estado todavía.
Tu tarea es interpretar la intención real del estudiante y proponer una respuesta natural.

DATOS DEL ESTUDIANTE:
- Nombre de referencia: ${preferredFirstName || "estudiante"}

CUADRANTE ACTUAL:
- ${currentQuadrant} (${buildQuadrantLabel(currentQuadrant)})

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

CONVERSACIÓN RECIENTE:
${recentHistory || "No hay historial reciente."}

RESUMEN DEL ESTADO ACTUAL:
${JSON.stringify(stateSummary, null, 2)}

MENSAJE ACTUAL DEL ESTUDIANTE:
${studentMessage}

Debes clasificar la intención en UNA de estas categorías:
- "propose_item": el estudiante está proponiendo un ítem o una idea que podría convertirse en un punto del FODA.
- "provide_supporting_evidence": el estudiante está dando evidencia, ejemplo o sustento para un punto ya mencionado.
- "ask_rephrase_help": el estudiante pide reformular, mejorar redacción o convertir su idea en algo más técnico.
- "ask_process_help": el estudiante pregunta cómo seguir, qué poner, qué corresponde ahora o tiene dudas del proceso.
- "continue_or_confirm": el estudiante solo confirma que quiere seguir, continuar o avanzar conversacionalmente.
- "unclear_or_other": el mensaje no alcanza para mutar estado o es ambiguo / fuera de foco.

REGLAS:
- No cambies de cuadrante.
- No confundas un problema de formato con un problema de comprensión.
- Si el estudiante escribe de forma breve o natural, interpreta su intención igual.
- "needsStateMutation" debe ser true SOLO si el mensaje realmente trae contenido que puede cambiar el estado del FODA.
- "candidateText" debe contener únicamente el posible texto útil del estudiante si aplica; si no aplica, devuelve null.
- "userFacingResponse" debe ser una respuesta natural, fluida y útil, en español, coherente con el cuadrante actual.

Devuelve ÚNICAMENTE un JSON válido con esta estructura:
{
  "intent": "propose_item" | "provide_supporting_evidence" | "ask_rephrase_help" | "ask_process_help" | "continue_or_confirm" | "unclear_or_other",
  "needsStateMutation": true,
  "candidateText": "texto candidato o null",
  "userFacingResponse": "respuesta natural para el estudiante"
}
`;
}

function buildMutationPrompt(params: {
  preferredFirstName: string | null;
  currentQuadrant: FodaQuadrant;
  fodaState: FodaState;
  stateSummary: ReturnType<typeof buildStateSummary>;
  recentHistory: string;
  caseContext: unknown;
  studentMessage: string;
  interpreted: IntentResponse;
}) {
  const {
    preferredFirstName,
    currentQuadrant,
    fodaState,
    stateSummary,
    recentHistory,
    caseContext,
    studentMessage,
    interpreted,
  } = params;

  return `
Eres un docente de Ingeniería Industrial que guía al estudiante en la construcción técnica de una matriz FODA.

Esta es la SEGUNDA FASE.
La intención del estudiante ya fue interpretada previamente.

DATOS DEL ESTUDIANTE:
- Nombre de referencia: ${preferredFirstName || "estudiante"}

CUADRANTE ACTUAL:
- ${currentQuadrant} (${buildQuadrantLabel(currentQuadrant)})

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

CONVERSACIÓN RECIENTE:
${recentHistory || "No hay historial reciente."}

RESUMEN DEL ESTADO ACTUAL:
${JSON.stringify(stateSummary, null, 2)}

ESTADO COMPLETO DEL FODA:
${JSON.stringify(fodaState, null, 2)}

MENSAJE ORIGINAL DEL ESTUDIANTE:
${studentMessage}

INTERPRETACIÓN PREVIA:
${JSON.stringify(interpreted, null, 2)}

REGLAS CRÍTICAS:
- Trabaja SOLAMENTE sobre el cuadrante actual (${currentQuadrant} - ${buildQuadrantLabel(currentQuadrant)}).
- NO cambies a otro cuadrante aunque el mensaje sea ambiguo.
- Si el texto aún es muy vago, no registres basura: pide precisión.
- Si existe pendingEvidence, prioriza cerrar esa evidencia antes de registrar otro ítem.
- En Oportunidades y Amenazas exige sustento externo cuando falte.
- No inventes datos cuantitativos.
- No alteres ítems de otros cuadrantes.
- Cada cuadrante requiere 3 ítems de calidad.
- Si el cuadrante actual ya llegó a 3 ítems y no hay pendingEvidence, puedes devolver action = "advance_quadrant".
- Si todos los cuadrantes ya están completos y no hay pendingEvidence, devuelve action = "complete".
- Debes responder en español.

Devuelve ÚNICAMENTE un JSON válido con esta estructura exacta:
{
  "assistantMessage": "respuesta natural para el estudiante",
  "updates": {
    "nextState": {
      "currentQuadrant": "F | D | O | A",
      "items": {
        "F": [],
        "D": [],
        "O": [],
        "A": []
      },
      "pendingEvidence": null
    },
    "action": "add_item" | "ask_clarify" | "ask_evidence" | "add_evidence" | "reject_generic" | "advance_quadrant" | "complete"
  }
}
`;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return fail(403, gate.reason, gate.message);
    }

    const rawBody = await req.json().catch(() => null);
    const parsedBody = BodySchema.safeParse(rawBody);

    if (!parsedBody.success) {
      return fail(
        400,
        "BAD_REQUEST",
        parsedBody.error.issues[0]?.message ?? "Body inválido.",
        parsedBody.error.flatten()
      );
    }

    const {
      studentMessage,
      fodaState,
      caseContext = {},
      recentHistory = "",
    } = parsedBody.data;

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return fail(500, "INTERNAL", "No se pudo leer el perfil del estudiante.", profileError);
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

        const currentQuadrant = fodaState.currentQuadrant;
    const stateSummary = buildStateSummary(fodaState);
    const model = getGeminiModel();

    // -----------------------------
    // FASE 1: interpretar intención
    // -----------------------------
    const intentPrompt = buildIntentPrompt({
      preferredFirstName,
      currentQuadrant,
      stateSummary,
      recentHistory,
      caseContext,
      studentMessage,
    });

    const intentResult = await model.generateContent(intentPrompt);
    const intentRawText = intentResult.response.text();
    const intentExtracted = extractJsonSafe(intentRawText);

    const parsedIntent = IntentResponseSchema.safeParse(intentExtracted);

    if (!parsedIntent.success) {
      const fallback = buildStableNoMutationResult(
        fodaState,
        sanitizeStudentPlaceholder(
          buildEmergencyFallbackMessage(fodaState),
          preferredFirstName
        )
      );

      return NextResponse.json(
        {
          ok: true,
          data: fallback,
          meta: {
            fallback: true,
            phase: "interpret",
            reason: "INTENT_INVALID",
          },
        },
        { status: 200 }
      );
    }

    const interpreted = parsedIntent.data;

    // Si la intención no requiere mutar estado, respondemos natural y mantenemos el estado intacto
    if (!interpreted.needsStateMutation || !interpreted.candidateText?.trim()) {
      const stable = buildStableNoMutationResult(
        fodaState,
        sanitizeStudentPlaceholder(interpreted.userFacingResponse, preferredFirstName)
      );

      return NextResponse.json(
        {
          ok: true,
          data: stable,
          meta: {
            fallback: false,
            phase: "interpret_only",
            intent: interpreted.intent,
          },
        },
        { status: 200 }
      );
    }

    // -----------------------------
    // FASE 2: mutar estado
    // -----------------------------
    const mutationPrompt = buildMutationPrompt({
      preferredFirstName,
      currentQuadrant,
      fodaState,
      stateSummary,
      recentHistory,
      caseContext,
      studentMessage,
      interpreted,
    });

    const mutationResult = await model.generateContent(mutationPrompt);
    const mutationRawText = mutationResult.response.text();
    const mutationExtracted = extractJsonSafe(mutationRawText);

    if (!mutationExtracted) {
      const stable = buildStableNoMutationResult(
        fodaState,
        sanitizeStudentPlaceholder(interpreted.userFacingResponse, preferredFirstName)
      );

      return NextResponse.json(
        {
          ok: true,
          data: stable,
          meta: {
            fallback: true,
            phase: "mutation",
            reason: "LLM_INVALID_JSON",
            intent: interpreted.intent,
          },
        },
        { status: 200 }
      );
    }

    const parsedResponse = AssistantResponseSchema.safeParse(mutationExtracted);
    if (!parsedResponse.success) {
      const stable = buildStableNoMutationResult(
        fodaState,
        sanitizeStudentPlaceholder(interpreted.userFacingResponse, preferredFirstName)
      );

      return NextResponse.json(
        {
          ok: true,
          data: stable,
          meta: {
            fallback: true,
            phase: "mutation",
            reason: "LLM_INVALID_SHAPE",
            intent: interpreted.intent,
          },
        },
        { status: 200 }
      );
    }

    const rawNextState = sanitizeStateLoose(
      parsedResponse.data.updates.nextState,
      fodaState
    );

    const enforced = enforceServerState(
      fodaState,
      rawNextState,
      parsedResponse.data.updates.action
    );

    const assistantMessage = sanitizeStudentPlaceholder(
      parsedResponse.data.assistantMessage,
      preferredFirstName
    );

    return NextResponse.json(
      {
        ok: true,
        data: {
          assistantMessage,
          updates: {
            action: enforced.action,
            nextState: enforced.nextState,
          },
        },
        meta: {
          fallback: false,
          phase: "mutation",
          intent: interpreted.intent,
        },
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error en FODA assistant";

    if (message === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (message === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN", "Acceso restringido.");
    }

    return fail(500, "INTERNAL", "Error interno.", message);
  }
}