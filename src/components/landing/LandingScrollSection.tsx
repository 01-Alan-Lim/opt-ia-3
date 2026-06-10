"use client";

import * as React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/* Variantes reutilizables para listas/grids con aparición escalonada.
   El contenedor orquesta el stagger; cada hijo usa staggerChild. */
export const staggerParent: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.1, delayChildren: 0.04 } },
};

export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 24 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
};

export type LandingScrollSectionProps = {
  children:   React.ReactNode;
  className?: string;
  id?:        string;
  delay?:     number;
  /** Animar también un blur de entrada (8px → 0). Default true. */
  blur?:      boolean;
  as?:        "section" | "div";
};

/**
 * Wrapper de reveal al hacer scroll:
 *   opacity 0 → 1, y 40 → 0, blur 8px → 0
 * whileInView, una sola vez, con margen "-80px".
 * Respeta prefers-reduced-motion (render estático, sin animación).
 */
export function LandingScrollSection({
  children,
  className,
  id,
  delay = 0,
  blur = true,
  as = "section",
}: LandingScrollSectionProps) {
  const shouldReduce = useReducedMotion();

  if (shouldReduce) {
    const Tag = as;
    return (
      <Tag id={id} className={className}>
        {children}
      </Tag>
    );
  }

  const MotionTag = as === "section" ? motion.section : motion.div;

  return (
    <MotionTag
      id={id}
      className={cn(className)}
      initial={{ opacity: 0, y: 72, scale: 0.96, filter: blur ? "blur(12px)" : "blur(0px)" }}
      whileInView={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.75, ease: EASE, delay }}
    >
      {children}
    </MotionTag>
  );
}
