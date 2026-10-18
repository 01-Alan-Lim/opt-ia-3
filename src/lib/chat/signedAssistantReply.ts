// src/lib/chat/signedAssistantReply.ts
//
// Transporte en el navegador del recibo que las rutas assistant del asesor añaden a sus
// respuestas (R1). Lógica pura, sin I/O ni criptografía: el cliente no verifica, no fabrica y
// no modifica recibos; solo los lleva desde la respuesta hasta el guardado del mensaje.
//
// Un recibo vale para el texto EXACTO que emitió el servidor, para el usuario de la sesión y
// para el chat enviado en la petición. Por eso viaja con ese texto y ese chat, como metadato
// de la respuesta que lo trajo (no hay registro global). Un texto del asesor es respuesta del
// servidor solo si es exactamente el assistantMessage de esa respuesta (comparación exacta, sin
// normalizar); entonces se guarda como assistant, con su recibo, en el chat de la petición. Todo
// lo demás es texto local y se guarda como advisor (ver messageProvenance.ts).
//
// Que un mensaje viaje con recibo no lo hace verificado: eso solo puede decidirlo el servidor.

export type SignedAssistantReply = Readonly<{
  // Chat enviado en la petición: el servidor ató el recibo a ese chat.
  chatId: string;
  // assistantMessage exacto de la respuesta.
  assistantMessage: string;
  // assistantReceipt tal cual llegó.
  assistantReceipt: string;
}>;

// Lo que viaja al guardar: la respuesta original del servidor con su recibo.
export type AssistantServerReply = Readonly<{
  assistantMessage: string;
  assistantReceipt: string;
}>;

export type AdvisorTextOrigin =
  // chatId: el de la petición, al que el servidor ató el recibo (y donde el turno guarda el estado).
  | { origin: "server"; chatId: string; serverReply: AssistantServerReply }
  | { origin: "local"; reason: "NO_RECEIPT" | "NOT_TEXT" | "CONTENT_MISMATCH" };

// Lee el recibo de una respuesta de ruta assistant. null si la respuesta falló, si la petición
// no llevó chat o si no hay texto y recibo como strings no vacíos.
export function readSignedAssistantReply(
  ok: boolean,
  data: unknown,
  requestChatId: string | null,
): SignedAssistantReply | null {
  if (!ok || !requestChatId) return null;
  if (!data || typeof data !== "object") return null;

  const { assistantMessage, assistantReceipt } = data as Record<string, unknown>;
  if (typeof assistantMessage !== "string" || assistantMessage.length === 0) return null;
  if (typeof assistantReceipt !== "string" || assistantReceipt.length === 0) return null;

  return Object.freeze({ chatId: requestChatId, assistantMessage, assistantReceipt });
}

// Clasifica el texto que recibió appendAssistant (antes de suavizarlo y darle formato).
export function classifyAdvisorText(
  content: unknown,
  reply: SignedAssistantReply | null | undefined,
): AdvisorTextOrigin {
  if (!reply) return { origin: "local", reason: "NO_RECEIPT" };
  if (typeof content !== "string") return { origin: "local", reason: "NOT_TEXT" };
  if (reply.assistantMessage !== content) return { origin: "local", reason: "CONTENT_MISMATCH" };

  return {
    origin: "server",
    chatId: reply.chatId,
    serverReply: Object.freeze({
      assistantMessage: reply.assistantMessage,
      assistantReceipt: reply.assistantReceipt,
    }),
  };
}
