"use client";

import { Suspense } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { LoginButton } from "@/components/LoginButton";
import { AuthNotice } from "@/components/auth/AuthNotice";
import { Spotlight } from "@/components/Spotlight";
import { DotMatrixWord } from "@/components/landing/DotMatrixWord";
import { PremiumInteractionCard, type PremiumTone } from "@/components/landing/PremiumInteractionCard";
import { MinimalIcon, type MinimalIconName } from "@/components/landing/MinimalIcon";
import { OPTIALogo } from "@/components/landing/OPTIALogo";
import { PartnerLogo } from "@/components/landing/PartnerLogo";
import { WorkflowPreview } from "@/components/landing/WorkflowPreview";
import { StagesTimeline } from "@/components/landing/StagesTimeline";

/* ── Animation variants ─────────────────────────────────── */

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show:   { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  show:   { transition: { staggerChildren: 0.09 } },
};

/* ── Static data ─────────────────────────────────────────── */

const MINI_BADGES = [
  "Flujo por etapas",
  "Feedback y checklist",
  "Panel docente",
  "Trazabilidad académica",
] as const;

type FriendlyCard = { icon: MinimalIconName; t: string; d: string };
type FriendlyVariant = "problem" | "solution";

type FriendlyBlock = {
  title:    string;
  subtitle: string;
  variant:  FriendlyVariant;
  cards:    FriendlyCard[];
};

type VariantStyle = { outer: string; icon: string; inner: string };

const VARIANT_STYLES: Record<FriendlyVariant, VariantStyle> = {
  problem: {
    outer: "border-amber-500/10 bg-amber-500/5",
    icon:  "text-amber-400/80",
    inner: "border-amber-500/10 bg-amber-500/5",
  },
  solution: {
    outer: "border-emerald-500/10 bg-emerald-500/5",
    icon:  "text-emerald-400/80",
    inner: "border-emerald-500/10 bg-emerald-500/5",
  },
};

const FRIENDLY: FriendlyBlock[] = [
  {
    title:    "Lo que suele pasar en las prácticas",
    subtitle: "OPT-IA existe para ayudarte a ordenarlo.",
    variant:  "problem",
    cards: [
      { icon: "compass", t: "Inicio confuso",        d: "Cuesta arrancar el diagnóstico y definir el enfoque." },
      { icon: "layers",  t: "Partes sueltas",         d: "Análisis sin conexión entre causas, datos e indicadores." },
      { icon: "file",    t: "Redacción poco técnica", d: "Estructura metodológica no establecida." },
    ],
  },
  {
    title:    "Cómo te ayuda OPT-IA",
    subtitle: "Rigor metodológico sin perder tiempo.",
    variant:  "solution",
    cards: [
      { icon: "spark", t: "Guía paso a paso",    d: "Flujo por etapas con estructura esperada." },
      { icon: "check", t: "Checklist + feedback", d: "Detecta vacíos y te dice qué mejorar." },
      { icon: "chart", t: "Trazabilidad",         d: "Seguimiento y apoyo para la evaluación del docente." },
    ],
  },
];

/* ── Page ────────────────────────────────────────────────── */

