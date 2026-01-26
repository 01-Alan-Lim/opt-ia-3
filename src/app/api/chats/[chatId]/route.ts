// src/app/api/chats/[chatId]/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  chatId: z.string().uuid(),
});

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => typeof v.title !== "undefined" || typeof v.pinned !== "undefined", {
    message: "Debes enviar 'title' y/o 'pinned'.",
  });

async function assertOwnership(chatId: string, userId: string) {
  const { data, error } = await supabaseServer
    .from("chats")
    .select("id, client_id, mode, pinned, hidden, title, created_at")
    .eq("id", chatId)
    .maybeSingle();

  if (error || !data) throw new Error("NOT_FOUND");
  if (data.client_id !== userId) throw new Error("FORBIDDEN");
  return data;
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/chats/[chatId]">
) {
  try {
    const user = await requireUser(req);

    // Next 16: params es Promise => await
    const { chatId } = ParamsSchema.parse(await ctx.params);

    await assertOwnership(chatId, user.userId);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return failResponse("BAD_REQUEST", "Body JSON inválido", 400);
    }

    const parsed = PatchSchema.safeParse(raw);
    if (!parsed.success) {
      return failResponse("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido", 400);
    }

    const patch: Record<string, unknown> = {};
    if (typeof parsed.data.title === "string") patch.title = parsed.data.title;
    if (typeof parsed.data.pinned === "boolean") patch.pinned = parsed.data.pinned;

    if (!Object.keys(patch).length) {
      return failResponse("BAD_REQUEST", "No hay campos para actualizar", 400);
    }

    const { data, error } = await supabaseServer
      .from("chats")
      .update(patch)
      .eq("id", chatId)
      .select("id, title, created_at, mode, pinned, hidden")
      .single();

    if (error || !data) {
      return failResponse("INTERNAL", "No se pudo actualizar el chat", 500, error);
    }

    return ok({ chat: data });
  } catch (e: any) {
    const msg = e?.message;

    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "No autenticado", 401);
    if (msg === "FORBIDDEN_DOMAIN") return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    if (msg === "NOT_FOUND") return failResponse("NOT_FOUND", "Chat no encontrado", 404);
    if (msg === "FORBIDDEN") return failResponse("FORBIDDEN", "No tienes acceso a este chat", 403);

    return failResponse("INTERNAL", "Error interno", 500);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/chats/[chatId]">
) {
  try {
    const user = await requireUser(req);

    // Next 16: params es Promise => await
    const { chatId } = ParamsSchema.parse(await ctx.params);

    await assertOwnership(chatId, user.userId);

    const { error } = await supabaseServer
      .from("chats")
      .update({ hidden: true })
      .eq("id", chatId);

    if (error) {
      return failResponse("INTERNAL", "No se pudo eliminar el chat de la lista", 500, error);
    }

    return ok({ deleted: true, chatId });
  } catch (e: any) {
    const msg = e?.message;

    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "No autenticado", 401);
    if (msg === "FORBIDDEN_DOMAIN") return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    if (msg === "NOT_FOUND") return failResponse("NOT_FOUND", "Chat no encontrado", 404);
    if (msg === "FORBIDDEN") return failResponse("FORBIDDEN", "No tienes acceso a este chat", 403);

    return failResponse("INTERNAL", "Error interno", 500);
  }
}
