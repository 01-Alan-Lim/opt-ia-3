"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";

type Stage = {
  n: number;
  t: string;
  d: string;
};

type AvanceColor = "sky" | "indigo" | "violet";

type Avance = {
  num: string;
  title: string;
  subtitle: string;
  color: AvanceColor;
  stages: Stage[];
};

type ColorClasses = {
  barFrom: string;
  barTo: string;
  numText: string;
  numBg: string;
  stagePill: string;
  circleBorder: string;
};

function getColorClasses(color: AvanceColor): ColorClasses {
  switch (color) {
    case "sky":
      return {
        barFrom:      "from-sky-500",
        barTo:        "to-cyan-400",
        numText:      "text-sky-400",
        numBg:        "bg-sky-500/10",
        stagePill:    "border-sky-500/15 bg-sky-500/5 hover:bg-sky-500/10",
        circleBorder: "border-sky-500/30",
      };
    case "indigo":
      return {
        barFrom:      "from-indigo-500",
        barTo:        "to-violet-400",
        numText:      "text-indigo-400",
        numBg:        "bg-indigo-500/10",
        stagePill:    "border-indigo-500/15 bg-indigo-500/5 hover:bg-indigo-500/10",
        circleBorder: "border-indigo-500/30",
      };
    case "violet":
      return {
        barFrom:      "from-violet-500",
        barTo:        "to-purple-400",
        numText:      "text-violet-400",
        numBg:        "bg-violet-500/10",
        stagePill:    "border-violet-500/15 bg-violet-500/5 hover:bg-violet-500/10",
        circleBorder: "border-violet-500/30",
      };
  }
}

const AVANCES: Avance[] = [
  {
    num:      "01",
    title:    "Diagnóstico",
    subtitle: "Base técnica del caso",
    color:    "sky",
    stages: [
      { n: 1, t: "Productividad",    d: "Diagnóstico inicial de productividad" },
      { n: 2, t: "FODA",             d: "Análisis interno y externo" },
      { n: 3, t: "Lluvia de ideas",  d: "Problema y enfoque" },
      { n: 4, t: "Ishikawa",         d: "Causas raíz + 5 Porqués" },
      { n: 5, t: "Pareto",           d: "Priorización 20/80" },
    ],
  },
  {
    num:      "02",
    title:    "Propuesta",
    subtitle: "Convertir diagnóstico en mejora",
    color:    "indigo",
    stages: [
      { n: 6, t: "Objetivos",       d: "Objetivos claros y medibles" },
      { n: 7, t: "Plan de Mejora",  d: "Acciones + responsables" },
      { n: 8, t: "Planificación",   d: "Cronograma / KPI" },
    ],
  },
  {
    num:      "03",
    title:    "Cierre",
    subtitle: "Evidencia y revisión académica",
    color:    "violet",
    stages: [
      { n: 9,  t: "Reporte de avances", d: "Resultados y seguimiento" },
      { n: 10, t: "Documento final",    d: "Entrega del plan completo" },
    ],
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 22 },
  show:   { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.13, delayChildren: 0.05 } },
};

export function StagesTimeline() {
  const shouldReduce = useReducedMotion();

  return (
    <motion.div
      initial={shouldReduce ? "show" : "hidden"}
      whileInView="show"
      viewport={{ once: true, amount: 0.12 }}
      variants={stagger}
      className="flex flex-col lg:flex-row lg:items-stretch gap-4"
    >
      {AVANCES.flatMap((avance, idx) => {
        const cls = getColorClasses(avance.color);

        const card = (
          <motion.div
            key={avance.num}
            variants={shouldReduce ? undefined : fadeUp}
            transition={{ duration: 0.52, ease: "easeOut" }}
            className="group relative flex-1 rounded-[24px] border border-white/10 bg-black/10 p-5 hover:bg-black/15 transition-colors overflow-hidden"
          >
            {/* Subtle hover glow */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-2 rounded-[26px] bg-white/0 blur-2xl transition-all duration-300 group-hover:bg-white/5"
            />

            <div className="relative">
              {/* Colored gradient accent bar */}
              <div
                className={`h-0.5 w-10 rounded-full bg-gradient-to-r mb-4 ${cls.barFrom} ${cls.barTo}`}
              />

              {/* Avance header: circle badge + title */}
              <div className="flex items-center gap-2.5 mb-1">
                <div
                  className={`w-7 h-7 rounded-full border flex items-center justify-center flex-shrink-0 ${cls.numBg} ${cls.circleBorder}`}
                >
                  <span className={`text-[10px] font-bold tabular-nums leading-none ${cls.numText}`}>
                    {avance.num}
                  </span>
                </div>
                <span className="text-sm font-bold text-slate-200">{avance.title}</span>
              </div>
              <p className="text-xs text-slate-500 mb-4 leading-relaxed pl-9">{avance.subtitle}</p>

              {/* Stage items */}
              <div className="grid grid-cols-1 gap-2">
                {avance.stages.map((stage) => (
                  <div
                    key={stage.n}
                    className={`flex items-start gap-2.5 rounded-xl border px-3 py-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_18px_-8px_rgba(56,189,248,0.45)] ${cls.stagePill}`}
                  >
                    <span
                      className={`text-[10px] font-bold tabular-nums leading-none mt-0.5 flex-shrink-0 w-4 ${cls.numText} opacity-65`}
                    >
                      {stage.n}
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-200 leading-tight">{stage.t}</div>
                      <div className="text-[10px] text-slate-500 leading-tight mt-0.5">{stage.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        );

        if (idx < AVANCES.length - 1) {
          return [
            card,
            <div
              key={`conn-${idx}`}
              aria-hidden
              className="relative hidden lg:flex items-center justify-center flex-shrink-0 w-6 pt-8"
            >
              <div className="h-px w-full bg-gradient-to-r from-transparent via-sky-400/45 to-transparent" />
              <div className="absolute h-1.5 w-1.5 rounded-full bg-sky-400/60 shadow-[0_0_8px_rgba(56,189,248,0.6)]" />
            </div>,
          ];
        }
        return [card];
      })}
    </motion.div>
  );
}
