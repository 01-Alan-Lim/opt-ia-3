"use client";

import * as React from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
} from "framer-motion";
import { cn } from "@/lib/utils";

export type InteractiveTiltCardProps = {
  children:   React.ReactNode;
  className?: string;
  /** Color del spotlight radial que sigue al cursor (rgba). */
  glowColor?: string;
  /** Color del borde luminoso en hover (rgba). */
  borderColor?: string;
  /** Grados máximos de inclinación 3D. */
  tiltMax?:   number;
};

/**
 * Tarjeta premium con:
 *  - tilt 3D sutil reaccionando al puntero,
 *  - spotlight radial que sigue al cursor,
 *  - borde luminoso + lift en hover.
 * Respeta prefers-reduced-motion (se desactiva el movimiento).
 */
export function InteractiveTiltCard({
  children,
  className,
  glowColor   = "rgba(56,189,248,0.16)",
  borderColor = "rgba(125,211,252,0.35)",
  tiltMax     = 6,
}: InteractiveTiltCardProps) {
  const shouldReduce = useReducedMotion();
  const ref = React.useRef<HTMLDivElement | null>(null);

  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 220, damping: 26, mass: 0.5 });
  const sy = useSpring(my, { stiffness: 220, damping: 26, mass: 0.5 });

  const rotateX = useTransform(sy, [-0.5, 0.5], [tiltMax, -tiltMax]);
  const rotateY = useTransform(sx, [-0.5, 0.5], [-tiltMax, tiltMax]);

  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r  = el.getBoundingClientRect();
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
  };

  return (
    <motion.div
      ref={ref}
      onMouseMove={shouldReduce ? undefined : onMouseMove}
      onMouseLeave={shouldReduce ? undefined : onMouseLeave}
      whileHover={shouldReduce ? undefined : { y: -6 }}
      transition={{ type: "spring", stiffness: 260, damping: 22 }}
      style={
        shouldReduce
          ? undefined
          : { transformStyle: "preserve-3d", rotateX, rotateY }
      }
      className={cn(
        "group relative overflow-hidden rounded-2xl border will-change-transform",
        className,
      )}
    >
      {/* Spotlight radial siguiendo el cursor */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(240px circle at var(--mx,50%) var(--my,50%), ${glowColor}, transparent 70%)`,
        }}
      />
      {/* Borde luminoso en hover */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ boxShadow: `inset 0 0 0 1px ${borderColor}` }}
      />
      <div className="relative">{children}</div>
    </motion.div>
  );
}
