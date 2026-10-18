// src/lib/plan/ishikawaTurnRouter.ts

// Decisiones deterministas del comienzo de un turno de Ishikawa (E4), antes de cualquier
// llamada a Gemini. Lógica pura: la usan ishikawa/assistant y el arnés de simulación.
//
// Orden:
// 1. Pregunta pendiente de causa raíz repetida: un sí/no claro la responde; un mensaje sobre
//    esa pregunta que no es un sí/no claro (o un simple "ok") recibe el recordatorio. Cualquier
//    otro mensaje sigue su camino y la respuesta del turno le vuelve a mostrar la pregunta: se
//    puede responder en cualquier momento y no traba el resto.
// 2. Retomar una rama sin terminar ("retomar 2", "volvamos a <subcausa>").
// 3. Avance o "¿qué me falta?", y pedido de pasar de etapa.
// 4. Confirmación de cierre ("cerremos").
// 5. Con una subcausa abierta: un acuse ("ok") vuelve a mostrar el porqué pendiente; cualquier
//    otro mensaje que no pida ayuda, no navegue ni pregunte por el proceso es una respuesta y
//    se captura (la calidad decide si sirve como causa).
// Lo demás sigue el flujo general de la ruta.

import { classifyWhyIntent, isProgressRequest, isStageAdvanceRequest } from "./ishikawaWhyInterpreter";
import { detectResumeRequest, listUnreviewedBranches, type ResumeRequest } from "./ishikawaResume";
import { interpretPendingRootReply, isAboutPendingRootQuestion } from "./ishikawaRootRegistry";
import { findActiveNodes, parsePendingRootMatch, type IshikawaState } from "./ishikawaTree";

export type EarlyTurnRoute =
  | { kind: "root_answer"; answer: "yes" | "no" }
  | { kind: "root_reminder" }
  | { kind: "resume"; request: ResumeRequest }
  | { kind: "progress" }
  | { kind: "stage_advance" }
  | { kind: "close_branch" }
  | { kind: "reprompt" }
  | { kind: "capture" }
  | { kind: "continue" };

export function routeIshikawaTurn(input: { state: IshikawaState; message: string }): EarlyTurnRoute {
  const { state, message } = input;
  const hasActiveSubCause = Boolean(findActiveNodes(state)?.sc);
  const whyIntent = classifyWhyIntent(message);

  if (parsePendingRootMatch(state.pendingRootMatch)) {
    const reply = interpretPendingRootReply(message);
    if (reply !== "unclear") return { kind: "root_answer", answer: reply };
    if (isAboutPendingRootQuestion(message) || whyIntent === "unclear") return { kind: "root_reminder" };
  }

  const resume = detectResumeRequest(message, listUnreviewedBranches(state), {
    allowBareReference: !hasActiveSubCause,
  });
  if (resume) return { kind: "resume", request: resume };

  if (isProgressRequest(message)) return { kind: "progress" };
  if (isStageAdvanceRequest(message)) return { kind: "stage_advance" };
  if (whyIntent === "close_request") return { kind: "close_branch" };

  if (hasActiveSubCause) {
    if (whyIntent === "unclear") return { kind: "reprompt" };
    if (whyIntent === "answer_why") return { kind: "capture" };
  }

  return { kind: "continue" };
}
