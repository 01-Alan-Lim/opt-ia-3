"use client";

import { ReactNode } from "react";
import clsx from "clsx";

interface ChatLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  sidebarOpen: boolean;
}

export function ChatLayout({ sidebar, children, sidebarOpen }: ChatLayoutProps) {
  return (
    <main
      className={clsx(
        "min-h-screen flex flex-col",
        "bg-gradient-to-br from-[#05060a] via-[#090b11] to-[#05060a] text-slate-100"
      )}
    >
      {/* 👇 Sin barra superior: solo layout principal */}
      <section className="flex-1 flex overflow-hidden px-4 py-3 gap-3">
        {/* Sidebar historial */}
        <aside
          className={clsx(
            "hidden md:flex flex-col transition-all duration-300",
            sidebarOpen ? "w-64" : "w-0"
          )}
        >
          <div className="flex-1 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-2xl shadow-xl overflow-hidden">
            {sidebarOpen && sidebar}
          </div>
        </aside>

        {/* Área del chat */}
        <div className="flex-1 flex">
          <div
            className={clsx(
              "flex-1 rounded-2xl border border-white/10 bg-white/5",
              "backdrop-blur-2xl shadow-2xl flex flex-col px-6 py-4",
              "max-h-[calc(100vh-2rem)] min-h-[420px]"
            )}
          >
            <div className="flex flex-1 flex-col min-h-0 gap-4 overflow-hidden">
              {children}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
