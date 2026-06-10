"use client";

import * as React from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
} from "framer-motion";
import clsx from "clsx";

/* ── Types ────────────────────────────────────────────── */

export type PremiumTone = "amber" | "emerald" | "sky" | "violet" | "indigo";

export type PremiumInteractionCardProps = {
  title: string;
  description: string;
  eyebrow?: string;
  tone?: PremiumTone;
  children?: React.ReactNode;
  className?: string;
};

/* ── Tone styles (literal strings → detected by Tailwind) */

type ToneStyle = {
  border: string;
  bg: string;
  eyebrowText: string;
};

const TONE_STYLES: Record<PremiumTone, ToneStyle> = {
  amber: {
    border:      "border-amber-500/15",
    bg:          "bg-amber-500/5",
    eyebrowText: "text-amber-400",
  },
  emerald: {
    border:      "border-emerald-500/15",
    bg:          "bg-emerald-500/5",
    eyebrowText: "text-emerald-400",
  },
  sky: {
    border:      "border-sky-500/15",
    bg:          "bg-sky-500/5",
    eyebrowText: "text-sky-400",
  },
  violet: {
    border:      "border-violet-500/15",
    bg:          "bg-violet-500/5",
    eyebrowText: "text-violet-400",
  },
  indigo: {
    border:      "border-indigo-500/15",
    bg:          "bg-indigo-500/5",
    eyebrowText: "text-indigo-400",
  },
};

/* ── Variant (for framer-motion stagger propagation) ───── */

const FADE_UP = {
  hidden: { opacity: 0, y: 18 },
  show:   { opacity: 1, y: 0 },
};

/* ── Component ─────────────────────────────────────────── */

export function PremiumInteractionCard({
  title,
  description,
  eyebrow,
  tone = "sky",
  children,
  className,
}: PremiumInteractionCardProps) {
  const shouldReduce = useReducedMotion();
  const ref = React.useRef<HTMLDivElement | null>(null);

  /* Spring-driven pointer position (normalized -0.5..0.5) */
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 200, damping: 28, mass: 0.5 });
  const sy = useSpring(my, { stiffness: 200, damping: 28, mass: 0.5 });

  /* Tilt — zero range when reduced motion */
  const tiltRange = shouldReduce ? ([0, 0] as [number, number]) : ([-5, 5] as [number, number]);
  const rotateX = useTransform(sy, [-0.5, 0.5], [tiltRange[1], tiltRange[0]]);
  const rotateY = useTransform(sx, [-0.5, 0.5], [tiltRange[0], tiltRange[1]]);

  const tone_ = TONE_STYLES[tone];

  const onMouseMove = (e: React.MouseEvent) => {
    if (shouldReduce) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    mx.set(px - 0.5);
    my.set(py - 0.5);
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
  };

  const onMouseLeave = () => {
    mx.set(0);
    my.set(0);
    const el = ref.current;
    if (el) {
      el.style.setProperty("--mx", "50%");
      el.style.setProperty("--my", "50%");
    }
  };

  return (
    <motion.div
      ref={ref}
      variants={FADE_UP}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      whileHover={shouldReduce ? undefined : { scale: 1.014 }}
      transition={{ type: "spring", stiffness: 260, damping: 22 }}
      style={{
        transformStyle: "preserve-3d",
        rotateX,
        rotateY,
      }}
      className={clsx(
        "relative rounded-[28px] border p-6 will-change-transform",
        "magnetic-glow",
        tone_.border,
        tone_.bg,
        className,
      )}
    >
      {eyebrow && (
        <div className={clsx("text-xs font-semibold mb-2", tone_.eyebrowText)}>
          {eyebrow}
        </div>
      )}
      <h2 className="text-base font-semibold text-slate-200">{title}</h2>
      <p className="mt-1 text-xs text-slate-500 leading-relaxed">{description}</p>
      {children != null && <div className="mt-5">{children}</div>}
    </motion.div>
  );
}
