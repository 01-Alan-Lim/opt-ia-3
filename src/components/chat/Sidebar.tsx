// src/components/chat/Sidebar.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { supabase } from "@/lib/supabaseClient";

type ChatMode = "general" | "plan_mejora";

type ChatItem = {
  id: string;
  title: string | null;
  mode: ChatMode;
  updated_at?: string | null;
};

interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  mode?: ChatMode;
  pinned?: boolean;
}

interface SidebarProps {
  currentChatId: string | null;
  onSelectChat: (chatId: string | null, mode?: ChatMode) => void;
  onNewChat: () => void;
}

export function Sidebar({ currentChatId, onSelectChat, onNewChat }: SidebarProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // menú de 3 puntos abierto
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  // renombrar inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // confirmación eliminar
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const openItemRef = useRef<HTMLDivElement | null>(null);

    const refreshChats = async (): Promise<ChatSummary[]> => {
      setIsLoading(true);
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;

        if (!token) {
          setChats([]);
          return [];
        }

        const res = await fetch("/api/chats", {
          headers: { Authorization: `Bearer ${token}` },
        });

        const json = await res.json().catch(() => null);

        if (!res.ok || json?.ok === false) {
          console.error("Sidebar loadChats failed:", { status: res.status, body: json });
          setChats([]);
          return []; // ✅ antes: return;
        }

        const list = json?.data?.chats ?? json?.chats ?? [];
        const normalized: ChatSummary[] = Array.isArray(list) ? list : [];

        setChats(normalized);
        return normalized; // ✅ CLAVE: ahora SIEMPRE devuelve lista
      } catch (err) {
        console.error("Sidebar loadChats error:", err);
        setChats([]);
        return [];
      } finally {
        setIsLoading(false);
      }
    };

  useEffect(() => {
    refreshChats();
    // refrescar cuando cambias de chat seleccionado (útil porque pin/rename/delete cambian UI)
  }, [currentChatId]);

  // -----------------------------
  // API helpers (evitan tu error)
  // -----------------------------
  async function apiPatchChat(chatId: string, patch: { title?: string; pinned?: boolean }) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("NO_TOKEN");

    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(patch),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.message || "PATCH_FAILED");
    }
    return json?.data ?? json;
  }

  async function apiDeleteChatFromList(chatId: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("NO_TOKEN");

    const res = await fetch(`/api/chats/${chatId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.message || "DELETE_FAILED");
    }
    return json?.data ?? json;
  }

  // -----------------------------
  // Acciones UI
  // -----------------------------
  function startRename(chat: ChatSummary) {
    setEditingId(chat.id);
    setDraftTitle(chat.title ?? "");
    setMenuOpenFor(null);
    // focus al siguiente tick
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function commitRename(chatId: string) {
    const next = draftTitle.trim();
    setEditingId(null);

    if (!next) return;

    try {
      await apiPatchChat(chatId, { title: next });
      await refreshChats();
    } catch (e) {
      console.error(e);
      await refreshChats();
    }
  }

  async function togglePinned(chat: ChatSummary) {
    try {
      await apiPatchChat(chat.id, { pinned: !Boolean(chat.pinned) });
      setMenuOpenFor(null);
      await refreshChats();
    } catch (e) {
      console.error(e);
    }
  }

  async function confirmDelete(chatId: string) {
    try {
      await apiDeleteChatFromList(chatId);

      setConfirmDeleteId(null);
      setMenuOpenFor(null);

      const nextList = await refreshChats();

      // si borraste el chat activo, salta al primero disponible (si existe)
      if (currentChatId === chatId) {
        const next = nextList.find((c) => c.id !== chatId) ?? null;
        if (next) onSelectChat(next.id, next.mode);
        else onSelectChat(null, "general");
      }

    } catch (e) {
      console.error(e);
    }
  }

  // Cerrar menú al clickear fuera (simple)
  useEffect(() => {
    function onPointerDownCapture(e: PointerEvent) {
      // si no hay menú abierto, no hacemos nada
      if (!menuOpenFor) return;

      const target = e.target as Node | null;
      const root = openItemRef.current;

      // si el click fue dentro del item que tiene el menú abierto → NO cerrar
      if (root && target && root.contains(target)) return;

      // si fue fuera → cerrar
      setMenuOpenFor(null);
      setConfirmDeleteId(null);
    }

    document.addEventListener("pointerdown", onPointerDownCapture, true); // ← CAPTURE
    return () => document.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [menuOpenFor]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <button
        onClick={onNewChat}
        className="sticky top-0 z-20 mb-4 w-full rounded-lg bg-sky-500 hover:bg-sky-600 text-sm font-medium py-2 transition"
      >
        + Nuevo chat
      </button>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
        {isLoading && <div className="text-xs text-slate-400 mb-2">Cargando chats...</div>}

        {!isLoading && chats.length === 0 && (
          <p className="text-[11px] text-slate-500">
            Aún no hay chats guardados. Escribe un mensaje para crear el primero.
          </p>
        )}

        {chats.map((chat) => {
          const isActive = currentChatId === chat.id;

          return (
            <div
              key={chat.id}
              ref={(el) => {
                if (menuOpenFor === chat.id) openItemRef.current = el;
              }}
              className={clsx(
                "group relative w-full rounded-lg border border-slate-800 transition",
                isActive ? "bg-slate-800 border-sky-500" : "hover:bg-slate-800"
              )}
            >
              <button
                onClick={() => onSelectChat(chat.id, chat.mode)}
                className="w-full text-left px-3 py-2 rounded-lg"
              >
                <div className="flex items-center gap-2">
                  {chat.pinned && <span className="text-[12px]">📌</span>}

                  {/* Título */}
                  {editingId === chat.id ? (
                    <input
                      ref={inputRef}
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(chat.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => commitRename(chat.id)}
                      className="w-full bg-slate-900/40 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 outline-none"
                    />
                  ) : (
                    <div className="font-medium truncate text-xs text-slate-100">{chat.title}</div>
                  )}
                </div>

              </button>

              {/* 3 puntos: solo hover o activo */}
              <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteId(null);
                    setMenuOpenFor((prev) => (prev === chat.id ? null : chat.id));
                  }}
                  className={clsx(
                    "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
                    "h-5 w-8 flex items-center justify-center",
                    "text-slate-100 hover:bg-white/15",
                    "text-base leading-none",
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  title="Opciones"
                >
                  ⋯
              </button>

              {/* Menú */}
              {menuOpenFor === chat.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-2 top-9 z-[999] w-48 rounded-xl border border-slate-700 bg-slate-900 shadow-lg p-1"
                >
                  {/* Renombrar */}
                  <button
                    className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-white/10"
                    onClick={() => startRename(chat)}
                  >
                    Cambiar nombre
                  </button>

                  {/* Pin */}
                  <button
                    className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-white/10"
                    onClick={() => togglePinned(chat)}
                  >
                    {chat.pinned ? "No fijar" : "Fijar"}
                  </button>

                  {/* Eliminar */}
                  <button
                    className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-red-500/15 text-red-300"
                    onClick={() => setConfirmDeleteId(chat.id)}
                  >
                    Eliminar
                  </button>

                  {/* Confirmación pequeña */}
                  {confirmDeleteId === chat.id && (
                    <div className="mt-1 rounded-lg border border-slate-700 bg-slate-950 p-2">
                      <div className="text-[11px] text-slate-200 mb-2">
                        ¿Eliminar este chat de la lista?
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="flex-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] py-1"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancelar
                        </button>
                        <button
                          className="flex-1 rounded bg-red-600 hover:bg-red-500 text-[11px] py-1 text-white"
                          onClick={() => confirmDelete(chat.id)}
                        >
                          Eliminar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="pt-3 mt-3 border-t border-slate-800 text-[10px] text-slate-500" />
    </div>
  );
}
