// src/lib/chat/messageWritePolicy.ts

// Política de escritura de POST /api/messages. Lógica pura, sin I/O: la ruta carga el dueño
// del chat y el gate académico, y esta función decide qué se inserta.
//
// Qué protege:
//   - role: solo "user" y "assistant". "system" no lo envía ningún cliente y deja de
//     aceptarse.
//   - dueño: el chat tiene que ser del usuario autenticado (chats.client_id). Se comprueba
//     antes que el gate, así un chat ajeno responde igual tenga o no acceso el usuario.
//   - acceso académico: el mismo gate que /api/chat y /api/plans/* (perfil aprobado,
//     cohorte activa y ventana de acceso vigente). Antes esta ruta no lo exigía.
//
// Qué NO protege todavía (riesgo residual R1): "assistant" se sigue aceptando porque el
// asesor guarda sus respuestas desde el navegador (appendAssistant en chat/page.tsx, los
// turnos de _lib/turns y las transiciones de _lib/advisorTransitions.ts). Mientras eso no
// pase al servidor, el dueño de un chat puede añadir en él un mensaje con role "assistant"
// que el modelo no escribió. No puede editar ni borrar los existentes: M1 retiró UPDATE y
// DELETE a authenticated y /api/chats/[chatId]/clear está desactivado.

import { z } from "zod";

import type { GateReason } from "@/lib/auth/chatAccess";

export const CLIENT_MESSAGE_ROLES = ["user", "assistant"] as const;
export type ClientMessageRole = (typeof CLIENT_MESSAGE_ROLES)[number];

export const MESSAGE_CONTENT_MAX = 6000;

export const PersistMessageBodySchema = z.object({
  chatId: z.string().uuid(),
  role: z.enum(CLIENT_MESSAGE_ROLES),
  content: z.string().min(1).max(MESSAGE_CONTENT_MAX),
});

export type PersistMessageBody = z.infer<typeof PersistMessageBodySchema>;

export type MessageAccessGate =
  | { ok: true }
  | { ok: false; reason: GateReason; message: string };

export type MessageWriteDecision =
  | { ok: true; row: { chat_id: string; role: ClientMessageRole; content: string } }
  | {
      ok: false;
      status: 403 | 404;
      code: "NOT_FOUND" | "FORBIDDEN" | GateReason;
      message: string;
    };

export function decideMessageWrite(input: {
  userId: string;
  body: PersistMessageBody;
  // null cuando el chat no existe.
  chatOwnerId: string | null;
  gate: MessageAccessGate;
}): MessageWriteDecision {
  const { userId, body, chatOwnerId, gate } = input;

  if (chatOwnerId === null) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "Chat no encontrado" };
  }

  if (chatOwnerId !== userId) {
    return { ok: false, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat" };
  }

  if (!gate.ok) {
    return { ok: false, status: 403, code: gate.reason, message: gate.message };
  }

  return { ok: true, row: { chat_id: body.chatId, role: body.role, content: body.content } };
}
