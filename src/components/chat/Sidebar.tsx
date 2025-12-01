// src/components/chat/Sidebar.tsx
"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";

interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
}

interface SidebarProps {
  currentChatId: string | null;
  onSelectChat: (chatId: string | null) => void;
  onNewChat: () => void;
  userId: string | null;
}

export function Sidebar({
  currentChatId,
  onSelectChat,
  onNewChat,
  userId,
}: SidebarProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // 🔄 Cargar chats SOLO si hay userId
  useEffect(() => {
    if (!userId) {
      setChats([]);
      return;
    }

    async function loadChats() {
      setIsLoading(true);
      try {
        const encoded = encodeURIComponent(userId ?? "");
        const res = await fetch(`/api/chats?userId=${encoded}`);
        const data = await res.json();

        if (res.ok) {
          setChats(data.chats ?? []);
        } else {
          console.error(data.error);
        }
      } catch (err) {
        console.error("Error al cargar chats:", err);
      } finally {
        setIsLoading(false);
      }
    }

    loadChats();
  }, [userId, currentChatId]);

  return (
    <div className="flex flex-col h-full">
      {/* BOTÓN NUEVO CHAT */}
      <button
        onClick={onNewChat}
        className="mb-4 w-full rounded-lg bg-sky-500 hover:bg-sky-600 text-sm font-medium py-2 transition"
      >
        + Nuevo chat
      </button>

      {/* LISTA DE CHATS */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {isLoading && (
          <div className="text-xs text-slate-400 mb-2">Cargando chats...</div>
        )}

        {!isLoading && userId && chats.length === 0 && (
          <p className="text-[11px] text-slate-500">
            Aún no hay chats guardados. Escribe un mensaje para crear el primero.
          </p>
        )}

        {!userId && (
          <p className="text-[11px] text-slate-500">
            Inicia sesión para ver tus chats.
          </p>
        )}

        {/* CHATS */}
        {chats.map((chat) => (
          <button
            key={chat.id}
            onClick={() => onSelectChat(chat.id)}
            className={clsx(
              "w-full text-left px-3 py-2 rounded-lg text-xs border border-slate-800 hover:bg-slate-800 transition",
              currentChatId === chat.id && "bg-slate-800 border-sky-500"
            )}
          >
            <div className="font-medium truncate">{chat.title}</div>
            <div className="text-[10px] text-slate-500">
              {new Date(chat.createdAt).toLocaleString()}
            </div>
          </button>
        ))}
      </div>

      <div className="pt-3 mt-3 border-t border-slate-800 text-[10px] text-slate-500">
        {/* Espacio para futuras opciones */}
      </div>
    </div>
  );
}
