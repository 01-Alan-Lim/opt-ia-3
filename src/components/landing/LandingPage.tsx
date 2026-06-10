"use client";

import { Suspense } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { LoginButton } from "@/components/LoginButton";
import { AuthNotice } from "@/components/auth/AuthNotice";
import { AuroraBackground } from "@/components/landing/AuroraBackground";
import { MagneticDotWord } from "@/components/landing/MagneticDotWord";
import { WorkflowPreview } from "@/components/landing/WorkflowPreview";
import { PremiumInfoCard } from "@/components/landing/PremiumInfoCard";
import { PremiumFlowShowcase } from "@/components/landing/PremiumFlowShowcase";
import { LandingScrollSection } from "@/components/landing/LandingScrollSection";
import { ClickSparkLite } from "@/components/landing/ClickSparkLite";
import { MinimalIcon, type MinimalIconName } from "@/components/landing/MinimalIcon";
import Magnet from "@/components/Magnet";
import GlareHover from "@/components/GlareHover";
import { cn } from "@/lib/utils";

/* ── Framer variants ───────────────────────────────────── */

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const fadeUp = {
  hidden: { opacity: 0, y: 22 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
};

const fadeScale = {
  hidden: { opacity: 0, scale: 0.9 },
  show:   { opacity: 1, scale: 1, transition: { duration: 0.6, ease: EASE } },
};

const fadeRight = {
  hidden: { opacity: 0, x: 44, scale: 0.94 },
  show:   { opacity: 1, x: 0, scale: 1, transition: { duration: 0.7, ease: EASE } },
};

const container = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.12, delayChildren: 0.05 } },
};

const gridStagger = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.09, delayChildren: 0.02 } },
};

/* ── Static data ───────────────────────────────────────── */

const BADGES = [
  "Flujo por etapas",
  "Feedback y checklist",
  "Revisión docente",
  "Trazabilidad académica",
] as const;

type FriendlyCard = { icon: MinimalIconName; t: string; d: string };

type FriendlyBlock = {
  eyebrow:  string;
  title:    string;
  tone:     "amber" | "emerald";
  cards:    FriendlyCard[];
};

const FRIENDLY: FriendlyBlock[] = [
  {
    eyebrow: "Situación actual",
    title:   "Lo que suele pasar en las prácticas",
    tone:    "amber",
    cards: [
      { icon: "compass", t: "Inicio confuso",        d: "Cuesta arrancar el diagnóstico y definir el enfoque." },
      { icon: "layers",  t: "Partes sueltas",         d: "Análisis sin conexión entre causas, datos e indicadores." },
      { icon: "file",    t: "Redacción poco técnica", d: "Estructura metodológica no establecida." },
    ],
  },
  {
    eyebrow: "Solución OPT-IA",
    title:   "Cómo guía OPT-IA",
    tone:    "emerald",
    cards: [
      { icon: "spark", t: "Flujo por etapas",       d: "Estructura esperada en cada avance del plan." },
      { icon: "check", t: "Feedback y checklist",    d: "Detecta vacíos y sugiere mejoras concretas." },
      { icon: "chart", t: "Trazabilidad académica",  d: "Seguimiento para revisión docente y estudiantes." },
    ],
  },
];

type ModeCard = {
  tone:        "sky" | "violet";
  eyebrow:     string;
  title:       string;
  description: string;
  bullets:     string[];
};

const MODES: ModeCard[] = [
  {
    tone:        "sky",
    eyebrow:     "Modo 1",
    title:       "Asistente general",
    description: "Resuelve dudas, orienta sobre metodología, recursos, formularios, cronograma y actividades generales de la práctica.",
    bullets: [
      "Responde dudas conceptuales",
      "Orienta sobre herramientas y metodología",
      "Enlaza recursos y formularios",
    ],
  },
  {
    tone:        "violet",
    eyebrow:     "Modo 2",
    title:       "Asesor de Plan de Mejora",
    description: "Guía el desarrollo del plan de mejora como workflow académico: contexto, diagnóstico, FODA, problema, Ishikawa, Pareto y propuesta final.",
    bullets: [
      "Flujo guiado por etapas",
      "Feedback y checklist por avance",
      "Artefactos guardados y trazabilidad",
    ],
  },
];

/* ── Page ──────────────────────────────────────────────── */

