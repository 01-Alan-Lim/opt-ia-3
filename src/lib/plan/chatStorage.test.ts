import assert from "node:assert/strict";

import { chatIdStorageKey, messagesStorageKey } from "../chat/chatStorage";

// Fija el formato de las claves de sessionStorage del chat (src/lib/chat/chatStorage.ts). Si cambia,
// los chats y mensajes ya guardados dejan de encontrarse. Vive aquí porque el runner
// (scripts/run-tests.mjs) solo recorre src/lib/plan.

{
  assert.equal(chatIdStorageKey("user-1", "general"), "optia-chat-id-user-1-general");
  assert.equal(chatIdStorageKey("user-1", "plan_mejora"), "optia-chat-id-user-1-plan_mejora");
  assert.equal(messagesStorageKey("user-1", "general"), "optia-messages-user-1-general");
  assert.equal(messagesStorageKey("user-1", "plan_mejora"), "optia-messages-user-1-plan_mejora");
}

{
  // clientId puede ser el email o "pending" mientras no hay sesión: se usa tal cual.
  assert.equal(chatIdStorageKey("ana@uni.edu", "general"), "optia-chat-id-ana@uni.edu-general");
  assert.equal(messagesStorageKey("pending", "plan_mejora"), "optia-messages-pending-plan_mejora");
}

{
  // Misma clave que arman a mano advisorChatStorageKey y handleNewChat en page.tsx.
  const clientId = "user-1";
  assert.equal(chatIdStorageKey(clientId, "plan_mejora"), `optia-chat-id-${clientId}-plan_mejora`);
  assert.equal(messagesStorageKey(clientId, "general"), `optia-messages-${clientId}-general`);
}

console.log("chatStorage tests passed");
