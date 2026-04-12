// src/app/api/plans/foda/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
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

const QualityVerdictSchema = z.enum(["valid", "weak", "invalid"]);

const QualityAssessmentSchema = z.object({
  verdict: QualityVerdictSchema,
  score: z.number().int().min(0).max(100),
  isSpecific: z.boolean(),
  isRelevantToQuadrant: z.boolean(),
  needsEvidence: z.boolean(),
  missingElements: z.array(z.string().trim().min(1).max(160)).max(4),
  improvedVersion: z.string().trim().min(1).max(500).nullable(),
  explanationForStudent: z.string().trim().min(1).max(1600),
});

type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

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

function normalizeLooseText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingConnector(text: string) {
  return text
    .trim()
    .replace(
      /^(ok|okay|bueno|bien|perfecto|listo|sí|si|claro|de acuerdo|entiendo|entendido|entonces)\s*,?\s*/i,
      ""
    )
    .trim();
}

function extractCandidateFromStudentMessage(text: string, quadrant: FodaQuadrant) {
  const cleaned = stripLeadingConnector(text);

  const patternsByQuadrant: Record<FodaQuadrant, RegExp[]> = {
    F: [
      /(?:una|otra)\s+fortaleza\s+(?:es|seria|sería)\s*[:\-]?\s*(.+)$/i,
      /fortaleza\s*[:\-]?\s*(.+)$/i,
    ],
    D: [
      /(?:una|otra)\s+debilidad\s+(?:es|seria|sería)\s*[:\-]?\s*(.+)$/i,
      /debilidad\s*[:\-]?\s*(.+)$/i,
    ],
    O: [
      /(?:una|otra)\s+oportunidad\s+(?:es|seria|sería)\s*[:\-]?\s*(.+)$/i,
      /oportunidad\s*[:\-]?\s*(.+)$/i,
    ],
    A: [
      /(?:una|otra)\s+amenaza\s+(?:es|seria|sería)\s*[:\-]?\s*(.+)$/i,
      /amenaza\s*[:\-]?\s*(.+)$/i,
    ],
  };

  for (const pattern of patternsByQuadrant[quadrant]) {
    const match = cleaned.match(pattern);
    if (match?.[1]?.trim()) {
      return normalizeItemText(match[1]);
    }
  }

  return normalizeItemText(cleaned);
}

