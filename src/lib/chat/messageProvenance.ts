// src/lib/chat/messageProvenance.ts
//
// Procedencia de los mensajes del chat (R1). Lógica pura, válida en el navegador y en el
// servidor. El role guardado en messages dice QUIÉN responde por el texto:
//
//   user       A. Lo escribió el estudiante.
//   assistant  B. Lo emitió el servidor: /api/messages solo lo acepta con un recibo verificado
//                 (queda su receipt_nonce), y /api/chat y /api/plans/review lo escriben ellos
//                 mismos con la respuesta que generan.
//   advisor    C. Texto local del asesor, generado en el navegador: guías, transiciones,
//                 validaciones, reanudaciones y el asistente de E0. Se conserva en el historial,
//                 pero nunca se atribuye a la IA ni se considera verificado.
//   assistant  D. Histórico anterior a M2 (sin receipt_nonce): mezcla de B y C que no se puede
//                 separar a posteriori. No se reclasifica.
//
// Un recibo prueba que el servidor emitió el texto, no que lo escribiera Gemini: B incluye
// también los textos fijos que devuelven las rutas assistant.
//
// El role que manda el navegador nunca es prueba de origen: assistant exige recibo y advisor
// no da ningún privilegio.

export const MESSAGE_ROLES = ["user", "assistant", "advisor"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

// Lado del asesor en la conversación (burbuja de la izquierda, "último mensaje del asesor").
export function isAdvisorSideRole(role: string): boolean {
  return role === "assistant" || role === "advisor";
}

// Etiqueta de cada mensaje en el historial que el navegador manda a las rutas assistant
// (recentHistory). Los textos locales no se presentan como respuestas del asistente.
export function historySpeaker(role: MessageRole): "STUDENT" | "ASSISTANT" | "PLATFORM_GUIDE" {
  if (role === "user") return "STUDENT";
  if (role === "assistant") return "ASSISTANT";
  return "PLATFORM_GUIDE";
}

// La ruta de Ishikawa solo admite user/assistant en recentMessages: los textos locales van como
// assistant pero marcados, para que el modelo no los tome por respuestas suyas.
export const LOCAL_GUIDE_PREFIX = "[Guía automática de la plataforma] ";

export function toIshikawaRecentMessage(message: { role: MessageRole; content: string }): {
  role: "user" | "assistant";
  content: string;
} {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "assistant") return { role: "assistant", content: message.content };
  return { role: "assistant", content: LOCAL_GUIDE_PREFIX + message.content };
}

// Etiqueta en el historial que /api/chat arma desde la base para Gemini.
export function serverHistorySpeaker(role: string): string {
  if (role === "user") return "Usuario";
  if (role === "assistant") return "Asistente";
  return "Guía automática (no IA)";
}
