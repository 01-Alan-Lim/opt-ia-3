"use client";

import { useEffect, useState } from "react";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { Message } from "@/lib/types";

const GREETING =
  "Hola, soy OPT-IA 3. Estoy en modo demo todavía, pero pronto me conectaré a Supabase y Google AI para ayudarte con productividad en MyPEs.";

function createMessage(role: Message["role"], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Cargar mensajes cuando cambia el chatId
  useEffect(() => {
    // Nuevo chat (sin chatId): solo mostramos saludo
    if (!chatId) {
      setMessages([createMessage("assistant", GREETING)]);
      return;
    }

    async function loadMessages() {
      setIsLoadingHistory(true);
      try {
        const res = await fetch(`/api/messages?chatId=${chatId}`);
        const data = await res.json();
        if (res.ok) {
          setMessages(data.messages);
        } else {
          console.error(data.error);
        }
      } catch (err) {
        console.error("Error al cargar mensajes:", err);
      } finally {
        setIsLoadingHistory(false);
      }
    }

    loadMessages();
  }, [chatId]);

  async function handleSend(text: string) {
    const userMessage = createMessage("user", text);
    setMessages((prev) => [...prev, userMessage]);

    setIsSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          chatId: chatId, // puede ser null al inicio
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorMessage = createMessage(
          "assistant",
          data.error || "⚠️ Error desde el servidor."
        );
        setMessages((prev) => [...prev, errorMessage]);
        return;
      }

      // Actualizar chatId si el servidor creó uno nuevo
      if (data.chatId && data.chatId !== chatId) {
        setChatId(data.chatId);
      }

      const assistantMessage = createMessage("assistant", data.reply);
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage = createMessage(
        "assistant",
        "⚠️ Ocurrió un error al procesar tu mensaje."
      );
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsSending(false);
    }
  }

  function handleNewChat() {
    setChatId(null);
    setMessages([createMessage("assistant", GREETING)]);
  }

  return (
    <ChatLayout
      sidebar={
        <Sidebar
          currentChatId={chatId}
          onSelectChat={setChatId}
          onNewChat={handleNewChat}
        />
      }
    >
      <MessageList messages={messages} />
      <MessageInput onSend={handleSend} disabled={isSending} />
      {(isSending || isLoadingHistory) && (
        <p className="mt-2 text-[11px] text-slate-400">
          {isSending
            ? "OPT-IA 3 está pensando..."
            : "Cargando historial del chat..."}
        </p>
      )}
    </ChatLayout>
  );
}
