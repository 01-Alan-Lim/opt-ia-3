"use client";

import * as React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";

type StagePhase = "diagnostic" | "proposal" | "close";

type MethodStage = {
  code: string;
  name: string;
  label: string;
  phase: StagePhase;
};

type PhaseStyle = {
  dot: string;
  labelColor: string;
  rowBorder: string;
  rowBg: string;
  nameColor: string;
};

const STAGES: MethodStage[] = [
  { code: "E0", name: "Contexto",          label: "Inicio",       phase: "diagnostic" },
  { code: "E1", name: "Productividad",     label: "Diagnóstico",  phase: "diagnostic" },
  { code: "E2", name: "FODA",              label: "Análisis",     phase: "diagnostic" },
  { code: "E3", name: "Problema + ideas",  label: "Enfoque",      phase: "diagnostic" },
  { code: "E4", name: "Ishikawa",          label: "Causa raíz",   phase: "proposal"   },
  { code: "E5", name: "Pareto",            label: "Priorización", phase: "proposal"   },
  { code: "E7", name: "Plan de mejora",    label: "Propuesta",    phase: "close"      },
];

const PHASE_STYLES: Record<StagePhase, PhaseStyle> = {
  diagnostic: {
    dot:        "bg-sky-400/70",
    labelColor: "text-sky-400",
    rowBorder:  "border-sky-500/15",
    rowBg:      "bg-sky-500/5",
    nameColor:  "text-slate-300",
  },
  proposal: {
    dot:        "bg-indigo-400/70",
    labelColor: "text-indigo-400",
    rowBorder:  "border-indigo-500/15",
    rowBg:      "bg-indigo-500/5",
    nameColor:  "text-slate-300",
  },
  close: {
    dot:        "bg-violet-400/70",
    labelColor: "text-violet-400",
    rowBorder:  "border-violet-500/15",
    rowBg:      "bg-violet-500/5",
    nameColor:  "text-slate-300",
  },
};

const staggerRows: Variants = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.06, delayChildren: 0.4 } },
};

const fadeRow: Variants = {
  hidden: { opacity: 0, x: -8 },
  show:   { opacity: 1, x: 0, transition: { duration: 0.28, ease: "easeOut" } },
};

export function WorkflowPreview() {
  const shouldReduce = useReducedMotion();

  return (
    <div className="relative rounded-[28px] border border-white/10 bg-white/5 p-5 backdrop-blur-md shadow-2xl overflow-hidden">
      {/* Ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-10 -right-10 h-36 w-36 rounded-full bg-sky-500/10 blur-3xl"
      />

      {/* Header */}
      <div className="relative flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
          <span className="text-xs font-semibold text-slate-300">Ruta metodológica</span>
        </div>
        <span className="text-[10px] font-semibold text-sky-400 border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 rounded-full">
          Flujo académico
        </span>
      </div>

      {/* Subtitle — generic, describes the platform, not a real student state */}
      <p className="relative text-[10px] text-slate-500 leading-relaxed mb-3">
        Estructura guiada para prácticas empresariales
      </p>

      {/* Decorative flow connector — not a progress bar */}
      <div
        aria-hidden
        className="relative h-px w-full mb-4 rounded-full bg-gradient-to-r from-sky-500/30 via-indigo-500/20 to-violet-500/30"
      />

      {/* Stage list — staggered entrance */}
      <motion.div
        initial={shouldReduce ? "show" : "hidden"}
        animate="show"
        variants={staggerRows}
        className="relative space-y-1.5 mb-4"
      >
        {STAGES.map((stage) => {
          const cfg = PHASE_STYLES[stage.phase];
          return (
            <motion.div
              key={stage.code}
              variants={shouldReduce ? undefined : fadeRow}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 transition-colors ${cfg.rowBorder} ${cfg.rowBg}`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={`block h-1.5 w-1.5 rounded-full flex-shrink-0 ${cfg.dot}`}
                />
                <span className="text-[10px] font-bold text-slate-500 tabular-nums flex-shrink-0">
                  {stage.code}
                </span>
                <span className={`text-xs font-medium ${cfg.nameColor}`}>{stage.name}</span>
              </div>
              <span className={`text-[10px] font-semibold flex-shrink-0 ${cfg.labelColor}`}>
                {stage.label}
              </span>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Feedback metodológico */}
      <div className="relative rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-3 py-2.5 mb-3">
        <div className="flex items-start gap-2">
          <span className="text-indigo-400 text-sm leading-none mt-0.5 flex-shrink-0" aria-hidden>
            ◆
          </span>
          <div>
            <div className="text-[10px] font-semibold text-indigo-400 mb-0.5">
              Feedback metodológico
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              La IA guía preguntas, ejemplos y checklist según la etapa.
            </p>
          </div>
        </div>
      </div>

      {/* Vista docente + Trazabilidad */}
      <div className="relative grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2.5">
          <div className="text-[10px] text-slate-500 mb-0.5">Vista docente</div>
          <div className="text-xs font-medium text-slate-300">Cohorte y evidencias</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-2.5">
          <div className="text-[10px] text-slate-500 mb-0.5">Trazabilidad</div>
          <div className="text-xs font-medium text-slate-300">Estado y artefactos</div>
        </div>
      </div>
    </div>
  );
}
