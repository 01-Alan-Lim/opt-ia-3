// src/components/chat/MessageList.tsx

"use client";

import { useEffect, useRef } from "react";
import { Message } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto border border-slate-800 rounded-xl p-4 mb-4 bg-slate-950/40">
      {messages.length === 0 ? (
        <p className="text-slate-500 text-sm">
          Aún no hay mensajes. Envía tu primera consulta a OPT-IA 3.
        </p>
      ) : (
        messages.map((m) => <MessageBubble key={m.id} message={m} />)
      )}
      <div ref={bottomRef} />
    </div>
  );
}
