// src/app/api/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { Message } from "@/lib/types";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return NextResponse.json(
      { error: "Falta el parámetro chatId" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error obteniendo mensajes:", error);
    return NextResponse.json(
      { error: "No se pudieron obtener los mensajes" },
      { status: 500 }
    );
  }

  const messages: Message[] = (data || []).map((m) => ({
    id: m.id as string,
    role: m.role as Message["role"],
    content: m.content as string,
    createdAt: m.created_at as string,
  }));

  return NextResponse.json({ messages });
}
