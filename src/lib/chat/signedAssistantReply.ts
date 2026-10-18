// src/lib/chat/signedAssistantReply.ts
//
// Transporte en el navegador del recibo que las rutas assistant del asesor añaden a sus
// respuestas (R1). Lógica pura, sin I/O ni criptografía: el cliente no verifica, no fabrica y
// no modifica recibos; solo los lleva desde la respuesta hasta el guardado del mensaje.
//
// Un recibo vale para el texto EXACTO que emitió el servidor, para el usuario de la sesión y
// para el chat enviado en la petición. Por eso viaja con ese texto y ese chat, como metadato
// de la respuesta que lo trajo (no hay registro global), y se adjunta al guardado solo si el
// texto que se guarda viene de esa respuesta (comparación exacta, sin normalizar) y se guarda
// en ese mismo chat. En cualquier otro caso el mensaje se guarda igual que antes, sin recibo.
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

export type SignedReplyAttachment =
  | { attached: true; serverReply: AssistantServerReply }
  | { attached: false; reason: "NO_RECEIPT" | "CONTENT_MISMATCH" | "CHAT_MISMATCH" };

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

// Decide si el recibo acompaña al mensaje que se va a guardar. content es el texto que recibió
// appendAssistant (antes de suavizarlo y darle formato) y chatId el chat donde se guarda.
export function attachSignedReply(input: {
  content: string;
  chatId: string;
  reply: SignedAssistantReply | null | undefined;
}): SignedReplyAttachment {
  const { content, chatId, reply } = input;

  if (!reply) return { attached: false, reason: "NO_RECEIPT" };
  if (reply.assistantMessage !== content) return { attached: false, reason: "CONTENT_MISMATCH" };
  if (reply.chatId !== chatId) return { attached: false, reason: "CHAT_MISMATCH" };

  return {
    attached: true,
    serverReply: Object.freeze({
      assistantMessage: reply.assistantMessage,
      assistantReceipt: reply.assistantReceipt,
    }),
  };
}
