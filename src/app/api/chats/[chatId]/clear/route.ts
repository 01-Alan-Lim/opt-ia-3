// src/app/api/chats/[chatId]/clear/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  chatId: z.string().uuid(),
});

async function assertChatOwnership(chatId: string, userId: string) {
  const { data, error } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .maybeSingle();

  if (error || !data) throw new Error("NOT_FOUND");
  if (data.client_id !== userId) throw new Error("FORBIDDEN");
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/chats/[chatId]/clear">
) {
  try {
    const user = await requireUser(req);

    // Next 16: params es Promise => await
    const { chatId } = ParamsSchema.parse(await ctx.params);

    await assertChatOwnership(chatId, user.userId);

    const { error } = await supabaseServer.from("messages").delete().eq("chat_id", chatId);

    if (error) {
      return failResponse("INTERNAL", "No se pudo limpiar el historial.", 500, error);
    }

    return ok({ chatId, cleared: true });
  } catch (e: any) {
    const msg = e?.message;

    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "No autenticado", 401);
    if (msg === "FORBIDDEN_DOMAIN") return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    if (msg === "NOT_FOUND") return failResponse("NOT_FOUND", "Chat no encontrado", 404);
    if (msg === "FORBIDDEN") return failResponse("FORBIDDEN", "No tienes acceso a este chat", 403);

    if (e?.name === "ZodError") return failResponse("BAD_REQUEST", "Parámetros inválidos", 400);

    return failResponse("INTERNAL", "Error interno", 500);
  }
}

