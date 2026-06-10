"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type Spark = { id: number; x: number; y: number };

export type ClickSparkLiteProps = {
  children:   React.ReactNode;
  className?: string;
  /** Color del aro del spark (rgba/hex). */
  color?:     string;
};

/**
 * Spark radial breve al hacer click, AISLADO al área que envuelve.
 * Sin canvas ni librerías pesadas; sólo framer-motion.
 * La capa de sparks es pointer-events-none, así no bloquea clicks.
 * Respeta prefers-reduced-motion (no emite sparks).
 */
export function ClickSparkLite({
  children,
  className,
  color = "rgba(125,211,252,0.8)",
}: ClickSparkLiteProps) {
  const shouldReduce = useReducedMotion();
  const ref   = React.useRef<HTMLDivElement | null>(null);
  const idRef = React.useRef(0);
  const [sparks, setSparks] = React.useState<Spark[]>([]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (shouldReduce) return;
    const el = ref.current;
    if (!el) return;
    const r  = el.getBoundingClientRect();
    const id = idRef.current++;
    const x  = e.clientX - r.left;
    const y  = e.clientY - r.top;
    setSparks((prev) => [...prev, { id, x, y }]);
    window.setTimeout(() => {
      setSparks((prev) => prev.filter((s) => s.id !== id));
    }, 600);
  };

  return (
    <div ref={ref} onPointerDown={onPointerDown} className={className}>
      {children}

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <AnimatePresence>
          {sparks.map((sp) => (
            <motion.span
              key={sp.id}
              initial={{ opacity: 0.7, scale: 0 }}
              animate={{ opacity: 0, scale: 2.6 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
              style={{
                position:     "absolute",
                left:         sp.x,
                top:          sp.y,
                width:        24,
                height:       24,
                marginLeft:   -12,
                marginTop:    -12,
                borderRadius: "9999px",
                border:       `2px solid ${color}`,
                boxShadow:    "0 0 12px rgba(56,189,248,0.55)",
              }}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