export function LandingPage() {
  const shouldReduce = useReducedMotion();

  return (
    <main className="relative min-h-screen bg-[#04060f] text-slate-100 overflow-x-hidden">
      {/* Aurora layer */}
      <AuroraBackground />

      {/* Spark al hacer click — aislado a /landing-lab */}
      <ClickSparkLite className="relative z-10 mx-auto w-full max-w-6xl px-6 py-14">
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>

        {/* ═══════════════════════════════════════
            HERO — logo protagonista arriba, grid debajo
        ═══════════════════════════════════════ */}

        {/* Bloque superior: badge + MagneticDotWord centrados */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={container}
          className="flex flex-col items-center text-center"
        >
          <motion.div
            variants={fadeUp}
            className="inline-flex items-center gap-2 rounded-full border border-sky-500/25 bg-sky-500/10 px-3.5 py-1.5 text-xs font-semibold text-sky-300"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
            Plataforma académica · Ingeniería Industrial
          </motion.div>

          {/* Marca principal — bloque protagonista, sin recorte */}
          <motion.div
            variants={fadeScale}
            className="mt-7 flex w-full justify-center"
          >
            <MagneticDotWord dotSize={20} gap={10} letterGap={22} />
          </motion.div>
        </motion.div>

        {/* Grid del hero */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={container}
          className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center"
        >
          {/* Izquierda */}
          <motion.div variants={gridStagger} className="flex flex-col">
            <motion.h1
              variants={fadeUp}
              className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight leading-tight text-slate-100"
            >
              Convierte las prácticas{" "}
              <br className="hidden sm:block" />
              empresariales en un proceso{" "}
              <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-sky-300 bg-clip-text text-transparent">
                guiado, medible y trazable.
              </span>
            </motion.h1>

            <motion.p
              variants={fadeUp}
              className="mt-5 text-base text-slate-400 leading-relaxed max-w-xl"
            >
              OPT-IA acompaña diagnóstico, análisis, horas, evidencias y planes de mejora
              con IA académica y trazabilidad para revisión docente.
            </motion.p>

            {/* CTAs — con magnetismo */}
            <motion.div
              variants={fadeUp}
              className="mt-7 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center"
            >
              <Magnet
                padding={70}
                magnetStrength={4}
                disabled={!!shouldReduce}
                wrapperClassName="w-full sm:w-auto"
                innerClassName="w-full sm:w-auto"
              >
                <LoginButton className="rounded-2xl w-full transition-shadow hover:shadow-[0_0_32px_-6px_rgba(56,189,248,0.6)]" />
              </Magnet>

              <Magnet
                padding={70}
                magnetStrength={5}
                disabled={!!shouldReduce}
                wrapperClassName="w-full sm:w-auto"
                innerClassName="w-full sm:w-auto"
              >
                <a
                  href="#flujo"
                  className="w-full sm:w-auto inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 h-12 text-sm font-semibold text-slate-200 hover:bg-white/10 hover:border-sky-400/40 hover:shadow-[0_0_24px_-8px_rgba(56,189,248,0.5)] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                >
                  Ver flujo metodológico
                </a>
              </Magnet>
            </motion.div>

            {/* Mini-badges */}
            <motion.div variants={fadeUp} className="mt-6 flex flex-wrap gap-2">
              {BADGES.map((badge) => (
                <span
                  key={badge}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-400"
                >
                  <span className="h-1 w-1 rounded-full bg-sky-400/60" aria-hidden />
                  {badge}
                </span>
              ))}
            </motion.div>
          </motion.div>

          {/* Derecha — WorkflowPreview: entra desde la derecha + float + glow */}
          <motion.div variants={fadeRight} className="relative">
            {/* glow detrás del preview */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-10 rounded-[48px] bg-sky-500/25 blur-[64px]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-4 rounded-[40px] bg-indigo-500/15 blur-2xl"
            />

            <motion.div
              animate={shouldReduce ? undefined : { y: [0, -10, 0] }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
              className="relative"
            >
              <GlareHover
                width="100%"
                height="auto"
                background="transparent"
                borderColor="transparent"
                borderRadius="28px"
                glareColor="#bae6fd"
                glareOpacity={0.22}
                glareSize={220}
                transitionDuration={750}
                className="!block"
              >
                <WorkflowPreview />
              </GlareHover>
            </motion.div>
          </motion.div>
        </motion.section>

        {/* Section divider */}
        <div aria-hidden className="mt-20 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />

        {/* ═══════════════════════════════════════
            PROBLEMA / SOLUCIÓN
        ═══════════════════════════════════════ */}
        <LandingScrollSection className="mt-20">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {FRIENDLY.map((block) => (
              <div
                key={block.title}
                className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6"
              >
                <div
                  className={cn(
                    "text-xs font-semibold mb-2",
                    block.tone === "amber" ? "text-amber-300" : "text-emerald-300",
                  )}
                >
                  {block.eyebrow}
                </div>
                <h2 className="text-lg font-bold text-slate-100">{block.title}</h2>

                <motion.div
                  variants={gridStagger}
                  initial="hidden"
                  whileInView="show"
                  viewport={{ once: true, amount: 0.3 }}
                  className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3"
                >
                  {block.cards.map((c) => (
                    <motion.div key={c.t} variants={fadeUp} className="h-full">
                      <PremiumInfoCard
                        tone={block.tone}
                        title={c.t}
                        description={c.d}
                        compact
                        icon={<MinimalIcon name={c.icon} />}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              </div>
            ))}
          </div>
        </LandingScrollSection>

        {/* Section divider */}
        <div aria-hidden className="mt-20 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />

        {/* ═══════════════════════════════════════
            MODOS DEL ASISTENTE (solo 2)
        ═══════════════════════════════════════ */}
        <LandingScrollSection className="mt-20">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-4">
              <span className="h-1 w-1 rounded-full bg-violet-400/70" aria-hidden />
              Modos del asistente
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-100">
              Un asesor que se adapta
              <br />
              <span className="bg-gradient-to-r from-violet-400 to-indigo-300 bg-clip-text text-transparent">
                a lo que necesitas
              </span>
            </h2>
            <p className="mt-3 text-sm text-slate-400 max-w-lg mx-auto leading-relaxed">
              OPT-IA opera en dos modos según el contexto y la etapa de la práctica.
            </p>
          </div>

          <motion.div
            variants={gridStagger}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.25 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-5"
          >
            {MODES.map((mode) => (
              <motion.div key={mode.title} variants={fadeUp} className="h-full">
                <PremiumInfoCard
                  tone={mode.tone}
                  eyebrow={mode.eyebrow}
                  title={mode.title}
                  description={mode.description}
                  bullets={mode.bullets}
                />
              </motion.div>
            ))}
          </motion.div>
        </LandingScrollSection>

        {/* Section divider */}
        <div aria-hidden className="mt-20 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />

        {/* ═══════════════════════════════════════
            FLUJO METODOLÓGICO
        ═══════════════════════════════════════ */}
        <LandingScrollSection
          id="flujo"
          className="mt-20 rounded-[28px] border border-white/10 bg-white/5 p-6 lg:p-8"
        >
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-4">
              <span className="h-1 w-1 rounded-full bg-slate-500" aria-hidden />
              Flujo metodológico
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-100">
              Cómo funciona el modo guiado
            </h2>
            <p className="mt-2 text-sm text-slate-400 max-w-3xl leading-relaxed">
              No es un chatbot:{" "}
              <span className="text-slate-300 font-medium">es un flujo académico</span>{" "}
              por avances y etapas, con estructura esperada, checklist y criterio de avance.
            </p>
          </div>

          <div className="mt-6">
            <PremiumFlowShowcase />
          </div>
        </LandingScrollSection>

        {/* ═══════════════════════════════════════
            CTA FINAL
        ═══════════════════════════════════════ */}
        <LandingScrollSection className="mt-16 relative overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-sky-500/[0.08] via-white/[0.04] to-violet-500/[0.08] p-6 lg:p-10">
          {/* glow suave */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[60%] -translate-x-1/2 rounded-full bg-sky-500/20 blur-[80px]"
          />
          {/* Shimmer — respects reduced motion */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-40 w-[35%] -translate-y-1/2 bg-gradient-to-r from-transparent via-sky-400/15 to-transparent blur-2xl"
            animate={shouldReduce ? undefined : { x: ["-40%", "140%"] }}
            transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
          />

          <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-3">
                <span className="h-1 w-1 rounded-full bg-sky-400/60" aria-hidden />
                Empieza hoy
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-slate-100">
                Empieza tu práctica con una guía clara
              </h2>
              <p className="mt-2 text-sm text-slate-400 max-w-2xl leading-relaxed">
                Un flujo académico estructurado, evaluable y formativo, con IA como mentor
                metodológico y revisión docente integrada.
              </p>
            </div>
            <div className="flex-shrink-0">
              <Magnet padding={70} magnetStrength={4} disabled={!!shouldReduce}>
                <LoginButton className="rounded-2xl transition-shadow hover:shadow-[0_0_32px_-6px_rgba(56,189,248,0.6)]" />
              </Magnet>
            </div>
          </div>
        </LandingScrollSection>

        {/* Footer */}
        <footer className="mt-10 pb-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
            <span>
              OPT-IA · Ingeniería Industrial · Prácticas empresariales · Planes de mejora
            </span>
            <div className="flex items-center gap-4">
              <a href="/privacy" className="hover:text-slate-400 transition-colors">
                Privacidad
              </a>
              <a href="/terms" className="hover:text-slate-400 transition-colors">
                Términos
              </a>
            </div>
          </div>
        </footer>
      </ClickSparkLite>
    </main>
  );
}
