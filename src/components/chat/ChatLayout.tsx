//src/components/chat/ChatLayout.tsx

"use client";

import { ReactNode } from "react";
import clsx from "clsx";

interface ChatLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  sidebarOpen: boolean;
  onCloseSidebar?: () => void;
}

export function ChatLayout({ sidebar, children, sidebarOpen, onCloseSidebar }: ChatLayoutProps) {
  return (
    <main
      className={clsx(
        "h-screen overflow-hidden flex flex-col",
        "bg-gradient-to-br",
        "from-[var(--app-bg-from)] via-[var(--app-bg-via)] to-[var(--app-bg-to)]",
        "text-[color:var(--foreground)]"
      )}
    >
      <section className="flex-1 flex overflow-hidden px-4 py-3 gap-3">
        {/* =========================
            Mobile drawer (md:hidden)
           ========================= */}
        <div className={clsx("md:hidden", sidebarOpen ? "block" : "hidden")}>
          {/* overlay */}
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={onCloseSidebar}
            aria-hidden="true"
          />
          {/* panel */}
          <aside
            className={clsx(
              "fixed z-50 top-0 left-0 h-full w-[85vw] max-w-[320px]",
              "border-r shadow-2xl",
              "border-[color:var(--border)] bg-[color:var(--background)]",
              "transition-transform duration-300",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="h-full overflow-hidden">
              <div className="flex items-center justify-between px-3 py-3 border-b border-[color:var(--border)]">
                <span className="text-xs font-semibold text-[color:var(--foreground)]">Historial</span>
                <button
                  type="button"
                  onClick={onCloseSidebar}
                  className="rounded-full px-2 py-1 hover:bg-[color:var(--surface)]"
                  aria-label="Cerrar historial"
                >
                  ☰
                </button>
              </div>

              <div className="h-[calc(100%-48px)] px-3 py-3 overflow-y-auto">{sidebar}</div>
            </div>
          </aside>
        </div>

        {/* =========================
            Desktop sidebar (md+)
           ========================= */}
        <aside
          className={clsx(
            "hidden md:flex flex-col shrink-0 transition-all duration-300",
            sidebarOpen ? "w-72" : "w-0"
          )}
        >
          <div className="h-full rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface)] backdrop-blur-2xl shadow-xl overflow-hidden">
            <div className="h-full px-3 py-3">{sidebarOpen && sidebar}</div>
          </div>
        </aside>

        {/* Chat (panel tipo docente: blur + glow) */}
        <div className="flex-1 min-w-0 flex">
          <div
            className={clsx(
              "flex-1",
              "relative overflow-hidden",
              "rounded-3xl",
              "border border-[color:var(--border)]",
              "bg-[color:var(--surface)]",
              "shadow-xl",
              "flex flex-col overflow-hidden"
            )}
          >
            <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-hidden px-5 pt-5 pb-0">
              {children}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}