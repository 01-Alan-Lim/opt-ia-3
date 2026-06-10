import type { PlanStage } from "@/lib/plan/stageOrchestrator";

export type ConversationIntent =
  | "answer"
  | "help_request"
  | "example_request"
  | "conceptual_question"
  | "unknown"
  | "correction"
  | "meta_process"
  | "context_change"
  | "confirmation"
  | "off_topic";

export type ClassifyConversationIntentInput = {
  message: string;
  stage?: PlanStage | string;
  currentStep?: string | null;
  currentState?: unknown;
};

export type ConversationIntentResult = {
  intent: ConversationIntent;
  confidence: number;
  shouldMutateStage: boolean;
  shouldAskFollowUp: boolean;
  normalizedMessage: string;
  reason: string;
};

type IntentRule = {
  intent: ConversationIntent;
  confidence: number;
  shouldMutateStage: boolean;
  shouldAskFollowUp: boolean;
  reason: string;
  test: (context: RuleContext) => boolean;
};

type RuleContext = {
  raw: string;
  normalized: string;
  tokens: readonly string[];
  hasQuestionMark: boolean;
  stage: string | null;
  currentStep: string | null;
};

const ACADEMIC_FLOW_TERMS = [
  "pareto",
  "criterio",
  "criterios",
  "peso",
  "pesos",
  "ponderacion",
  "ponderaciones",
  "causa",
  "causas",
  "raiz",
  "raices",
  "critica",
  "criticas",
  "impacto",
  "frecuencia",
  "controlabilidad",
  "priorizacion",
  "excel",
  "foda",
  "ishikawa",
  "objetivo",
  "objetivos",
  "plan",
  "mejora",
  "cronograma",
  "avance",
  "avances",
] as const;

const ACTION_ANSWER_TERMS = [
  "propongo",
  "defino",
  "definiria",
  "usaria",
  "quiero usar",
  "voy a usar",
  "seleccione",
  "selecciono",
  "mis criterios",
  "los criterios son",
  "las causas son",
  "causas criticas",
  "causas criticas",
  "top 20",
  "peso",
  "pesos",
] as const;

function normalizeMessage(message: string): string {
  return String(message ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00a1\u00bf]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized
    .split(/[^a-z0-9%]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function includesAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(normalizeMessage(value)));
}

function isExactAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text === normalizeMessage(value));
}

function hasAcademicContext(context: RuleContext): boolean {
  return (
    context.stage !== null ||
    context.currentStep !== null ||
    includesAny(context.normalized, ACADEMIC_FLOW_TERMS)
  );
}

function hasAnswerSignal(context: RuleContext): boolean {
  if (includesAny(context.normalized, ACTION_ANSWER_TERMS)) return true;

  const hasListSeparators =
    context.raw.includes("\n") ||
    context.raw.includes(";") ||
    context.raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean).length >= 2;

  const hasNumbers = /\b\d{1,3}\b/.test(context.normalized);
  const enoughAcademicTerms =
    ACADEMIC_FLOW_TERMS.filter((term) => context.normalized.includes(term)).length >= 2;

  return hasListSeparators || (hasNumbers && enoughAcademicTerms);
}

function buildContext(input: ClassifyConversationIntentInput): RuleContext {
  const raw = String(input.message ?? "").trim();
  const normalized = normalizeMessage(raw);

  return {
    raw,
    normalized,
    tokens: tokenize(normalized),
    hasQuestionMark: raw.includes("?") || raw.includes("\u00bf"),
    stage: input.stage === undefined || input.stage === null ? null : String(input.stage),
    currentStep: input.currentStep ?? null,
  };
}

