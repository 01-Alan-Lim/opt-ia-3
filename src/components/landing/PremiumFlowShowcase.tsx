"use client";

import * as React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";

type FlowTone = "sky" | "indigo" | "violet";

type Stage = { n: number; t: string; d: string };

type Column = {
  num:      string;
  title:    string;
  subtitle: string;
  tone:     FlowTone;
  stages:   Stage[];
};

type ToneClasses = {
  bar:    string;
  halo:   string;
  numText:string;
  numBg:  string;
  pill:   string;
  ring:   string;
};

const TONE: Record<FlowTone, ToneClasses> = {
  sky: {
    bar:     "from-sky-500 to-cyan-400",
    halo:    "bg-cyan-400/10",
    numText: "text-sky-300",
    numBg:   "bg-sky-500/10 border-sky-500/30",
    pill:    "border-sky-400/20 bg-sky-500/[0.06] hover:bg-sky-500/10",
    ring:    "hover:shadow-[0_8px_18px_-12px_rgba(56,189,248,0.45)]",
  },
  indigo: {
    bar:     "from-indigo-500 to-violet-400",
    halo:    "bg-indigo-400/10",
    numText: "text-indigo-300",
    numBg:   "bg-indigo-500/10 border-indigo-500/30",
    pill:    "border-indigo-400/20 bg-indigo-500/[0.06] hover:bg-indigo-500/10",
    ring:    "hover:shadow-[0_8px_18px_-12px_rgba(129,140,248,0.45)]",
  },
  violet: {
    bar:     "from-violet-500 to-purple-400",
    halo:    "bg-violet-400/10",
    numText: "text-violet-300",
    numBg:   "bg-violet-500/10 border-violet-500/30",
    pill:    "border-violet-400/20 bg-violet-500/[0.06] hover:bg-violet-500/10",
    ring:    "hover:shadow-[0_8px_18px_-12px_rgba(167,139,250,0.45)]",
  },
};

const COLUMNS: Column[] = [
  {
    num: "01", title: "Diagnóstico", subtitle: "Base técnica del caso", tone: "sky",
    stages: [
      { n: 1, t: "Productividad",   d: "Diagnóstico inicial de productividad" },
      { n: 2, t: "FODA",            d: "Análisis interno y externo" },
      { n: 3, t: "Lluvia de ideas", d: "Problema y enfoque" },
      { n: 4, t: "Ishikawa",        d: "Causas raíz + 5 Porqués" },
      { n: 5, t: "Pareto",          d: "Priorización 20/80" },
    ],
  },
  {
    num: "02", title: "Propuesta", subtitle: "Convertir diagnóstico en mejora", tone: "indigo",
    stages: [
      { n: 6, t: "Objetivos",      d: "Objetivos claros y medibles" },
      { n: 7, t: "Plan de Mejora", d: "Acciones + responsables" },
      { n: 8, t: "Planificación",  d: "Cronograma / KPI" },
    ],
  },
  {
    num: "03", title: "Cierre", subtitle: "Evidencia y revisión académica", tone: "violet",
    stages: [
      { n: 9,  t: "Reporte de avances", d: "Resultados y seguimiento" },
      { n: 10, t: "Documento final",    d: "Entrega del plan completo" },
    ],
  },
];

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const parent: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.14, delayChildren: 0.05 } },
};

const colVariant: Variants = {
  hidden: { opacity: 0, y: 32 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
};

const pillVariant: Variants = {
  hidden: { opacity: 0, y: 14 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
};

export function PremiumFlowShowcase() {
  const shouldReduce = useReducedMotion();

  return (
    <motion.div
      variants={shouldReduce ? undefined : parent}
      initial={shouldReduce ? undefined : "hidden"}
      whileInView={shouldReduce ? undefined : "show"}
      viewport={{ once: true, amount: 0.2 }}
      className="flex flex-col lg:flex-row lg:items-stretch gap-4"
    >
      {COLUMNS.flatMap((col, idx) => {
        const c = TONE[col.tone];

        const card = (
          <motion.div
            key={col.num}
            variants={shouldReduce ? undefined : colVariant}
            className="group/col relative flex-1 overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.03] p-5 transition-colors hover:bg-white/[0.05]"
          >
            {/* halo ambiental por tono */}
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute -top-20 left-1/2 h-44 w-[80%] -translate-x-1/2 rounded-full opacity-60 blur-3xl transition-opacity duration-300 group-hover/col:opacity-100",
                c.halo,
              )}
            />

            <div className="relative">
              {/* barra de acento */}
              <div className={cn("mb-4 h-0.5 w-10 rounded-full bg-gradient-to-r", c.bar)} />

              {/* header */}
              <div className="mb-1 flex items-center gap-2.5">
                <div
                  className={cn(
                    "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border",
                    c.numBg,
                  )}
                >
                  <span className={cn("text-[11px] font-bold tabular-nums leading-none", c.numText)}>
                    {col.num}
                  </span>
                </div>
                <span className="text-sm font-bold text-slate-100">{col.title}</span>
              </div>
              <p className="mb-4 pl-9 text-xs leading-relaxed text-slate-400">{col.subtitle}</p>

              {/* etapas */}
              <div className="grid grid-cols-1 gap-2">
                {col.stages.map((stage) => (
                  <motion.div
                    key={stage.n}
                    variants={shouldReduce ? undefined : pillVariant}
                    className={cn(
                      "flex items-start gap-2.5 rounded-xl border px-3 py-2 transition-all duration-200",
                      "hover:-translate-y-0.5",
                      c.pill,
                      c.ring,
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 w-4 flex-shrink-0 text-xs font-bold tabular-nums leading-4",
                        c.numText,
                      )}
                    >
                      {stage.n}
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold leading-snug text-slate-100">{stage.t}</div>
                      <div className="mt-0.5 text-xs leading-snug text-slate-400">{stage.d}</div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        );

        if (idx < COLUMNS.length - 1) {
          return [
            card,
            <div
              key={`conn-${idx}`}
              aria-hidden
              className="relative hidden w-6 flex-shrink-0 items-center justify-center pt-8 lg:flex"
            >
              <div className="h-px w-full bg-gradient-to-r from-transparent via-sky-400/45 to-transparent" />
              <div className="absolute h-1.5 w-1.5 rounded-full bg-sky-400/70 shadow-[0_0_8px_rgba(56,189,248,0.7)]" />
            </div>,
          ];
        }
        return [card];
      })}
    </motion.div>
  );
}
