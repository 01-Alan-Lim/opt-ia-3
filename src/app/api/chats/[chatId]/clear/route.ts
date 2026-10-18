// src/app/api/chats/[chatId]/clear/route.ts
import { failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

// Borrar el historial de un chat queda desactivado. El borrado era definitivo (service role
// sobre messages) y rompía la trazabilidad que revisa el docente, y ninguna pantalla lo
// llama, ni en main ni en la integración. Se responde 410 sin tocar la base, para cualquier
// usuario y cualquier chat. Ocultar un chat sigue disponible en DELETE /api/chats/[chatId],
// que solo marca hidden = true.
export async function POST() {
  return failResponse("GONE", "El historial de un chat no se puede borrar.", 410);
}