const RULES: readonly IntentRule[] = [
  {
    intent: "off_topic",
    confidence: 0.92,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Mensaje vacio o sin contenido academico utilizable.",
    test: (context) => context.normalized.length === 0,
  },
  {
    intent: "confirmation",
    confidence: 0.9,
    shouldMutateStage: true,
    shouldAskFollowUp: false,
    reason: "Confirmacion breve del estudiante.",
    test: (context) =>
      isExactAny(context.normalized, [
        "ok",
        "okay",
        "dale",
        "listo",
        "de acuerdo",
        "si",
        "si",
        "correcto",
        "confirmo",
        "confirmado",
        "continuemos",
        "sigamos",
      ]) ||
      includesAny(context.normalized, [
        "si son esas",
        "si son esas",
        "son esas",
        "esas son",
        "confirmo esas",
        "correcto son esas",
        "pasemos a la siguiente",
        "pasamos de etapa",
      ]),
  },
  {
    intent: "context_change",
    confidence: 0.88,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Solicita cambiar contexto, problema, empresa o enfoque base.",
    test: (context) =>
      includesAny(context.normalized, [
        "cambiar de empresa",
        "cambie de empresa",
        "otra empresa",
        "cambiar el problema",
        "cambie el problema",
        "otro problema",
        "cambiar el enfoque",
        "nuevo enfoque",
        "reiniciar el caso",
        "empezar otro caso",
      ]),
  },
  {
    intent: "correction",
    confidence: 0.86,
    shouldMutateStage: true,
    shouldAskFollowUp: true,
    reason: "El estudiante quiere corregir una respuesta anterior.",
    test: (context) =>
      includesAny(context.normalized, [
        "corrijo",
        "corregir",
        "quiero cambiar",
        "me equivoque",
        "me equivoque",
        "no era",
        "reemplazar",
        "editar",
        "ajustar lo anterior",
        "cambiar el criterio",
        "cambiar el peso",
        "cambiar la causa",
      ]),
  },
  {
    intent: "example_request",
    confidence: 0.9,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Pide un ejemplo para avanzar.",
    test: (context) =>
      includesAny(context.normalized, [
        "ejemplo",
        "dame un ejemplo",
        "dame ejemplo",
        "un ejemplo",
        "como seria un ejemplo",
        "muestrame un ejemplo",
        "muestrame un ejemplo",
      ]),
  },
  {
    intent: "unknown",
    confidence: 0.88,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Expresa bloqueo, falta de ideas o falta de comprension.",
    test: (context) =>
      includesAny(context.normalized, [
        "no se",
        "no se",
        "no entiendo",
        "no me queda claro",
        "no se me ocurre",
        "no se que poner",
        "no se que poner",
        "estoy perdido",
        "estoy confundido",
        "no tengo idea",
      ]),
  },
  {
    intent: "help_request",
    confidence: 0.84,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Pide ayuda, orientacion o el siguiente micro-paso.",
    test: (context) =>
      includesAny(context.normalized, [
        "ayuda",
        "ayudame",
        "ayudame",
        "orientame",
        "orientame",
        "guiame",
        "guiame",
        "que hago",
        "que hago",
        "que sigue",
        "que sigue",
        "como sigo",
        "como sigo",
        "por donde empiezo",
      ]),
  },
  {
    intent: "meta_process",
    confidence: 0.82,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Pregunta por el proceso, la etapa o el criterio de avance.",
    test: (context) =>
      includesAny(context.normalized, [
        "esta etapa",
        "la etapa",
        "como se valida",
        "como se valida",
        "cuando termina",
        "cuando termina",
        "puedo pasar",
        "pasar de etapa",
        "que falta para validar",
        "que falta para validar",
        "que debo entregar",
        "que debo entregar",
      ]),
  },
  {
    intent: "conceptual_question",
    confidence: 0.8,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "Pregunta conceptual relacionada con el flujo academico.",
    test: (context) =>
      context.hasQuestionMark ||
      includesAny(context.normalized, [
        "que es",
        "que es",
        "que significa",
        "que significa",
        "para que sirve",
        "para que sirve",
        "como funciona",
        "como funciona",
        "como calculo",
        "como calculo",
        "como ponderar",
        "como ponderar",
        "por que",
        "por que",
      ]),
  },
  {
    intent: "answer",
    confidence: 0.76,
    shouldMutateStage: true,
    shouldAskFollowUp: false,
    reason: "Parece una respuesta academica utilizable para la etapa.",
    test: (context) => hasAcademicContext(context) && hasAnswerSignal(context),
  },
  {
    intent: "off_topic",
    confidence: 0.62,
    shouldMutateStage: false,
    shouldAskFollowUp: true,
    reason: "No se detecto relacion suficiente con el flujo academico.",
    test: (context) => !hasAcademicContext(context) && context.tokens.length <= 8,
  },
];

export function classifyConversationIntent(
  input: ClassifyConversationIntentInput
): ConversationIntentResult {
  const context = buildContext(input);

  const matched = RULES.find((rule) => rule.test(context));
  if (matched) {
    return {
      intent: matched.intent,
      confidence: matched.confidence,
      shouldMutateStage: matched.shouldMutateStage,
      shouldAskFollowUp: matched.shouldAskFollowUp,
      normalizedMessage: context.normalized,
      reason: matched.reason,
    };
  }

  const hasContext = hasAcademicContext(context);

  return {
    intent: hasContext ? "answer" : "off_topic",
    confidence: hasContext ? 0.58 : 0.45,
    shouldMutateStage: hasContext,
    shouldAskFollowUp: !hasContext,
    normalizedMessage: context.normalized,
    reason: hasContext
      ? "Mensaje academico sin senal clara de ayuda o pregunta; se trata como respuesta tentativa."
      : "Mensaje ambiguo sin suficiente contexto academico.",
  };
}
