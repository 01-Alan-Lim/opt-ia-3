// src/app/api/messages/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";
import { Message } from "@/lib/types";

const QuerySchema = z.object({
  chatId: z.string().min(1),
});

const PostBodySchema = z.object({
  chatId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(6000),
});

async function assertChatOwnership(userId: string, chatId: string) {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (chatErr || !chatRow) {
    return { ok: false as const, status: 404, code: "NOT_FOUND", message: "Chat no encontrado" };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false as const, status: 403, code: "FORBIDDEN", message: "No tienes acceso a este chat" };
  }

  return { ok: true as const };
}

export async function GET(req: NextRequest) {
  try {
    const parsed = QuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    const user = await requireUser(req);

    const ownership = await assertChatOwnership(user.userId, parsed.chatId);
    if (!ownership.ok) {
      return failResponse(ownership.code as any, ownership.message, ownership.status);
    }

    const { data, error } = await supabaseServer
      .from("messages")
      .select("id, role, content, created_at")
      .eq("chat_id", parsed.chatId)
      .order("created_at", { ascending: true });

    if (error) {
      return failResponse("INTERNAL", "No se pudieron obtener los mensajes", 500);
    }

    const messages: Message[] = (data || []).map((m) => ({
      id: m.id as string,
      role: m.role as Message["role"],
      content: m.content as string,
      createdAt: m.created_at as string,
    }));

    return ok({ messages });
  } catch (err: any) {
    if (err?.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }
    if (err?.name === "ZodError") {
      return failResponse("BAD_REQUEST", "Parámetros inválidos", 400);
    }
    return failResponse("INTERNAL", "Error interno", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const raw = await req.json().catch(() => null);
    const parsed = PostBodySchema.safeParse(raw);
    if (!parsed.success) {
      return failResponse("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido", 400);
    }

    const { chatId, role, content } = parsed.data;

    const ownership = await assertChatOwnership(user.userId, chatId);
    if (!ownership.ok) {
      return failResponse(ownership.code as any, ownership.message, ownership.status);
    }

    const { data, error } = await supabaseServer
      .from("messages")
      .insert({ chat_id: chatId, role, content })
      .select("id, role, content, created_at")
      .single();

    if (error || !data) {
      return failResponse("INTERNAL", "No se pudo guardar el mensaje", 500);
    }

    return ok({
      message: {
        id: data.id as string,
        role: data.role as Message["role"],
        content: data.content as string,
        createdAt: data.created_at as string,
      },
    });
  } catch (err: any) {
    if (err?.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }
    if (err?.name === "ZodError") {
      return failResponse("BAD_REQUEST", "Payload inválido", 400);
    }
    return failResponse("INTERNAL", "Error interno", 500);
  }
}
