// src/app/chat/_lib/planChatClient.ts
//
// Decisiones del navegador sobre el chat principal del Plan de Mejora. Cuál es lo resuelve el
// servidor (src/lib/plan/planChat.ts, vía /api/plans/context); aquí solo se decide qué hacer con la
// pantalla y la barra lateral. Puras, para probarlas sin React.

// "Nuevo chat" estando ya en el asesor: aviso local (no se guarda en el historial).
export const PLAN_CONTINUES_NOTICE =
  "Tu Plan de Mejora es uno solo, así que seguimos en este mismo chat con tu etapa y tu avance.";

// Al entrar al asesor (cambio de modo, recarga, "Nuevo chat", otra pestaña) con el chat del plan ya
// resuelto:
//   - adopt: el chat activo pasa a ser el del plan;
//   - clearMessages: lo que muestra la pantalla es de otra conversación (el chat del asesor que
//     guardaba la pestaña no era el del plan) y se limpia antes de cargar el historial del plan.
//     Solo cuando además cambia el chat activo: así el historial del plan se vuelve a cargar y
//     nunca se borra uno que ya se mostró.
// storedAdvisorChatId es el chat del asesor que guardaba la pestaña (sessionStorage), leído al
// empezar, y currentChatId el chat activo en ese momento (puede ser el del otro modo).
export function planChatEntry(input: {
  storedAdvisorChatId: string | null;
  currentChatId: string | null;
  planChatId: string;
}) {
  const adopt = input.currentChatId !== input.planChatId;
  return { adopt, clearMessages: adopt && input.storedAdvisorChatId !== input.planChatId };
}

// Chats de la barra lateral: los del Asistente General y, del asesor, solo el del plan (si estaba
// oculto, se agrega con planEntry). Los chats del asesor anteriores quedan guardados, pero no se
// ofrecen: trabajar en ellos volvía a fragmentar el plan. Si el servidor no informó el chat del
// plan (sin plan todavía, o acceso de solo lectura), la lista queda como la devuelve /api/chats.
export function sidebarChats<T extends { id: string; mode?: string | null }>(
  chats: T[],
  planChatId: string | null,
  planEntry: (id: string) => T
): T[] {
  if (!planChatId) return chats;
  const visible = chats.filter((chat) => chat.mode !== "plan_mejora" || chat.id === planChatId);
  return visible.some((chat) => chat.id === planChatId) ? visible : [planEntry(planChatId), ...visible];
}
