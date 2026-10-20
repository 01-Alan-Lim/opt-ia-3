// src/app/chat/_lib/stage0Opening.ts
//
// Apertura de la Etapa 0 en el chat del asesor: un solo emisor de la primera pregunta.
//
// Antes había dos: el effect de entrada empujaba "Pregunta 1 de 3" (solo en pantalla, sin
// guardarlo y con un closure de mensajes viejo) y el turno del estudiante volvía a preguntar el
// sector con el texto de Gemini. Ahora:
//   - la apertura se muestra y se guarda una sola vez por chat, y solo si el chat no tiene
//     historial guardado (al recargar, el historial ya muestra la conversación);
//   - si el estudiante escribe mientras se prepara la apertura, la apertura no sale: su turno la
//     responde (stage0Turn.ts recibe la apertura completa si no vio ninguna pregunta);
//   - el turno y la apertura comparten el registro de qué chats ya vieron una pregunta de E0, así
//     ninguno de los dos vuelve a mostrar la bienvenida.
// Nada de esto compara textos: decide por el historial, por quién habló primero y por el chat.
// Con los tres datos ya en borrador, la apertura es el resumen para revisar (buildStage0ReviewOpening).

import {
  buildStage0Opening,
  buildStage0ReviewOpening,
  getNextStage0StepFromContext,
  readStage0Context,
  stage0ReviewKey,
  type Stage0Step,
} from "@/lib/plan/stage0Context";

// Chats en los que el estudiante ya vio una pregunta de E0 (la apertura o una respuesta del turno),
// y el último resumen de los tres datos que vio en esta pestaña (stage0ReviewKey): el turno no
// confirma un contexto distinto del que el estudiante revisó.
export type Stage0PromptTracker = {
  wasPrompted: (chatId: string | null) => boolean;
  markPrompted: (chatId: string | null) => void;
  reviewShown: (chatId: string | null) => string | null;
  markReviewShown: (chatId: string | null, key: string) => void;
};

export function createStage0PromptTracker(): Stage0PromptTracker {
  const prompted = new Set<string>();
  const reviews = new Map<string, string>();
  return {
    wasPrompted: (chatId) => Boolean(chatId && prompted.has(chatId)),
    markPrompted: (chatId) => {
      if (chatId) prompted.add(chatId);
    },
    reviewShown: (chatId) => (chatId ? (reviews.get(chatId) ?? null) : null),
    markReviewShown: (chatId, key) => {
      if (chatId) reviews.set(chatId, key);
    },
  };
}

export type Stage0OpeningDeps = {
  tracker: Stage0PromptTracker;
  // ¿El chat ya tiene mensajes guardados? null si no se pudo saber.
  hasHistory: (chatId: string) => Promise<boolean | null>;
  // Mensajes que el estudiante envió en el asesor desde que se cargó la página.
  studentSendCount: () => number;
  // El effect sigue vigente y este es todavía el chat del asesor en pantalla.
  isCurrent: (chatId: string) => boolean;
  // Muestra la apertura como única conversación del chat y la guarda.
  show: (chatId: string, text: string) => Promise<void>;
};

export type Stage0OpeningResult =
  | "opened"
  | "context_confirmed"
  | "already_prompted"
  | "has_history"
  | "history_unknown"
  | "student_first"
  | "not_current";

export async function openStage0(
  deps: Stage0OpeningDeps,
  input: {
    chatId: string;
    // Estado de plan_case_contexts: con E0 confirmado no hay apertura de E0 (el plan es uno por
    // estudiante; un chat nuevo continúa su etapa).
    contextStatus: "draft" | "confirmed";
    contextJson: unknown;
    // Nombre de pila del perfil (describeChatIdentity); page.tsx espera a /api/me para tenerlo.
    greetingName?: string | null;
    // El chat se acaba de crear: no hace falta consultar su historial.
    knownEmpty: boolean;
    // studentSendCount() al empezar el effect, antes de cualquier espera.
    studentSendsAtStart: number;
  }
): Promise<Stage0OpeningResult> {
  const { chatId } = input;
  const { tracker } = deps;
  if (input.contextStatus === "confirmed") return "context_confirmed";
  if (tracker.wasPrompted(chatId)) return "already_prompted";

  const history = input.knownEmpty ? false : await deps.hasHistory(chatId);

  // Lo que pasó mientras se esperaba: otro chat, otro modo, o el estudiante ya escribió (su turno
  // responde y decide si le corresponde la apertura completa).
  if (!deps.isCurrent(chatId)) return "not_current";
  if (deps.studentSendCount() !== input.studentSendsAtStart) return "student_first";
  if (history === null) return "history_unknown";
  if (history) {
    tracker.markPrompted(chatId);
    return "has_history";
  }
  if (tracker.wasPrompted(chatId)) return "already_prompted";

  tracker.markPrompted(chatId);
  const context = readStage0Context(asRecord(input.contextJson));
  const next = getNextStage0StepFromContext(context);
  if (next === 0) {
    tracker.markReviewShown(chatId, stage0ReviewKey(context));
    await deps.show(chatId, buildStage0ReviewOpening(context, input.greetingName));
    return "opened";
  }
  const step: Stage0Step = next;
  await deps.show(chatId, buildStage0Opening(step, context, input.greetingName));
  return "opened";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
