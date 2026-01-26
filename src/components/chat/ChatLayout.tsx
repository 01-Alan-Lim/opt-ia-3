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
        "h-screen overflow-hidden flex flex-col",
        "bg-gradient-to-br from-[#05060a] via-[#090b11] to-[#05060a] text-slate-100"
      )}
    >
      <section className="flex-1 flex overflow-hidden px-4 py-3 gap-3">
        {/* Sidebar */}
        <aside
          className={clsx(
            "hidden md:flex flex-col shrink-0 transition-all duration-300",
            sidebarOpen ? "w-72" : "w-0"
          )}
        >
          <div className="h-full rounded-2xl border border-white/10 bg-white/5 backdrop-blur-2xl shadow-xl overflow-hidden">
            {/* 👇 aquí el sidebar puede scrollear internamente */}
            <div className="h-full overflow-y-auto">{sidebarOpen && sidebar}</div>
          </div>
        </aside>

        {/* Chat */}
        <div className="flex-1 min-w-0 flex">
          <div
            className={clsx(
              "flex-1 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-2xl shadow-2xl",
              "flex flex-col px-6 py-4 overflow-hidden"
            )}
          >
            {/* Contenedor interno con min-h-0 para que MessageList scrollee bien */}
            <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
              {children}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