export default function Home() {
  const shouldReduce = useReducedMotion();

  return (
    <main className="min-h-screen midnightStars text-slate-100 overflow-x-hidden">
      <Spotlight />
      <div className="starsBright" />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-14">
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>

        {/* ══════════════════════════════════════════
            HERO
        ══════════════════════════════════════════ */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={stagger}
          className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center"
        >
          {/* Left */}
          <motion.div variants={fadeUp} className="flex flex-col">
            {/* Badge */}
            <div className="mb-5 self-start inline-flex items-center gap-2 rounded-full border border-sky-500/25 bg-sky-500/10 px-3.5 py-1.5 text-xs font-semibold text-sky-300">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
              Plataforma académica · Ingeniería Industrial
            </div>

            {/* Logo + separador + partner */}
            <motion.div variants={fadeUp} className="flex items-center gap-4 mb-4">
              <OPTIALogo />
              <div className="h-4 w-px bg-white/10" aria-hidden />
              <PartnerLogo />
            </motion.div>

            {/* Dot matrix brand */}
            <motion.div variants={fadeUp} className="mb-6">
              <DotMatrixWord aria-label="OPT-IA" />
            </motion.div>

            {/* H1 */}
            <h1 className="text-3xl sm:text-4xl lg:text-[2.55rem] font-bold tracking-tight leading-tight text-slate-100">
              Convierte las prácticas empresariales en un proceso{" "}
              <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-sky-300 bg-clip-text text-transparent">
                guiado, medible y trazable.
              </span>
            </h1>

            <p className="mt-5 text-sm sm:text-base text-slate-400 leading-relaxed max-w-xl">
              Para estudiantes y docentes: diagnóstico, horas, avances, feedback IA y plan de mejora
              en un solo flujo académico estructurado.
            </p>

            {/* CTAs */}
            <motion.div
              variants={fadeUp}
              className="mt-7 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center"
            >
              <div className="w-full sm:w-auto">
                <LoginButton className="rounded-2xl w-full sm:w-auto" />
              </div>
              <a
                href="#como-funciona"
                className="w-full sm:w-auto inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 h-12 text-sm font-semibold text-slate-200 hover:bg-white/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
              >
                Ver flujo metodológico
              </a>
            </motion.div>

            {/* Mini-badges */}
            <motion.div variants={fadeUp} className="mt-6 flex flex-wrap gap-2">
              {MINI_BADGES.map((badge) => (
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

          {/* Right — WorkflowPreview */}
          <motion.div variants={fadeUp} className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-[32px] bg-sky-500/10 blur-3xl"
            />
            <WorkflowPreview />
          </motion.div>
        </motion.section>

        {/* ══════════════════════════════════════════
            PROBLEMA / SOLUCIÓN
        ══════════════════════════════════════════ */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          variants={stagger}
          className="mt-16 grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          {FRIENDLY.map((block) => {
            const styles = VARIANT_STYLES[block.variant];
            const tone: PremiumTone = block.variant === "problem" ? "amber" : "emerald";
            return (
              <PremiumInteractionCard
                key={block.title}
                title={block.title}
                description={block.subtitle}
                tone={tone}
                eyebrow={block.variant === "problem" ? "Situación actual" : "Solución OPT-IA"}
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 auto-rows-fr">
                  {block.cards.map((c) => (
                    <div
                      key={c.t}
                      className={`flex flex-col rounded-2xl border p-4 h-full ${styles.inner}`}
                    >
                      <div className={styles.icon}>
                        <MinimalIcon name={c.icon} />
                      </div>
                      <div className="mt-2 text-sm font-semibold text-slate-200">{c.t}</div>
                      <div className="mt-1 text-xs text-slate-400 leading-relaxed">{c.d}</div>
                    </div>
                  ))}
                </div>
              </PremiumInteractionCard>
            );
          })}
        </motion.section>

        {/* ══════════════════════════════════════════
            CÓMO FUNCIONA / ETAPAS
        ══════════════════════════════════════════ */}
        <motion.section
          id="como-funciona"
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.12 }}
          variants={stagger}
          className="mt-16 rounded-[28px] border border-white/10 bg-white/5 p-6 lg:p-8"
        >
          <motion.div variants={fadeUp}>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-4">
              <span className="h-1 w-1 rounded-full bg-slate-500" aria-hidden />
              Flujo metodológico
            </div>
            <h2 className="text-xl font-bold text-slate-100">Cómo funciona el modo guiado</h2>
            <p className="mt-2 text-sm text-slate-400 max-w-3xl leading-relaxed">
              No es un chatbot:{" "}
              <span className="text-slate-300 font-medium">es un flujo académico</span> por avances y
              etapas, con estructura esperada, checklist y criterio de avance.
            </p>
          </motion.div>

          <div className="mt-6">
            <StagesTimeline />
          </div>
        </motion.section>

        {/* ══════════════════════════════════════════
            PRIVACIDAD / SEGURIDAD / GOOGLE CALENDAR
        ══════════════════════════════════════════ */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          variants={fadeUp}
          className="mt-10 rounded-[28px] border border-white/10 bg-white/5 p-6"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-4">
            <span className="h-1 w-1 rounded-full bg-slate-500" aria-hidden />
            Transparencia y seguridad
          </div>
          <h2 className="text-lg font-semibold text-slate-100">
            Privacidad, seguridad y Google Calendar
          </h2>
          <p className="mt-2 text-sm text-slate-400 max-w-3xl">
            Para cumplir requisitos de verificación OAuth (Google), OPT-IA explica de forma
            transparente cómo usa los datos.
          </p>

          <div className="mt-5 space-y-3">
            {/* Accordion 1: Google Calendar */}
            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15 transition-colors">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 select-none">
                <div className="font-semibold text-sm text-slate-200">
                  ¿Cómo funciona la integración con Google Calendar?
                </div>
                <div className="text-xs text-slate-500 group-open:hidden flex-shrink-0">Ver</div>
                <div className="text-xs text-slate-500 hidden group-open:block flex-shrink-0">Ocultar</div>
              </summary>

              <div className="mt-3 text-sm text-slate-300 space-y-3">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Autorización del estudiante</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    El estudiante autoriza el acceso mediante OAuth 2.0. Esta autorización se usa
                    únicamente para gestionar recordatorios académicos vinculados a OPT-IA.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                    <div className="text-sm font-semibold text-slate-200">Qué hace OPT-IA</div>
                    <ul className="mt-2 text-xs text-slate-400 space-y-1">
                      <li>• Crea y actualiza eventos académicos (recordatorios).</li>
                      <li>• Mantiene coherencia con fechas de actividades del curso/cohorte.</li>
                    </ul>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                    <div className="text-sm font-semibold text-slate-200">Qué NO hace OPT-IA</div>
                    <ul className="mt-2 text-xs text-slate-400 space-y-1">
                      <li>• No lee eventos personales existentes del calendario.</li>
                      <li>• No analiza contenido privado del usuario.</li>
                      <li>• No comparte datos con terceros.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </details>

            {/* Accordion 2: Seguridad */}
            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15 transition-colors">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 select-none">
                <div className="font-semibold text-sm text-slate-200">
                  Seguridad (OAuth 2.0 + almacenamiento de tokens)
                </div>
                <div className="text-xs text-slate-500 group-open:hidden flex-shrink-0">Ver</div>
                <div className="text-xs text-slate-500 hidden group-open:block flex-shrink-0">Ocultar</div>
              </summary>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Principio de menor privilegio</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    OPT-IA solicita únicamente los permisos necesarios para crear/actualizar
                    recordatorios académicos.
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Tokens protegidos</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    El refresh token se almacena de forma segura/cifrada. Se usa solo para mantener
                    recordatorios activos sin que el usuario tenga que re-autorizar continuamente.
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Revocación</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    El usuario puede revocar permisos en cualquier momento desde su cuenta de Google.
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Sin venta / sin terceros</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    OPT-IA no vende, no comparte y no transfiere información personal a terceros.
                  </p>
                </div>
              </div>
            </details>

            {/* Accordion 3: Términos */}
            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15 transition-colors">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 select-none">
                <div className="font-semibold text-sm text-slate-200">Términos de uso (resumen)</div>
                <div className="text-xs text-slate-500 group-open:hidden flex-shrink-0">Ver</div>
                <div className="text-xs text-slate-500 hidden group-open:block flex-shrink-0">Ocultar</div>
              </summary>

              <div className="mt-3 text-xs text-slate-400 leading-relaxed space-y-2">
                <p>• OPT-IA es una herramienta de apoyo académico y metodológico.</p>
                <p>• El estudiante es responsable del contenido final y de la veracidad de los datos ingresados.</p>
                <p>• El servicio puede experimentar mantenimientos o mejoras sin previo aviso.</p>
                <p className="pt-2 text-slate-500">
                  Ver documentos completos:{" "}
                  <a
                    className="text-slate-200 underline hover:text-white transition-colors"
                    href="/privacy"
                  >
                    Política de Privacidad
                  </a>{" "}
                  •{" "}
                  <a
                    className="text-slate-200 underline hover:text-white transition-colors"
                    href="/terms"
                  >
                    Términos y Condiciones
                  </a>
                </p>
              </div>
            </details>
          </div>
        </motion.section>

        {/* ══════════════════════════════════════════
            CTA FINAL
        ══════════════════════════════════════════ */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.25 }}
          variants={fadeUp}
          className="mt-10 relative overflow-hidden rounded-[28px] border border-white/10 bg-white/5 p-6 lg:p-8"
        >
          {/* Shimmer — respeta reduced motion */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-40 w-[35%] -translate-y-1/2 bg-gradient-to-r from-transparent via-sky-400/20 to-transparent blur-2xl"
            animate={shouldReduce ? undefined : { x: ["-40%", "140%"] }}
            transition={{ duration: 16, repeat: Infinity, ease: "linear" }}
          />

          <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 mb-3">
                <span className="h-1 w-1 rounded-full bg-sky-400/60" aria-hidden />
                Empieza hoy
              </div>
              <h2 className="text-xl font-bold text-slate-100">
                Empieza tu práctica con una guía clara
              </h2>
              <p className="mt-2 text-sm text-slate-400 max-w-2xl leading-relaxed">
                Un flujo académico estructurado, evaluable y formativo, con IA como mentor
                metodológico, trazabilidad completa y revisión docente integrada.
              </p>
            </div>
            <div className="flex-shrink-0">
              <LoginButton className="rounded-2xl" />
            </div>
          </div>
        </motion.section>

        {/* ══════════════════════════════════════════
            FOOTER
        ══════════════════════════════════════════ */}
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
      </div>
    </main>
  );
}
