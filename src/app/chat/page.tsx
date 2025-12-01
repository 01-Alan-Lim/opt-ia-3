// src/app/chat/page.tsx
"use client";

import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import Image from "next/image"; // 👈 IMPORTANTE: para el logo
import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { Message } from "@/lib/types";

const GREETING =
  "Hola, soy OPT-IA. Me conceto a Supabase y Google AI para ayudarte con productividad en MyPEs.";

function createMessage(role: Message["role"], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export default function ChatPage() {
  // ✅ 1. Hooks
  const { ready, authenticated, user, login, logout } = usePrivy();
  const router = useRouter();

  // Id directo de Privy
  const userId = user?.id ?? null;

  // 🔑 ID estable para backend y storage
  const clientId = user?.id || user?.email?.address || "anon";

  // -----------------------------
  // 👤 NOMBRE BONITO DEL USUARIO
  // -----------------------------
  // @ts-ignore porque depende del proveedor
  const displayName =
    user?.google?.name ||
    // @ts-ignore
    user?.github?.name ||
    user?.email?.address?.split("@")[0] ||
    "Usuario";

  // -----------------------------
  // STORAGE SEGÚN USUARIO
  // -----------------------------
  const storageKeyChat = `optia-chat-id-${clientId}`;
  const storageKeyMsgs = `optia-messages-${clientId}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Sidebar plegable
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // -----------------------------
  // 2a. Cargar desde storage
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;

    try {
      const storedChatId = window.sessionStorage.getItem(storageKeyChat);
      const storedMsgs = window.sessionStorage.getItem(storageKeyMsgs);

      setChatId(storedChatId || null);

      if (storedMsgs) {
        setMessages(JSON.parse(storedMsgs));
      } else {
        setMessages([createMessage("assistant", GREETING)]);
      }
    } catch (e) {
      console.warn("No se pudo leer storage:", e);
      setMessages([createMessage("assistant", GREETING)]);
    }
  }, [ready, authenticated, storageKeyChat, storageKeyMsgs]);

  // -----------------------------
  // 2b. Cargar historial del backend
  // -----------------------------
  useEffect(() => {
    if (!ready) return;

    if (!authenticated) {
      setChatId(null);
      setMessages([createMessage("assistant", GREETING)]);
      return;
    }

    if (!chatId) return;

    async function loadMessages() {
      setIsLoadingHistory(true);
      try {
        const res = await fetch(`/api/messages?chatId=${chatId}`);
        const data = await res.json();
        if (res.ok) {
          setMessages(data.messages);
        }
      } catch (err) {
        console.error("Error al cargar mensajes:", err);
      } finally {
        setIsLoadingHistory(false);
      }
    }

    loadMessages();
  }, [ready, authenticated, chatId]);

  // -----------------------------
  // 2c. Guardar en storage
  // -----------------------------
  useEffect(() => {
    if (!authenticated) return;

    try {
      if (chatId) {
        window.sessionStorage.setItem(storageKeyChat, chatId);
      }
      if (messages.length) {
        window.sessionStorage.setItem(
          storageKeyMsgs,
          JSON.stringify(messages)
        );
      }
    } catch (e) {
      console.warn("No se pudo guardar en storage:", e);
    }
  }, [authenticated, chatId, messages, storageKeyChat, storageKeyMsgs]);

  // -----------------------------
  // Loading Privy
  // -----------------------------
  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <p className="text-sm text-slate-300">Cargando autenticación...</p>
      </main>
    );
  }

  // -----------------------------
  // Si no está autenticado
  // -----------------------------
  if (!authenticated) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <div className="text-center space-y-4">
          <p className="text-sm text-slate-300">
            Debes iniciar sesión para usar el chat de OPT-IA 3.
          </p>
          <button
            onClick={login}
            className="px-4 py-2 rounded bg-sky-500 hover:bg-sky-600 text-white text-sm font-medium"
          >
            Iniciar sesión con Privy
          </button>
        </div>
      </main>
    );
  }

  // -----------------------------
  // Enviar mensaje
  // -----------------------------
  async function handleSend(text: string) {
    if (!text.trim()) return;

    const userMessage = createMessage("user", text);
    setMessages((prev) => [...prev, userMessage]);
    setIsSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          chatId,
          clientId,
          userId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          createMessage(
            "assistant",
            data.error || "⚠️ Error desde el servidor."
          ),
        ]);
        return;
      }

      if (data.chatId && data.chatId !== chatId) {
        setChatId(data.chatId);
        window.sessionStorage.setItem(storageKeyChat, data.chatId);
      }

      setMessages((prev) => [
        ...prev,
        createMessage("assistant", data.reply),
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        createMessage(
          "assistant",
          "⚠️ Ocurrió un error al procesar tu mensaje."
        ),
      ]);
    } finally {
      setIsSending(false);
    }
  }

  // Nuevo chat
  function handleNewChat() {
    setChatId(null);
    setMessages([createMessage("assistant", GREETING)]);
    window.sessionStorage.removeItem(storageKeyChat);
    window.sessionStorage.removeItem(storageKeyMsgs);
  }

  // Cerrar sesión
  async function handleLogout() {
    try {
      window.sessionStorage.removeItem(storageKeyChat);
      window.sessionStorage.removeItem(storageKeyMsgs);
    } catch {}
    await logout();
    router.push("/");
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  return (
    <ChatLayout
      sidebar={
        <Sidebar
          currentChatId={chatId}
          onSelectChat={setChatId}
          onNewChat={handleNewChat}
          userId={userId}
        />
      }
      sidebarOpen={sidebarOpen}
    >
      {/* Barra superior interna del chat */}
      <div className="flex items-center justify-between mb-3 text-[11px] text-slate-400">
        {/* Bloque: 3 rayas + logo + título */}
        <div className="flex items-center gap-3">
          {/* Botón 3 rayas */}
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-1 rounded-full p-2 hover:bg-white/10 transition-colors text-slate-200 text-base"
          >
            ☰
          </button>

          {/* LOGO OPT-IA */}
          <Image
            src="/logo-opt.png"   // 👈 asegúrate de tener este archivo en /public
            alt="Logo OPT-IA"
            width={28}
            height={28}
            className="rounded-full"
          />

          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-100">
              OPT-IA
            </span>
            <span className="text-[12px] text-slate-500">
              Asistente para estudiantes y MyPEs
            </span>
          </div>
        </div>

        {/* 👤 Nombre del usuario + botón de logout */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-[10px] text-slate-500">
            {displayName}
          </span>
          <button
            onClick={handleLogout}
            className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700 text-[11px]"
          >
            Cerrar sesión
          </button>
        </div>
      </div>

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
