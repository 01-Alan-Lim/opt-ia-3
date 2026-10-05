// src/lib/chat/chatStorage.ts
//
// Claves de sessionStorage del chat por usuario y modo. Solo arman el nombre: el formato es el de
// siempre y no se cambia sin migrar lo que ya está guardado. clientId es un dato de UI (userId,
// email o "pending"), nunca autoridad.

export function chatIdStorageKey(clientId: string, mode: string) {
  return `optia-chat-id-${clientId}-${mode}`;
}

export function messagesStorageKey(clientId: string, mode: string) {
  return `optia-messages-${clientId}-${mode}`;
}
