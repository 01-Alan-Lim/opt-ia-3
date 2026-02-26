"use client";

import * as React from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import clsx from "clsx";

type Props = {
  className?: string;
  children: React.ReactNode;
  strength?: number; // 0..1
  glow?: boolean;
  hoverScale?: number; // e.g. 1.01
};

export function MagneticCard({
  className,
  children,
  strength = 0.55,
  glow = true,
  hoverScale = 1.012,
}: Props) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  // pointer relative position
  const mx = useMotionValue(0);
  const my = useMotionValue(0);

  const sx = useSpring(mx, { stiffness: 220, damping: 26, mass: 0.6 });
  const sy = useSpring(my, { stiffness: 220, damping: 26, mass: 0.6 });

  // subtle tilt
  const rotateX = useTransform(sy, [-0.5, 0.5], [6 * strength, -6 * strength]);
  const rotateY = useTransform(sx, [-0.5, 0.5], [-8 * strength, 8 * strength]);

  // subtle translate
  const tx = useTransform(sx, [-0.5, 0.5], [-6 * strength, 6 * strength]);
  const ty = useTransform(sy, [-0.5, 0.5], [-6 * strength, 6 * strength]);

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width; // 0..1
    const py = (e.clientY - r.top) / r.height; // 0..1
    mx.set(px - 0.5);
    my.set(py - 0.5);

    // for CSS glow
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
  };

  const onLeave = () => {
    mx.set(0);
    my.set(0);
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--mx", `50%`);
    el.style.setProperty("--my", `50%`);
  };

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      whileHover={{ scale: hoverScale }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      style={{
        transformStyle: "preserve-3d",
        rotateX,
        rotateY,
        x: tx,
        y: ty,
      }}
      className={clsx("relative will-change-transform transition-transform", glow && "magnetic-glow", className)}
    >
      {children}
    </motion.div>
  );
}