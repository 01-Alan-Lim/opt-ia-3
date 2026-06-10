"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export type PremiumInfoTone = "sky" | "violet" | "emerald" | "amber";

type ToneStyle = {
  eyebrow:  string;
  dot:      string;
  iconWrap: string;
  glow:     string; // rgba para el spotlight radial
  ring:     string; // rgba para el borde luminoso en hover
};

const TONE: Record<PremiumInfoTone, ToneStyle> = {
  sky: {
    eyebrow:  "text-sky-300",
    dot:      "bg-sky-400/70",
    iconWrap: "border-sky-500/25 bg-sky-500/10 text-sky-300",
    glow:     "rgba(56,189,248,0.18)",
    ring:     "rgba(56,189,248,0.5)",
  },
  violet: {
    eyebrow:  "text-violet-300",
    dot:      "bg-violet-400/70",
    iconWrap: "border-violet-500/25 bg-violet-500/10 text-violet-300",
    glow:     "rgba(167,139,250,0.18)",
    ring:     "rgba(167,139,250,0.5)",
  },
  emerald: {
    eyebrow:  "text-emerald-300",
    dot:      "bg-emerald-400/70",
    iconWrap: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    glow:     "rgba(52,211,153,0.18)",
    ring:     "rgba(52,211,153,0.5)",
  },
  amber: {
    eyebrow:  "text-amber-300",
    dot:      "bg-amber-400/70",
    iconWrap: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    glow:     "rgba(251,191,36,0.18)",
    ring:     "rgba(251,191,36,0.5)",
  },
};

export type PremiumInfoCardProps = {
  title:        string;
  tone:         PremiumInfoTone;
  eyebrow?:     string;
  description?: string;
  bullets?:     string[];
  icon?:        React.ReactNode;
  compact?:     boolean;
  className?:   string;
};

/**
 * Card premium con contenido SIEMPRE visible (sin flip).
 * Hover: lift + scale sutil + borde luminoso + spotlight radial que sigue
 * al cursor. Respeta prefers-reduced-motion (sin movimiento ni spotlight).
 */
export function PremiumInfoCard({
  title,
  tone,
  eyebrow,
  description,
  bullets,
  icon,
  compact = false,
  className,
}: PremiumInfoCardProps) {
  const shouldReduce = useReducedMotion();
  const t = TONE[tone];
  const ref = React.useRef<HTMLDivElement | null>(null);

  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  return (
    <motion.div
      ref={ref}
      onMouseMove={shouldReduce ? undefined : onMouseMove}
      whileHover={shouldReduce ? undefined : { y: -8, scale: 1.015 }}
      transition={{ type: "spring", stiffness: 260, damping: 22 }}
      className={cn(
        "group relative h-full overflow-hidden rounded-[24px] border border-white/10",
        "bg-gradient-to-b from-white/[0.06] to-white/[0.02]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]",
        compact ? "p-5" : "p-6 lg:p-7",
        className,
      )}
    >
      {/* Spotlight radial siguiendo el cursor */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(280px circle at var(--mx,50%) var(--my,50%), ${t.glow}, transparent 70%)`,
        }}
      />
      {/* Borde luminoso en hover */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[24px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ boxShadow: `inset 0 0 0 1px ${t.ring}` }}
      />

      <div className="relative flex h-full flex-col">
        {icon && (
          <div
            className={cn(
              "mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border",
              t.iconWrap,
            )}
          >
            {icon}
          </div>
        )}

        {eyebrow && (
          <div className={cn("text-xs font-semibold mb-2", t.eyebrow)}>{eyebrow}</div>
        )}

        <h3
          className={cn(
            "font-bold text-slate-100",
            compact ? "text-sm" : "text-lg",
          )}
        >
          {title}
        </h3>

        {description && (
          <p
            className={cn(
              "text-slate-400 leading-relaxed",
              compact ? "mt-1 text-xs" : "mt-2 text-sm",
            )}
          >
            {description}
          </p>
        )}

        {bullets && bullets.length > 0 && (
          <ul className="mt-5 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-sm text-slate-300">
                <span
                  className={cn("mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full", t.dot)}
                  aria-hidden
                />
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
    </motion.div>
  );
}
