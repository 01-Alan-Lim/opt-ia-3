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
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
}

export function Sidebar({
  currentChatId,
  onSelectChat,
  onNewChat,
}: SidebarProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);


  useEffect(() => {
    async function loadChats() {
      setIsLoading(true);
      try {
        const res = await fetch("/api/chats");
        const data = await res.json();
        if (res.ok) {
          setChats(data.chats);
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
  }, [currentChatId]);
















  return (
    <div className="flex flex-col h-full">
      <button
        onClick={onNewChat}
        className="mb-4 w-full rounded-lg bg-sky-500 hover:bg-sky-600 text-sm font-medium py-2 transition"
      >
        + Nuevo chat
      </button>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {isLoading && (
          <div className="text-xs text-slate-400 mb-2">Cargando chats...</div>
        )}
        {chats.map((chat) => (
          <button
            key={chat.id}
            onClick={() => onSelectChat(chat.id)}
            className={clsx(
              "w-full text-left px-3 py-2 rounded-lg text-xs bg-slate-800/40 hover:bg-slate-800 transition",
              {
                "border border-sky-500": chat.id === currentChatId,
              }
            )}
          >
            <div className="font-medium line-clamp-1">{chat.title}</div>
            <div className="text-[10px] text-slate-400">
              {new Date(chat.createdAt).toLocaleString()}
            </div>
          </button>
        ))}
        {chats.length === 0 && !isLoading && (
          <p className="text-[11px] text-slate-500">
            Aún no hay chats guardados. Escribe un mensaje para crear el
            primero.
          </p>
        )}
      </div>

      <div className="pt-3 mt-3 border-t border-slate-800 text-[10px] text-slate-500">
        OPT-IA 3 – Demo UI
      </div>
    </div>
  );
}
