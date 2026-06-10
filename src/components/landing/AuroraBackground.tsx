"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import clsx from "clsx";

export type AuroraBackgroundProps = {
  className?: string;
};

export function AuroraBackground({ className }: AuroraBackgroundProps) {
  const shouldReduce = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className={clsx(
        "absolute inset-0 overflow-hidden pointer-events-none select-none",
        className,
      )}
    >
      {/* Sky/cyan orb — top-left */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: "min(72vw, 720px)",
          height: "min(50vh, 480px)",
          left: "-8%",
          top: "-5%",
          background:
            "radial-gradient(ellipse at center, rgba(56,189,248,0.22) 0%, rgba(14,165,233,0.09) 46%, transparent 72%)",
          filter: "blur(52px)",
        }}
        animate={
          shouldReduce
            ? undefined
            : { x: [0, 28, -14, 0], y: [0, -18, 12, 0], scale: [1, 1.07, 0.97, 1] }
        }
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Indigo orb — top-right */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: "min(58vw, 620px)",
          height: "min(44vh, 420px)",
          right: "-6%",
          top: "8%",
          background:
            "radial-gradient(ellipse at center, rgba(99,102,241,0.20) 0%, rgba(79,70,229,0.08) 48%, transparent 72%)",
          filter: "blur(56px)",
        }}
        animate={
          shouldReduce
            ? undefined
            : { x: [0, -22, 16, 0], y: [0, 14, -10, 0], scale: [1, 0.95, 1.06, 1] }
        }
        transition={{ duration: 24, repeat: Infinity, ease: "easeInOut", delay: 3.5 }}
      />

      {/* Violet orb — center-bottom */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: "min(52vw, 560px)",
          height: "min(40vh, 380px)",
          left: "25%",
          bottom: "8%",
          background:
            "radial-gradient(ellipse at center, rgba(139,92,246,0.17) 0%, rgba(124,58,237,0.07) 50%, transparent 72%)",
          filter: "blur(58px)",
        }}
        animate={
          shouldReduce
            ? undefined
            : { x: [0, 16, -20, 0], y: [0, -22, 10, 0], scale: [1, 1.04, 0.97, 1] }
        }
        transition={{ duration: 27, repeat: Infinity, ease: "easeInOut", delay: 7 }}
      />

      {/* Cyan accent — right-bottom */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: "min(38vw, 400px)",
          height: "min(30vh, 300px)",
          right: "6%",
          bottom: "12%",
          background:
            "radial-gradient(ellipse at center, rgba(34,211,238,0.14) 0%, rgba(6,182,212,0.06) 50%, transparent 72%)",
          filter: "blur(44px)",
        }}
        animate={
          shouldReduce
            ? undefined
            : { x: [0, -14, 18, 0], y: [0, 20, -14, 0], scale: [1, 1.05, 0.97, 1] }
        }
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
      />

      {/* Central deep blue glow — static for stability */}
      <div
        className="absolute rounded-full"
        style={{
          width: "min(85vw, 920px)",
          height: "min(65vh, 580px)",
          left: "50%",
          top: "35%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse at center, rgba(30,64,175,0.24) 0%, rgba(30,58,138,0.09) 45%, transparent 68%)",
          filter: "blur(70px)",
        }}
      />
    </div>
  );
}
