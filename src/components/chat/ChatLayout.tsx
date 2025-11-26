// src/components/chat/ChatLayout.tsx

import { ReactNode } from "react";

interface ChatLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function ChatLayout({ sidebar, children }: ChatLayoutProps) {
  return (
    <main className="min-h-screen flex flex-col bg-slate-900 text-slate-100">
      <header className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h1 className="font-semibold">OPT-IA 3 – Panel de chat</h1>
        <span className="text-xs text-slate-400">Versión en desarrollo</span>
      </header>

      <section className="flex-1 flex">
        {/* Sidebar */}
        <aside className="hidden md:block w-64 border-r border-slate-800 p-4 text-sm">
          {sidebar}
        </aside>

        {/* Área principal */}
        <div className="flex-1 flex flex-col p-4">{children}</div>
      </section>
    </main>
  );
}