function looksLikeConcreteFodaItem(text: string, quadrant: FodaQuadrant) {
  const normalized = normalizeLooseText(text);
  const noun = buildQuadrantNoun(quadrant);

  if (normalized.length < 12) return false;

  if (
    normalized.includes(`${noun} es`) ||
    normalized.includes(`${noun} seria`) ||
    normalized.includes(`${noun} sería`) ||
    normalized.includes(`otra ${noun}`) ||
    normalized.includes(`una ${noun}`)
  ) {
    return true;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount >= 6;
}

function canAdvanceCurrentQuadrant(state: FodaState) {
  return state.items[state.currentQuadrant].length >= 3 && !state.pendingEvidence;
}

function detectQuadrantMention(text: string): FodaQuadrant | null {
  const t = normalizeLooseText(text);

  if (t.includes("fortaleza") || t.includes("fortalezas")) return "F";
  if (t.includes("debilidad") || t.includes("debilidades")) return "D";
  if (t.includes("oportunidad") || t.includes("oportunidades")) return "O";
  if (t.includes("amenaza") || t.includes("amenazas")) return "A";

  return null;
}

function detectAdvanceIntent(text: string) {
  const t = normalizeLooseText(text);

  return (
    t.includes("pasemos") ||
    t.includes("pasar") ||
    t.includes("continuemos") ||
    t.includes("continuar") ||
    t.includes("avancemos") ||
    t.includes("avanzar") ||
    t.includes("siguiente") ||
    t.includes("otro cuadrante") ||
    t.includes("cambiar de cuadrante") ||
    t.includes("vamos con") ||
    t.includes("sigamos con")
  );
}

function getSuggestedNextQuadrant(state: FodaState): FodaQuadrant | null {
  const order: FodaQuadrant[] = ["F", "D", "O", "A"];
  const currentIndex = order.indexOf(state.currentQuadrant);

  for (let offset = 1; offset < order.length; offset += 1) {
    const q = order[(currentIndex + offset) % order.length];
    if (state.items[q].length < 3) return q;
  }

  return null;
}

function normalizeCompletedQuadrantState(state: FodaState): FodaState {
  if (state.pendingEvidence) return cloneState(state);

  const currentCount = state.items[state.currentQuadrant].length;
  if (currentCount < 3) return cloneState(state);

  const nextQuadrant = getSuggestedNextQuadrant(state);
  if (!nextQuadrant || nextQuadrant === state.currentQuadrant) {
    return cloneState(state);
  }

  return {
    ...cloneState(state),
    currentQuadrant: nextQuadrant,
    pendingEvidence: null,
  };
}

function buildQuadrantAdvanceMessage(
  from: FodaQuadrant,
  to: FodaQuadrant,
  baseAnalysis?: string
) {
  const fromLabel = buildQuadrantLabel(from);
  const toLabel = buildQuadrantLabel(to);
  const toNoun = buildQuadrantNoun(to);

  const analysis = (baseAnalysis ?? "").trim();
  const intro = analysis ? `${analysis}\n\n` : "";

  return (
    `${intro}` +
    `✅ Con esto ya completamos el cuadrante de **${fromLabel}** ` +
    `(mínimo 3 puntos).\n\n` +
    `Ahora pasamos a **${toLabel}**.\n\n` +
    `Cuéntame una ${toNoun} concreta de la empresa, del proceso o del entorno y yo te ayudo a redactarla técnicamente.`
  );
}

function buildQuadrantCompletedMessage(state: FodaState, baseAnalysis?: string) {
  const current = state.currentQuadrant;
  const label = buildQuadrantLabel(current);
  const next = getSuggestedNextQuadrant(state);

  const analysis = (baseAnalysis ?? "").trim();

  if (!next) {
    return (
      `✅ Con esto ya completamos el cuadrante de **${label}** ` +
      `(mínimo 3 puntos).\n\n` +
      `Ya tienes los **4 cuadrantes completos**. Continuamos con la validación final del FODA.`
    );
  }

  const intro = analysis ? `${analysis}\n\n` : "";

  return (
    `${intro}` +
    `✅ Con esto ya completamos el cuadrante de **${label}** ` +
    `(mínimo 3 puntos).\n\n` +
    `Si deseas, ahora podemos pasar a **${buildQuadrantLabel(next)}**.`
  );
}

function resolveDeterministicQuadrantAdvance(
  state: FodaState,
  studentMessage: string
): { action: "advance_quadrant" | "complete"; nextState: FodaState; assistantMessage: string } | null {
  if (!canAdvanceCurrentQuadrant(state)) return null;

  const wantsAdvance = detectAdvanceIntent(studentMessage);
  const mentionedQuadrant = detectQuadrantMention(studentMessage);

  if (!wantsAdvance && !mentionedQuadrant) return null;

  if (isCompleteState(state)) {
    return {
      action: "complete",
      nextState: cloneState(state),
      assistantMessage:
        "✅ El FODA ya está completo en sus 4 cuadrantes. Ahora corresponde validarlo para pasar a la siguiente etapa.",
    };
  }

  const targetQuadrant =
    mentionedQuadrant && mentionedQuadrant !== state.currentQuadrant
      ? mentionedQuadrant
      : getSuggestedNextQuadrant(state);

  if (!targetQuadrant || targetQuadrant === state.currentQuadrant) {
    return null;
  }

  const nextState = cloneState(state);
  nextState.currentQuadrant = targetQuadrant;
  nextState.pendingEvidence = null;

  return {
    action: "advance_quadrant",
    nextState,
    assistantMessage: buildQuadrantAdvanceMessage(state.currentQuadrant, targetQuadrant),
  };
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

function normalizeItemText(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

function hasEquivalentItem(items: Array<{ text: string }>, candidateText: string) {
  const normalizedCandidate = normalizeLooseText(candidateText);

  return items.some((item) => normalizeLooseText(item.text) === normalizedCandidate);
}

function requiresExternalEvidence(quadrant: FodaQuadrant) {
  return quadrant === "O" || quadrant === "A";
}

function buildAskEvidenceMessage(quadrant: FodaQuadrant, itemText: string) {
  const label = buildQuadrantLabel(quadrant);

  return (
    `La idea puede funcionar como punto de **${label}**, pero en este cuadrante necesito un poco de sustento externo para que no quede solo como una percepción.\n\n` +
    `Punto propuesto:\n**${itemText}**\n\n` +
    `Ayúdame con alguno de estos apoyos:\n` +
    `- un dato\n` +
    `- una fuente\n` +
    `- una tendencia observable\n` +
    `- un ejemplo real del entorno\n\n` +
    `Puede ser algo breve, pero debe ayudar a justificar por qué esto realmente es una oportunidad o una amenaza.`
  );
}

function buildPendingEvidenceReminderMessage(state: FodaState) {
  const pending = state.pendingEvidence;

  if (!pending) {
    return buildEmergencyFallbackMessage(state);
  }

  const item = state.items[pending.quadrant][pending.index];
  const label = buildQuadrantLabel(pending.quadrant);

  return (
    `Antes de registrar un nuevo punto, necesito cerrar la evidencia pendiente en **${label}**.\n\n` +
    `Punto pendiente:\n**${item?.text ?? "Ítem sin texto"}**\n\n` +
    `Envíame un dato, una fuente, una tendencia observable o un ejemplo del entorno que lo sustente.`
  );
}

function looksLikeExternalEvidence(text: string) {
  const t = normalizeLooseText(text);

  return (
    t.includes("fuente") ||
    t.includes("segun") ||
    t.includes("según") ||
    t.includes("datos de") ||
    t.includes("dato de") ||
    t.includes("informe") ||
    t.includes("reporte") ||
    t.includes("estudio") ||
    t.includes("estadistica") ||
    t.includes("estadística") ||
    t.includes("indicador") ||
    t.includes("por ciento") ||
    t.includes("%") ||
    /\b\d{1,3}(?:[.,]\d+)?\s*%/.test(text) ||
    /\b20\d{2}\b/.test(text)
  );
}

function hasMinimumSemanticContent(text: string) {
  const normalized = normalizeLooseText(text);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  return normalized.length >= 12 && wordCount >= 4;
}

function buildQualityAssessmentPrompt(params: {
  quadrant: FodaQuadrant;
  candidateText: string;
  caseContext: unknown;
  recentHistory: string;
  stateSummary: ReturnType<typeof buildStateSummary>;
}) {
  const { quadrant, candidateText, caseContext, recentHistory, stateSummary } = params;

  return `
Eres un docente experto en Ingeniería Industrial y análisis FODA.

Tu tarea es evaluar la CALIDAD de un posible ítem del cuadrante ${quadrant} (${buildQuadrantLabel(quadrant)}).

NO debes responder como chat libre.
Debes evaluar si el texto realmente sirve para un FODA académico y útil para etapas posteriores.

CRITERIOS DE EVALUACIÓN:
1. Especificidad: evita frases vagas, genéricas o superficiales.
2. Relevancia: debe corresponder al cuadrante actual.
3. Valor analítico: debe describir una condición real, observable y útil para el caso.
4. Claridad: debe entenderse qué ocurre, dónde ocurre o qué efecto produce.
5. Evidencia: en Oportunidades y Amenazas, si falta sustento externo, márcalo.

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

CONVERSACIÓN RECIENTE:
${recentHistory || "No hay historial reciente."}

RESUMEN DEL ESTADO ACTUAL:
${JSON.stringify(stateSummary, null, 2)}

CANDIDATO A EVALUAR:
${candidateText}

INSTRUCCIONES IMPORTANTES:
- "valid": el ítem ya tiene suficiente calidad para registrarse.
- "weak": la idea puede servir, pero aún está incompleta, ambigua o demasiado general.
- "invalid": no corresponde al cuadrante o no aporta valor suficiente para registrarse.
- "improvedVersion" debe conservar la idea del estudiante, pero redactada de forma más técnica y útil. Si no se puede rescatar, devuelve null.
- "missingElements" debe listar lo que falta para fortalecer el ítem.
- "explanationForStudent" debe sonar como un docente claro y natural, no robótico.
- No inventes cifras ni hechos que no estén en el caso.
- Devuelve JSON válido únicamente.

Devuelve EXACTAMENTE:
{
  "verdict": "valid" | "weak" | "invalid",
  "score": 0,
  "isSpecific": true,
  "isRelevantToQuadrant": true,
  "needsEvidence": false,
  "missingElements": ["..."],
  "improvedVersion": "..." o null,
  "explanationForStudent": "..."
}
`;
}

function buildQualityAssessmentMessage(
  quadrant: FodaQuadrant,
  candidateText: string,
  quality: QualityAssessment
) {
  const noun = buildQuadrantNoun(quadrant);
  const label = buildQuadrantLabel(quadrant);
  const improvedBlock = quality.improvedVersion
    ? `\n\nPodríamos dejarla mejor redactada así:\n**${quality.improvedVersion}**`
    : "";

  const missingBlock = quality.missingElements.length
    ? `\n\nPara que sí aporte valor en **${label}**, necesito que la precisemos un poco más. Falta, por ejemplo:\n${quality.missingElements
        .map((item) => `- ${item}`)
        .join("\n")}`
    : "";

  return (
    `${quality.explanationForStudent}\n\n` +
    `La idea base que me diste fue: "${candidateText}".` +
    improvedBlock +
    missingBlock +
    `\n\n¿Quieres que la dejemos así o prefieres ajustarla tú antes de registrarla como ${noun}?`
  );
}

function evaluateFodaItemQualityRuleBased(
  text: string,
  quadrant: FodaQuadrant
): QualityAssessment {
  const clean = normalizeItemText(text);
  const normalized = normalizeLooseText(clean);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  if (!hasMinimumSemanticContent(clean)) {
    return {
      verdict: "invalid",
      score: 20,
      isSpecific: false,
      isRelevantToQuadrant: true,
      needsEvidence: requiresExternalEvidence(quadrant),
      missingElements: ["más detalle concreto sobre la situación observada"],
      improvedVersion: null,
      explanationForStudent:
        "La idea todavía está demasiado corta o incompleta para registrarla como un punto útil del FODA.",
    };
  }

  if (wordCount < 6) {
    return {
      verdict: "weak",
      score: 45,
      isSpecific: false,
      isRelevantToQuadrant: true,
      needsEvidence: requiresExternalEvidence(quadrant),
      missingElements: [
        "qué ocurre exactamente",
        "en qué área, proceso o situación se observa",
      ],
      improvedVersion: null,
      explanationForStudent:
        "La idea podría servir, pero todavía está muy resumida y así queda ambigua.",
    };
  }

  return {
    verdict: "valid",
    score: 70,
    isSpecific: true,
    isRelevantToQuadrant: true,
    needsEvidence: false,
    missingElements: [],
    improvedVersion: clean,
    explanationForStudent:
      "La idea tiene una base suficiente para ser trabajada como ítem del FODA.",
  };
}

function buildServerQualityGate(params: {
  prevState: FodaState;
  candidateText: string | null | undefined;
  quality: QualityAssessment;
}) {
  const { prevState, candidateText, quality } = params;
  const quadrant = prevState.currentQuadrant;
  const cleanCandidate = normalizeItemText(candidateText ?? "");

  if (!cleanCandidate) {
    return null;
  }

  if (quality.verdict === "valid") {
    return null;
  }

  return {
    assistantMessage: buildQualityAssessmentMessage(quadrant, cleanCandidate, quality),
    updates: {
      action: "ask_clarify" as const,
      nextState: cloneState(prevState),
    },
    metaReason: quality.verdict === "invalid" ? "QUALITY_INVALID" : "QUALITY_WEAK",
  };
}

async function runQualityAssessment(params: {
  model: ReturnType<typeof getGeminiModel>;
  quadrant: FodaQuadrant;
  candidateText: string;
  caseContext: unknown;
  recentHistory: string;
  stateSummary: ReturnType<typeof buildStateSummary>;
}): Promise<QualityAssessment> {
  const { model, quadrant, candidateText, caseContext, recentHistory, stateSummary } = params;

  const prompt = buildQualityAssessmentPrompt({
    quadrant,
    candidateText,
    caseContext,
    recentHistory,
    stateSummary,
  });

  const result = await model.generateContent(prompt);
  const rawText = result.response.text();
  const extracted = extractJsonSafe(rawText);
  const parsed = QualityAssessmentSchema.safeParse(extracted);

  if (parsed.success) {
    return parsed.data;
  }

  return evaluateFodaItemQualityRuleBased(candidateText, quadrant);
}

function buildDeterministicAddEvidenceResult(
  state: FodaState,
  evidenceText: string,
  assistantMessage: string
) {
  const pending = state.pendingEvidence;

  if (!pending) {
    return buildStableNoMutationResult(state, assistantMessage);
  }

  const nextState = cloneState(state);
  const targetItem = nextState.items[pending.quadrant][pending.index];
  const cleanEvidence = normalizeItemText(evidenceText);

  if (!targetItem || !cleanEvidence) {
    return buildStableNoMutationResult(state, assistantMessage);
  }

  nextState.items[pending.quadrant][pending.index] = {
    ...targetItem,
    evidence: cleanEvidence,
  };

  nextState.pendingEvidence = null;

  return {
    assistantMessage,
    updates: {
      action: "add_evidence" as const,
      nextState,
    },
  };
}

function buildServerEvidenceGate(params: {
  prevState: FodaState;
  nextState: FodaState;
}) {
  const { prevState, nextState } = params;
  const quadrant = prevState.currentQuadrant;

  if (!requiresExternalEvidence(quadrant)) {
    return null;
  }

  const prevItems = prevState.items[quadrant];
  const nextItems = nextState.items[quadrant];

  if (nextItems.length <= prevItems.length) {
    return null;
  }

  const insertedIndex = nextItems.findIndex((nextItem) => {
    return !prevItems.some(
      (prevItem) =>
        normalizeLooseText(prevItem.text) === normalizeLooseText(nextItem.text)
    );
  });

  const resolvedIndex = insertedIndex >= 0 ? insertedIndex : nextItems.length - 1;
  const targetItem = nextItems[resolvedIndex];

  if (!targetItem) {
    return null;
  }

  const alreadyHasEvidence = Boolean(targetItem.evidence?.trim());
  if (alreadyHasEvidence || looksLikeExternalEvidence(targetItem.text)) {
    return null;
  }

  const gatedState = cloneState(nextState);
  gatedState.currentQuadrant = prevState.currentQuadrant;
  gatedState.pendingEvidence = {
    quadrant,
    index: resolvedIndex,
  };

  return {
    assistantMessage: buildAskEvidenceMessage(quadrant, targetItem.text),
    updates: {
      action: "ask_evidence" as const,
      nextState: gatedState,
    },
  };
}

function buildDeterministicAddItemResult(
  state: FodaState,
  candidateText: string,
  assistantMessage: string
) {
  const nextState = cloneState(state);
  const quadrant = state.currentQuadrant;
  const cleanText = normalizeItemText(candidateText);

  if (!cleanText) {
    return buildStableNoMutationResult(state, assistantMessage);
  }

  const alreadyExists = hasEquivalentItem(nextState.items[quadrant], cleanText);

  if (!alreadyExists) {
    nextState.items[quadrant] = [
      ...nextState.items[quadrant],
      { text: cleanText },
    ];
  }

  const insertedIndex = nextState.items[quadrant].findIndex(
    (item) => normalizeLooseText(item.text) === normalizeLooseText(cleanText)
  );

  if (
    requiresExternalEvidence(quadrant) &&
    insertedIndex >= 0 &&
    !looksLikeExternalEvidence(cleanText)
  ) {
    nextState.pendingEvidence = {
      quadrant,
      index: insertedIndex,
    };

    return {
      assistantMessage: buildAskEvidenceMessage(quadrant, cleanText),
      updates: {
        action: "ask_evidence" as const,
        nextState,
      },
    };
  }

  nextState.pendingEvidence = null;

  return {
    assistantMessage,
    updates: {
      action: "add_item" as const,
      nextState,
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
- "continue_or_confirm": el estudiante solo confirma que quiere seguir, continuar o avanzar conversacionalmente, PERO sin aportar un nuevo contenido sustantivo para el FODA.
- "unclear_or_other": el mensaje no alcanza para mutar estado o es ambiguo / fuera de foco.

REGLAS:
- No cambies de cuadrante.
- No confundas un problema de formato con un problema de comprensión.
- Si el estudiante menciona explícitamente una fortaleza, debilidad, oportunidad o amenaza y luego desarrolla una idea concreta, clasifícalo como "propose_item", no como "continue_or_confirm".
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

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return fail(403, "FORBIDDEN", gate.message);
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

    const deterministicAdvance = resolveDeterministicQuadrantAdvance(
      fodaState,
      studentMessage
    );

    if (deterministicAdvance) {
      return NextResponse.json(
        {
          ok: true,
          data: {
            assistantMessage: sanitizeStudentPlaceholder(
              deterministicAdvance.assistantMessage,
              null
            ),
            updates: {
              action: deterministicAdvance.action,
              nextState: deterministicAdvance.nextState,
            },
          },
          meta: {
            fallback: false,
            phase: "server_transition",
            reason: "DETERMINISTIC_QUADRANT_ADVANCE",
          },
        },
        { status: 200 }
      );
    }

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

    const heuristicCandidate = extractCandidateFromStudentMessage(
      studentMessage,
      currentQuadrant
    );

    const shouldForceProvideEvidence =
      Boolean(fodaState.pendingEvidence) &&
      (
        interpreted.intent === "provide_supporting_evidence" ||
        looksLikeExternalEvidence(studentMessage)
      );

    const shouldForceProposeItem =
      looksLikeConcreteFodaItem(studentMessage, currentQuadrant) &&
      heuristicCandidate.length >= 8;

    const interpretedNormalized: IntentResponse = shouldForceProvideEvidence
      ? {
          ...interpreted,
          intent: "provide_supporting_evidence",
          needsStateMutation: true,
          candidateText: normalizeItemText(studentMessage),
        }
      : shouldForceProposeItem
        ? {
            ...interpreted,
            intent: "propose_item",
            needsStateMutation: true,
            candidateText: heuristicCandidate,
          }
        : interpreted;

            if (
              fodaState.pendingEvidence &&
              interpretedNormalized.intent !== "provide_supporting_evidence"
            ) {
              return NextResponse.json(
                {
                  ok: true,
                  data: buildStableNoMutationResult(
                    fodaState,
                    sanitizeStudentPlaceholder(
                      buildPendingEvidenceReminderMessage(fodaState),
                      preferredFirstName
                    )
                  ),
                  meta: {
                    fallback: false,
                    phase: "server_pending_evidence_gate",
                    reason: "PENDING_EVIDENCE_MUST_BE_RESOLVED_FIRST",
                    intent: interpretedNormalized.intent,
                  },
                },
                { status: 200 }
              );
            }
      
          let qualityAssessment: QualityAssessment | null = null;

          if (
            interpretedNormalized.intent === "propose_item" &&
            interpretedNormalized.candidateText?.trim()
          ) {
            qualityAssessment = await runQualityAssessment({
              model,
              quadrant: currentQuadrant,
              candidateText: interpretedNormalized.candidateText,
              caseContext,
              recentHistory,
              stateSummary,
            });

            const qualityGate = buildServerQualityGate({
              prevState: fodaState,
              candidateText: interpretedNormalized.candidateText,
              quality: qualityAssessment,
            });

            if (qualityGate) {
              return NextResponse.json(
                {
                  ok: true,
                  data: qualityGate,
                  meta: {
                    fallback: false,
                    phase: "server_quality_gate",
                    reason: qualityGate.metaReason,
                    intent: interpretedNormalized.intent,
                    qualityScore: qualityAssessment.score,
                  },
                },
                { status: 200 }
              );
            }
          }

    // Si la intención no requiere mutar estado, respondemos natural y mantenemos el estado intacto
    if (
      !interpretedNormalized.needsStateMutation ||
      !interpretedNormalized.candidateText?.trim()
    ) {
      const stable = buildStableNoMutationResult(
        fodaState,
        sanitizeStudentPlaceholder(
          interpretedNormalized.userFacingResponse,
          preferredFirstName
        )
      );

      return NextResponse.json(
        {
          ok: true,
          data: stable,
          meta: {
            fallback: false,
            phase: "interpret_only",
            intent: interpretedNormalized.intent,
          },
        },
        { status: 200 }
      );
    }

    if (
      fodaState.pendingEvidence &&
      interpretedNormalized.intent === "provide_supporting_evidence" &&
      interpretedNormalized.candidateText?.trim()
    ) {
      const evidenceResult = buildDeterministicAddEvidenceResult(
        fodaState,
        interpretedNormalized.candidateText,
        sanitizeStudentPlaceholder(
          interpretedNormalized.userFacingResponse,
          preferredFirstName
        )
      );

      return NextResponse.json(
        {
          ok: true,
          data: evidenceResult,
          meta: {
            fallback: false,
            phase: "server_evidence_attach",
            reason: "DETERMINISTIC_ADD_EVIDENCE",
            intent: interpretedNormalized.intent,
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
      interpreted: interpretedNormalized,
    });

    const mutationResult = await model.generateContent(mutationPrompt);
    const mutationRawText = mutationResult.response.text();
    const mutationExtracted = extractJsonSafe(mutationRawText);

    if (!mutationExtracted) {
      const fallbackData =
        interpretedNormalized.intent === "propose_item" && interpretedNormalized.candidateText?.trim()
          ? buildDeterministicAddItemResult(
              fodaState,
              qualityAssessment?.improvedVersion?.trim() || interpretedNormalized.candidateText,
              sanitizeStudentPlaceholder(
                qualityAssessment?.improvedVersion
                  ? `Bien. Esta idea sí se puede registrar mejor redactada como:\n**${qualityAssessment.improvedVersion}**`
                  : interpretedNormalized.userFacingResponse,
                preferredFirstName
              )
            )
          : buildStableNoMutationResult(
              fodaState,
              sanitizeStudentPlaceholder(interpretedNormalized.userFacingResponse, preferredFirstName)
            );

      return NextResponse.json(
        {
          ok: true,
          data: fallbackData,
          meta: {
            fallback: true,
            phase: "mutation",
            reason: "LLM_INVALID_JSON",
            intent: interpretedNormalized.intent,
          },
        },
        { status: 200 }
      );
    }

    const parsedResponse = AssistantResponseSchema.safeParse(mutationExtracted);
      if (!parsedResponse.success) {
        const fallbackData =
          interpretedNormalized.intent === "propose_item" && interpretedNormalized.candidateText?.trim()
            ? buildDeterministicAddItemResult(
                fodaState,
                qualityAssessment?.improvedVersion?.trim() || interpretedNormalized.candidateText,
                sanitizeStudentPlaceholder(
                  qualityAssessment?.improvedVersion
                    ? `Bien. Esta idea sí se puede registrar mejor redactada como:\n**${qualityAssessment.improvedVersion}**`
                    : interpretedNormalized.userFacingResponse,
                  preferredFirstName
                )
              )
            : buildStableNoMutationResult(
                fodaState,
                sanitizeStudentPlaceholder(interpretedNormalized.userFacingResponse, preferredFirstName)
              );

        return NextResponse.json(
          {
            ok: true,
            data: fallbackData,
            meta: {
              fallback: true,
              phase: "mutation",
              reason: "LLM_INVALID_SHAPE",
              intent: interpretedNormalized.intent,
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

    let assistantMessage = sanitizeStudentPlaceholder(
      parsedResponse.data.assistantMessage,
      preferredFirstName
    );

    if (interpretedNormalized.intent === "propose_item") {
      const evidenceGate = buildServerEvidenceGate({
        prevState: fodaState,
        nextState: enforced.nextState,
      });

      if (evidenceGate) {
        return NextResponse.json(
          {
            ok: true,
            data: evidenceGate,
            meta: {
              fallback: false,
              phase: "server_evidence_gate",
              reason: "EXTERNAL_EVIDENCE_REQUIRED",
              intent: interpretedNormalized.intent,
            },
          },
          { status: 200 }
        );
      }
    }

    const previousQuadrant = fodaState.currentQuadrant;
    const previousCount = fodaState.items[previousQuadrant].length;
    const nextCount = enforced.nextState.items[previousQuadrant].length;

    const completedCurrentQuadrantNow =
      enforced.nextState.currentQuadrant === previousQuadrant &&
      !enforced.nextState.pendingEvidence &&
      previousCount < 3 &&
      nextCount >= 3;

    let finalAction = enforced.action;
    let finalNextState = enforced.nextState;

    if (completedCurrentQuadrantNow) {
      const normalizedAfterCompletion = normalizeCompletedQuadrantState(enforced.nextState);
      const movedToAnotherQuadrant =
        normalizedAfterCompletion.currentQuadrant !== previousQuadrant;

      finalNextState = normalizedAfterCompletion;
      finalAction = movedToAnotherQuadrant ? "advance_quadrant" : enforced.action;

      assistantMessage = sanitizeStudentPlaceholder(
        movedToAnotherQuadrant
          ? buildQuadrantAdvanceMessage(
              previousQuadrant,
              normalizedAfterCompletion.currentQuadrant,
              assistantMessage
            )
          : buildQuadrantCompletedMessage(normalizedAfterCompletion, assistantMessage),
        preferredFirstName
      );
    } else if (enforced.action === "advance_quadrant") {
      assistantMessage = sanitizeStudentPlaceholder(
        buildQuadrantAdvanceMessage(
          previousQuadrant,
          enforced.nextState.currentQuadrant,
          assistantMessage
        ),
        preferredFirstName
      );
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          assistantMessage,
          updates: {
            action: finalAction,
            nextState: finalNextState,
          },
        },
        meta: {
          fallback: false,
          phase: "mutation",
          intent: interpretedNormalized.intent,
        },
      },
      { status: 200 }
    );
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return fail(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
      );
    }

    const message = err instanceof Error ? err.message : "Error en FODA assistant";
    return fail(500, "INTERNAL", "Error interno.", message);
  }
}
