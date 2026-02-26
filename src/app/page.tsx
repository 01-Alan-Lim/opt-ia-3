"use client";

import { Suspense, useMemo } from "react";
import { motion } from "framer-motion";

import { LoginButton } from "@/components/LoginButton";
import { AuthNotice } from "@/components/auth/AuthNotice";
import { Spotlight } from "@/components/Spotlight";
import { MagneticCard } from "@/components/landing/MagneticCard";

import { MinimalIcon, type MinimalIconName } from "@/components/landing/MinimalIcon";

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

export default function Home() {
  const stages = useMemo(
    () => [
      {
        title: "Avance 1 — Diagnóstico",
        subtitle: "Base técnica del caso",
        items: [
          { n: 1, t: "Productividad", d: "Revisión y medición de productividad" },
          { n: 2, t: "FODA", d: "Análisis interno/externo" },
          { n: 3, t: "Lluvia de ideas", d: "Problema y enfoque" },
          { n: 4, t: "Ishikawa", d: "Causas raíz + 5 Porqués" },
          { n: 5, t: "Pareto", d: "Priorización 20/80" },
        ],
      },
      {
        title: "Avance 2 — Propuesta",
        subtitle: "Convertir diagnóstico en mejora",
        items: [
          { n: 6, t: "Objetivos", d: "Objetivos claros y medibles" },
          { n: 7, t: "Plan de Mejora", d: "Acciones + responsables" },
          { n: 8, t: "Planificación", d: "Cronograma de implementación" },
        ],
      },
      {
        title: "Avance 3 — Cierre",
        subtitle: "Evidencia y revisión académica",
        items: [
          { n: 9, t: "Reporte de avance", d: "Resultados y seguimiento" },
          { n: 10, t: "Revisión del Plan", d: "Subida del documento final" },
        ],
      },
    ],
    []
  );

  const friendly = useMemo(
    (): Array<{
      title: string;
      subtitle: string;
      cards: Array<{ icon: MinimalIconName; t: string; d: string }>;
    }> => [
      {
        title: "Lo que suele pasar en las prácticas",
        subtitle: "OPT-IA existe para ayudarte a ordenarlo.",
        cards: [
          { icon: "compass", t: "Inicio confuso", d: "Cuesta arrancar el diagnóstico y definir el enfoque." },
          { icon: "layers", t: "Partes sueltas", d: "Análisis sin conexión entre causas, datos e indicadores." },
          { icon: "file", t: "Redacción poco técnica", d: "Estructura metodológica no establecida." },
        ],
      },
      {
        title: "Cómo te ayuda OPT-IA",
        subtitle: "Rigor metodológico sin perder tiempo.",
        cards: [
          { icon: "spark", t: "Guía paso a paso", d: "Flujo por etapas con estructura esperada." },
          { icon: "check", t: "Checklist + feedback", d: "Detecta vacíos y te dice qué mejorar." },
          { icon: "chart", t: "Trazabilidad", d: "Seguimiento y apoyo para la evaluación del docente." },
        ],
      },
    ],
    []
  );

  return (
    <main className="min-h-screen midnightStars text-slate-100 overflow-x-hidden">
      <Spotlight />
      <div className="starsBright" />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-14">
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>

        {/* HERO */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={stagger}
          className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center"
        >
          <motion.div variants={fadeUp}>
            <h1 className="mt-5 text-4xl sm:text-6xl font-semibold tracking-tight">
              OPT-IA
              <span className="block text-slate-200/90 mt-2 text-2xl sm:text-3xl font-medium">
                Asistente Inteligente Académico para Prácticas Empresariales
              </span>
            </h1>

            <p className="mt-5 text-sm sm:text-base text-slate-300 leading-relaxed max-w-xl">
              Sistema académico guiado con lógica metodológica, control por etapas y evaluación formativa.
            </p>

            <motion.div variants={fadeUp} className="mt-7 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <div className="w-full sm:w-auto">
                <LoginButton className="rounded-2xl w-full sm:w-auto" />
              </div>
              <a
                href="#como-funciona"
                className="w-full sm:w-auto inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-5 h-12 text-sm font-semibold text-slate-200 hover:bg-white/10 transition"
              >
                Ver etapas
              </a>
            </motion.div>

            {/* Mini-cards */}
            <motion.div variants={stagger} className="mt-7 grid grid-cols-3 gap-3 max-w-xl">
              {[
                { k: "Workflow", v: "Por etapas + gates" },
                { k: "Evaluación", v: "Score + checklist" },
                { k: "Docente", v: "Métricas + panel" },
              ].map((x) => (
                <MagneticCard key={x.k} className="rounded-2xl border border-white/10 bg-white/5 p-3" strength={0.55}>
                  <motion.div variants={fadeUp}>
                    <div className="text-xs text-slate-300">{x.k}</div>
                    <div className="mt-1 text-sm font-semibold">{x.v}</div>
                  </motion.div>
                </MagneticCard>
              ))}
            </motion.div>
          </motion.div>

          {/* Mock visual */}
          <motion.div variants={fadeUp} className="relative">
            <div className="absolute -inset-6 rounded-[32px] bg-sky-500/10 blur-2xl" />

            <MagneticCard
              className="relative rounded-[28px] border border-white/10 bg-white/5 p-5 backdrop-blur-md shadow-2xl"
              strength={0.45}
            >
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-300">Vista rápida</div>
              </div>

              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs text-slate-300">Modo guiado</div>
                  <div className="mt-1 text-sm font-semibold text-slate-200">10 etapas + gates</div>
                  <div className="mt-2 text-xs text-slate-400">Avanzas solo si cumples criterios mínimos.</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
                    <div className="text-xs text-slate-300">Evaluación</div>
                    <div className="mt-1 text-sm font-semibold text-slate-200">Score + checklist</div>
                    <div className="mt-2 text-xs text-slate-400">Feedback técnico por etapa</div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
                    <div className="text-xs text-slate-300">Docente</div>
                    <div className="mt-1 text-sm font-semibold text-slate-200">Panel</div>
                    <div className="mt-2 text-xs text-slate-400">Dashboard + Métricas</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-xs text-slate-300">Privacidad</div>
                  <div className="mt-1 text-sm font-semibold text-slate-200">Control académico</div>
                  <div className="mt-2 text-xs text-slate-400">Roles • Cohortes • RLS</div>
                </div>
              </div>
            </MagneticCard>
          </motion.div>
        </motion.section>

        {/* Sección amigable */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.25 }}
          variants={stagger}
          className="mt-14 grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          {friendly.map((block) => (
            <MagneticCard
              key={block.title}
              className="rounded-[28px] border border-white/10 bg-white/5 p-6"
              strength={0.5}
            >
              <motion.div variants={fadeUp}>
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{block.title}</h2>
                    <p className="mt-1 text-sm text-slate-400">{block.subtitle}</p>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3 auto-rows-fr">
                  {block.cards.map((c) => (
                    <div key={c.t} className="h-full rounded-2xl border border-white/10 bg-black/10 p-4">
                      <div className="flex h-full flex-col">
                        <div className="text-sky-200/80">
                          <MinimalIcon name={c.icon} />
                        </div>
                        <div className="mt-2 text-sm font-semibold text-slate-200">{c.t}</div>
                        <div className="mt-1 text-xs text-slate-400 leading-relaxed">{c.d}</div>
                        <div className="mt-auto" />
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </MagneticCard>
          ))}
        </motion.section>

        {/* CÓMO FUNCIONA / ETAPAS */}
        <motion.section
          id="como-funciona"
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.2 }}
          variants={stagger}
          className="mt-14 rounded-[28px] border border-white/10 bg-white/5 p-6"
        >
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Cómo funciona el modo guiado</h2>
              <p className="mt-2 text-sm text-slate-300 max-w-3xl">
                No es un Chatbot: es un flujo académico por{" "}
                <span className="text-slate-200 font-medium">avances</span> y{" "}
                <span className="text-slate-200 font-medium">etapas</span>, con estructura esperada, checklist y gate.
              </p>
            </div>
          </motion.div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {stages.map((block) => (
              <MagneticCard
                key={block.title}
                className="group relative rounded-[24px] border border-white/10 bg-black/10 p-5 hover:bg-black/15"
                strength={0.55}
              >
                <motion.div variants={fadeUp} className="relative">
                  <div className="pointer-events-none absolute -inset-2 rounded-[26px] bg-sky-500/0 blur-2xl transition group-hover:bg-sky-500/10" />
                  <div className="relative">
                    <div className="text-xs text-slate-400">{block.subtitle}</div>
                    <div className="mt-1 text-base font-semibold text-slate-200">{block.title}</div>

                    {/* ✅ Rendimiento: sin motion por item */}
                    <div className="mt-4 grid grid-cols-1 gap-2">
                      {block.items.map((it) => (
                        <div
                          key={it.n}
                          className="rounded-2xl border border-white/10 bg-black/15 p-3 hover:bg-black/20 transition-transform duration-200 hover:scale-[1.01]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-slate-200">
                                {it.n}) {it.t}
                              </div>
                              <div className="mt-1 text-xs text-slate-400">{it.d}</div>
                            </div>
                            <div className="text-[11px] text-slate-500">Etapa</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              </MagneticCard>
            ))}
          </div>
        </motion.section>

        {/* ✅ RECUPERADO: Privacidad / Seguridad / Google Calendar / Términos */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.25 }}
          variants={fadeUp}
          className="mt-14 rounded-[28px] border border-white/10 bg-white/5 p-6"
        >
          <h2 className="text-lg font-semibold">Privacidad, seguridad y Google Calendar</h2>
          <p className="mt-2 text-sm text-slate-300 max-w-3xl">
            Para cumplir requisitos de verificación OAuth (Google), OPT-IA explica de forma transparente cómo usa los datos.
          </p>

          <div className="mt-5 space-y-3">
            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                <div className="font-semibold text-slate-200">¿Cómo funciona la integración con Google Calendar?</div>
                <div className="text-xs text-slate-400 group-open:hidden">Ver</div>
                <div className="text-xs text-slate-400 hidden group-open:block">Ocultar</div>
              </summary>

              <div className="mt-3 text-sm text-slate-300 space-y-3">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Autorización del estudiante</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    El estudiante autoriza el acceso mediante OAuth 2.0. Esta autorización se usa únicamente para
                    gestionar recordatorios académicos vinculados a OPT-IA.
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

            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                <div className="font-semibold text-slate-200">Seguridad (OAuth 2.0 + almacenamiento de tokens)</div>
                <div className="text-xs text-slate-400 group-open:hidden">Ver</div>
                <div className="text-xs text-slate-400 hidden group-open:block">Ocultar</div>
              </summary>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Principio de menor privilegio</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    OPT-IA solicita únicamente los permisos necesarios para crear/actualizar recordatorios académicos.
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-slate-200">Tokens protegidos</div>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    El refresh token se almacena de forma segura/cifrada. Se usa solo para mantener recordatorios activos
                    sin que el usuario tenga que re-autorizar continuamente.
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

            <details className="group rounded-2xl border border-white/10 bg-black/10 p-4 open:bg-black/15">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
                <div className="font-semibold text-slate-200">Términos de uso (resumen)</div>
                <div className="text-xs text-slate-400 group-open:hidden">Ver</div>
                <div className="text-xs text-slate-400 hidden group-open:block">Ocultar</div>
              </summary>

              <div className="mt-3 text-xs text-slate-400 leading-relaxed space-y-2">
                <p>• OPT-IA es una herramienta de apoyo académico y metodológico.</p>
                <p>• El estudiante es responsable del contenido final y de la veracidad de los datos ingresados.</p>
                <p>• El servicio puede experimentar mantenimientos o mejoras sin previo aviso.</p>
                <p className="pt-2 text-slate-500">
                  Ver documentos completos:{" "}
                  <a className="text-slate-200 underline hover:text-white" href="/privacy">
                    Política de Privacidad
                  </a>{" "}
                  •{" "}
                  <a className="text-slate-200 underline hover:text-white" href="/terms">
                    Términos y Condiciones
                  </a>
                </p>
              </div>
            </details>
          </div>
        </motion.section>

        {/* CTA FINAL */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.25 }}
          variants={fadeUp}
          className="mt-14 relative overflow-hidden rounded-[28px] border border-white/10 bg-white/5 p-6"
        >
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-40 w-[35%] -translate-y-1/2 bg-gradient-to-r from-transparent via-sky-400/22 to-transparent blur-2xl"
            animate={{ x: ["-40%", "140%"] }}
            transition={{ duration: 16, repeat: Infinity, ease: "linear" }}
          />

          <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Empieza con OPT-IA</h2>
              <p className="mt-2 text-sm text-slate-300 max-w-2xl">
                Un asistente académico que convierte las prácticas empresariales en un flujo estructurado, evaluable y
                formativo, garantizando rigor metodológico y trazabilidad.
              </p>
            </div>
            <div className="flex gap-3">
              <LoginButton className="rounded-2xl" />
            </div>
          </div>
        </motion.section>

        <footer className="mt-10 text-xs text-slate-500">
          OPT-IA • Ingeniería Industrial • Prácticas empresariales • Planes de mejora
        </footer>
      </div>
    </main>
  );
}