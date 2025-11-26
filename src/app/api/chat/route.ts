// src/app/api/chat/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getGeminiModel } from "@/lib/geminiClient";

export async function POST(request: Request) {
  const body = await request.json();
  const userMessage: string = body.message ?? "";
  const incomingChatId: string | null = body.chatId ?? null;

  if (!userMessage.trim()) {
    return NextResponse.json(
      { error: "Mensaje vacío" },
      { status: 400 }
    );
  }

  const clientId = "demo-client"; // luego será el userId real (Privy)
  let chatId = incomingChatId;

  // 1) Si no hay chatId, creamos un nuevo chat
  if (!chatId) {
    const { data, error } = await supabase
      .from("chats")
      .insert({
        client_id: clientId,
        title: userMessage.slice(0, 60),
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Error creando chat:", error);
      return NextResponse.json(
        { error: "No se pudo crear el chat" },
        { status: 500 }
      );
    }

    chatId = data.id as string;
  }

  // 2) Guardar mensaje del usuario
  const { error: insertUserError } = await supabase.from("messages").insert({
    chat_id: chatId,
    role: "user",
    content: userMessage,
  });

  if (insertUserError) {
    console.error("Error guardando mensaje usuario:", insertUserError);
  }

  // 3) Leer historial reciente del chat desde Supabase
  //    (por ejemplo, los últimos 12 mensajes ordenados por fecha)
  const { data: historyData, error: historyError } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(12);

  if (historyError) {
    console.error("Error obteniendo historial:", historyError);
  }

  const historyLines =
    historyData?.map((m) => {
      let prefix = "Sistema";
      if (m.role === "user") prefix = "Usuario";
      if (m.role === "assistant") prefix = "Asistente";
      return `${prefix}: ${m.content}`;
    }) ?? [];

  const conversationText = historyLines.join("\n");

  // 4) Llamar a Gemini con el historial como contexto
  let replyText: string;

  try {
    const model = getGeminiModel();

    const systemPrompt = `
Eres OPT-IA, un asistente de productividad para micro y pequeñas empresas (MyPEs).
Responde de forma clara, concreta y práctica.
Mantén el contexto de la conversación anterior.
Responde siempre en el mismo idioma en el que te hablan.
Si no tienes datos suficientes, dilo de forma honesta y sugiere qué información faltaría.
`;

    const result = await model.generateContent([
      systemPrompt,
      "Historial de la conversación (Usuario/Asistente):",
      conversationText || "(sin historial previo)",
      "Responde al último mensaje del usuario de forma útil y breve.",
    ]);

    const response = await result.response;
    replyText = response.text();

    if (!replyText.trim()) {
      replyText =
        "No pude generar una respuesta útil en este momento. Intenta reformular tu pregunta.";
    }
  } catch (err: any) {
    console.error(
      "Error llamando a Gemini:",
      JSON.stringify(err, null, 2)
    );
    replyText =
      "⚠️ Hubo un problema al conectar con el modelo de IA. Intenta nuevamente en unos momentos.";
  }

  // 5) Guardar respuesta del asistente
  const { error: insertAssistantError } = await supabase
    .from("messages")
    .insert({
      chat_id: chatId,
      role: "assistant",
      content: replyText,
    });

  if (insertAssistantError) {
    console.error("Error guardando mensaje asistente:", insertAssistantError);
  }

  // 6) Responder al frontend
  return NextResponse.json({
    reply: replyText,
    chatId,
  });
}
