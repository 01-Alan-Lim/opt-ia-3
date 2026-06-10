"use client";

import * as React from "react";
import { useReducedMotion } from "framer-motion";
import SpotlightCard from "@/components/SpotlightCard";
import { cn } from "@/lib/utils";

type Tone = "sky" | "violet";

type ToneStyle = {
  spotlight: `rgba(${number}, ${number}, ${number}, ${number})`;
  eyebrow:   string;
  dot:       string;
  glow:      string;
};

const TONE: Record<Tone, ToneStyle> = {
  sky: {
    spotlight: "rgba(56, 189, 248, 0.18)",
    eyebrow:   "text-sky-300",
    dot:       "bg-sky-400/70",
    glow:      "group-hover:shadow-[0_0_40px_-8px_rgba(56,189,248,0.45)]",
  },
  violet: {
    spotlight: "rgba(167, 139, 250, 0.18)",
    eyebrow:   "text-violet-300",
    dot:       "bg-violet-400/70",
    glow:      "group-hover:shadow-[0_0_40px_-8px_rgba(167,139,250,0.45)]",
  },
};

export type InteractiveModeCardProps = {
  tone:        Tone;
  eyebrow:     string;
  title:       string;
  description: string;
  features:    string[];
};

function FaceFront({
  eyebrow,
  title,
  description,
  tone,
  hint,
}: {
  eyebrow:     string;
  title:       string;
  description: string;
  tone:        ToneStyle;
  hint?:       boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("text-xs font-semibold mb-2", tone.eyebrow)}>{eyebrow}</div>
      <h3 className="text-lg font-bold text-slate-100">{title}</h3>
      <p className="mt-2 text-sm text-slate-400 leading-relaxed">{description}</p>
      {hint && (
        <div className="mt-auto pt-4 flex items-center gap-2 text-[11px] font-medium text-slate-500">
          <span className={cn("h-1 w-1 rounded-full", tone.dot)} aria-hidden />
          Pasa el cursor para ver sus capacidades
        </div>
      )}
    </div>
  );
}

function FeatureList({
  features,
  tone,
  title,
}: {
  features: string[];
  tone:     ToneStyle;
  title?:   string;
}) {
  return (
    <div className="flex h-full flex-col justify-center">
      {title && (
        <div className="text-xs font-semibold text-slate-300 mb-3">{title}</div>
      )}
      <ul className="space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-slate-300">
            <span
              className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0 mt-1.5", tone.dot)}
              aria-hidden
            />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Tarjeta de modo premium:
 *  - Desktop (md+): flip 3D en hover/focus — frente: nombre + descripción,
 *    reverso: capacidades.
 *  - Mobile / reduced-motion: contenido apilado siempre visible (sin depender
 *    del hover), accesible por tap/teclado.
 *  - Superficie SpotlightCard (React Bits) con spotlight por tono + glow.
 */
export function InteractiveModeCard({
  tone,
  eyebrow,
  title,
  description,
  features,
}: InteractiveModeCardProps) {
  const shouldReduce = useReducedMotion();
  const t = TONE[tone];
  const flipReady = !shouldReduce;

  /* Versión apilada — mobile siempre, y todos los tamaños si reduced-motion */
  const stacked = (
    <SpotlightCard
      spotlightColor={t.spotlight}
      className={cn(
        "group h-full !rounded-[28px] !border-white/10 !bg-white/[0.04] !p-6 transition-shadow duration-300",
        t.glow,
        flipReady ? "md:hidden" : "",
      )}
    >
      <FaceFront eyebrow={eyebrow} title={title} description={description} tone={t} />
      <div className="my-5 h-px bg-white/10" />
      <FeatureList features={features} tone={t} title="Capacidades" />
    </SpotlightCard>
  );

  if (!flipReady) {
    return stacked;
  }

  /* Versión flip — solo desktop */
  const flip = (
    <div
      className="group/flip hidden md:block h-full [perspective:1400px]"
      tabIndex={0}
      role="group"
      aria-label={`${title}. ${description}`}
    >
      <div
        className={cn(
          "relative h-full min-h-[260px] transition-transform duration-[650ms] [transform-style:preserve-3d]",
          "[transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
          "group-hover/flip:[transform:rotateY(180deg)] group-focus/flip:[transform:rotateY(180deg)]",
        )}
      >
        {/* Frente */}
        <SpotlightCard
          spotlightColor={t.spotlight}
          className={cn(
            "group absolute inset-0 h-full !rounded-[28px] !border-white/10 !bg-white/[0.04] !p-6",
            "[backface-visibility:hidden] transition-shadow duration-300",
            t.glow,
          )}
        >
          <FaceFront eyebrow={eyebrow} title={title} description={description} tone={t} hint />
        </SpotlightCard>

        {/* Reverso */}
        <SpotlightCard
          spotlightColor={t.spotlight}
          className={cn(
            "group absolute inset-0 h-full !rounded-[28px] !border-white/10 !bg-white/[0.05] !p-6",
            "[backface-visibility:hidden] [transform:rotateY(180deg)]",
          )}
        >
          <FeatureList features={features} tone={t} title={title} />
        </SpotlightCard>
      </div>
    </div>
  );

  return (
    <>
      {flip}
      {stacked}
    </>
  );
}
