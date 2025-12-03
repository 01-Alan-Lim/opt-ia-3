"use client";

import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import Image from "next/image";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { Message } from "@/lib/types";

type ChatMode = "general" | "plan_mejora";

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
  // ✅ Hooks básicos
  const { ready, authenticated, user, logout } = usePrivy();
  const router = useRouter();

  // Id directo de Privy
  const userId = user?.id ?? null;

  // 🔑 ID estable para backend y storage
  const clientId = user?.id || user?.email?.address || "anon";

  // 👤 Nombre “bonito”
  // @ts-ignore depende del proveedor
  const displayName =
    user?.google?.name ||
    // @ts-ignore
    user?.github?.name ||
    user?.email?.address?.split("@")[0] ||
    "Usuario";

  // STORAGE por usuario
  const storageKeyChat = `optia-chat-id-${clientId}`;
  const storageKeyMsgs = `optia-messages-${clientId}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 👇 Modo del agente
  const [mode, setMode] = useState<ChatMode>("general");


  // -----------------------------
  // Redirect si no está autenticado
  // -----------------------------
  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
    }
  }, [ready, authenticated, router]);

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
  // Loading Privy / estado intermedio
  // -----------------------------
  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <p className="text-sm text-slate-300">Cargando autenticación...</p>
      </main>
    );
  }

  if (!authenticated) {
    // mientras hace router.replace("/") no mostramos nada
    return null;
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
      // ------------------------------------------
      // 🚨 1. MODO PLAN DE MEJORA → /api/plans/review
      // ------------------------------------------
      if (mode === "plan_mejora") {
        const res = await fetch("/api/plans/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            userId,
            email: user?.email?.address ?? null,
            chatId,
          }),
        });

        const data = await res.json();

                if (data.chatId && data.chatId !== chatId) {
          setChatId(data.chatId);
          window.sessionStorage.setItem(storageKeyChat, data.chatId);
        }


        if (!res.ok) {
          setMessages((prev) => [
            ...prev,
            createMessage(
              "assistant",
              data.error || "Hubo un problema al revisar el plan."
            ),
          ]);
          return;
        }

        // Construimos feedback estructurado
        let feedbackText = `Aquí tienes la revisión del plan (versión ${
          data.version ?? "1"
        }):\n\n`;

        if (Array.isArray(data.sections)) {
          for (const section of data.sections) {
            feedbackText += `🟦 *${String(
              section.section
            ).toUpperCase()}*\n${section.feedback}\n\n`;
          }
        } else if (data.feedback) {
          // Respaldo por si el endpoint devuelve solo un texto plano
          feedbackText += data.feedback;
        }

        setMessages((prev) => [
          ...prev,
          createMessage("assistant", feedbackText),
        ]);

        return; // 👈 no seguimos al modo normal
      }

      // ------------------------------------------
      // 🚀 2. MODO NORMAL → /api/chat
      // ------------------------------------------
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          chatId,
          clientId,
          userId,
          mode, // aquí suele ser "general"
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

    // ---------------------------------------------
  // Subir archivo Word/PDF y enviar a revisión
  // ---------------------------------------------
  async function handleUploadPlanFile(file: File) {
    if (!file) return;
    if (!userId) {
      setMessages((prev) => [
        ...prev,
        createMessage(
          "assistant",
          "Debes iniciar sesión para subir y revisar un plan de mejora."
        ),
      ]);
      return;
    }

    // Mensaje temporal en el chat
    setMessages((prev) => [
      ...prev,
      createMessage(
        "assistant",
        `📄 Recibí el archivo "${file.name}". Estoy extrayendo el texto y revisando el plan...`
      ),
    ]);
    setIsSending(true);

    try {
      // 1) Subir archivo y extraer texto
      const formData = new FormData();
      formData.append("file", file);
      formData.append("userId", userId);
      if (user?.email?.address) {
        formData.append("email", user.email.address);
      }
      if (chatId) {
        formData.append("chatId", chatId);
      }

      const uploadRes = await fetch("/api/plans/upload", {
        method: "POST",
        body: formData,
      });

      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) {
        setMessages((prev) => [
          ...prev,
          createMessage(
            "assistant",
            uploadData.error ||
              "No se pudo procesar el archivo. Verifica que sea PDF o Word (.docx)."
          ),
        ]);
        return;
      }

      const planText: string = uploadData.text;

      // 2) Enviar el texto extraído a /api/plans/review
      const reviewRes = await fetch("/api/plans/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: planText,
          userId,
          email: user?.email?.address ?? null,
          chatId,
          fileName: file.name, 
        }),
      });

      const reviewData = await reviewRes.json();

      if (reviewData.chatId && reviewData.chatId !== chatId) {
        setChatId(reviewData.chatId);
        window.sessionStorage.setItem(storageKeyChat, reviewData.chatId);
      }


      if (!reviewRes.ok) {
        setMessages((prev) => [
          ...prev,
          createMessage(
            "assistant",
            reviewData.error || "Hubo un problema al revisar el plan."
          ),
        ]);
        return;
      }

      // 3) Mostrar feedback estructurado
      let feedbackText = `✅ He revisado el archivo "${file.name}". Esta es la evaluación del plan (versión ${reviewData.version}):\n\n`;

      for (const section of reviewData.sections || []) {
        feedbackText += `🟦 *${String(section.section).toUpperCase()}*\n${section.feedback}\n\n`;
      }

      setMessages((prev) => [
        ...prev,
        createMessage("assistant", feedbackText),
      ]);
    } catch (e) {
      console.error("Error en handleUploadPlanFile:", e);
      setMessages((prev) => [
        ...prev,
        createMessage(
          "assistant",
          "⚠️ Ocurrió un error al procesar el archivo de plan de mejora."
        ),
      ]);
    } finally {
      setIsSending(false);
    }
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
            src="/logo-opt.png"
            alt="Logo OPT-IA"
            width={28}
            height={28}
            className="rounded-full"
          />

          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-100">
              OPT-IA
            </span>
            <span className="text-[11px] text-slate-500">
              Asistente para estudiantes y MyPEs
            </span>
          </div>
        </div>

        {/* 👤 Nombre del usuario + botón de logout */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-[14px] text-slate-500">
            {displayName}
          </span>
          <button
            onClick={handleLogout}
            className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700 text-[14px]"
          >
            Cerrar sesión
          </button>
        </div>
      </div>

      {/* Selector de modo de agente */}
      <div className="mb-0 flex flex-wrap gap-2 text-[11px]">
        <span className="text-slate-500 mt-1 mr-2">Modo del asistente:</span>

        {/* Asistente general */}
        <button
          type="button"
          onClick={() => {
            if (mode === "general") return;
            setMode("general");
            handleNewChat();
          }}
          className={`px-3 py-1 rounded-full border text-xs transition ${
            mode === "general"
              ? "bg-sky-600 border-sky-500 text-white"
              : "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Asistente general
        </button>

        {/* Asesor de Plan de Mejora */}
        <button
          type="button"
          onClick={() => {
            if (mode === "plan_mejora") return;
            setMode("plan_mejora");
            handleNewChat();
          }}
          className={`px-3 py-1 rounded-full border text-xs transition ${
            mode === "plan_mejora"
              ? "bg-sky-600 border-sky-500 text-white"
              : "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
        >
          Asesor de Plan de Mejora
        </button>
      </div>


      <MessageList messages={messages} />
      <MessageInput
        onSend={handleSend}
        disabled={isSending}
        onUploadFile={mode === "plan_mejora" ? handleUploadPlanFile : undefined} 
      />

      {(isSending || isLoadingHistory) && (
        <p className="mt-2 text-[10px] text-slate-400">
          {isSending
            ? "OPT-IA 3 está pensando..."
            : "Cargando historial del chat..."}
        </p>
      )}
    </ChatLayout>
  );
}
