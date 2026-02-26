// src/app/privacy/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Spotlight } from "@/components/Spotlight";

export const metadata: Metadata = {
  title: "Política de Privacidad | OPT-IA",
  description: "Política de Privacidad de OPT-IA (integración con Google Calendar).",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen midnightStars text-slate-100">
      <Spotlight />
      <div className="starsBright" />

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold">Política de Privacidad</h1>
          <p className="text-sm text-slate-300 mt-2">
            Última actualización: {new Date().toISOString().slice(0, 10)}
          </p>
        </header>

        <section className="space-y-6 text-sm text-slate-200 leading-6">
          <p>
            OPT-IA es una aplicación académica que acompaña a estudiantes en sus prácticas
            empresariales y puede integrarse con Google Calendar para crear y actualizar
            recordatorios relacionados con actividades de la cohorte (formularios, avances y fechas).
          </p>

          <h2 className="text-lg font-semibold text-slate-100">1. Datos que recopilamos</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              Datos de cuenta para autenticación (por ejemplo, correo) necesarios para acceder a la plataforma.
            </li>
            <li>
              Configuración académica asociada al estudiante (por ejemplo, cohorte) para calcular recordatorios.
            </li>
            <li>
              Si conectas Google Calendar: identificador del calendario (por ejemplo “primary”) y un token de actualización
              (<i>refresh token</i>) para mantener la sincronización.
            </li>
            <li>
              Mapeos internos de eventos (IDs) para poder <b>actualizar</b> eventos ya creados y evitar duplicados.
            </li>
          </ul>

          <h2 className="text-lg font-semibold text-slate-100">2. Cómo usamos tus datos</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Para permitir el acceso a OPT-IA y asociar tu progreso académico.</li>
            <li>
              Para sincronizar recordatorios académicos en tu Google Calendar (crear/actualizar eventos) según la configuración de la cohorte.
            </li>
            <li>
              Para mejorar la estabilidad del sistema (por ejemplo, evitar duplicación de eventos mediante mapeos).
            </li>
          </ul>

          <h2 className="text-lg font-semibold text-slate-100">3. Google Calendar (OAuth)</h2>
          <p>
            Cuando conectas tu Google Calendar, autorizas a OPT-IA a gestionar eventos académicos.
            OPT-IA usa OAuth 2.0 y conserva la autorización necesaria para mantener la sincronización
            mientras tú no revoques el permiso.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">4. Almacenamiento y seguridad</h2>
          <p>
            Los datos se almacenan en infraestructura de base de datos con controles de acceso. Se aplican
            reglas de acceso a nivel de fila (RLS) para limitar qué datos puede ver o modificar cada usuario
            según su rol (estudiante/docente).
          </p>

          <h2 className="text-lg font-semibold text-slate-100">5. Compartición con terceros</h2>
          <p>
            No vendemos tu información. Solo compartimos datos con proveedores estrictamente necesarios para
            operar la plataforma (por ejemplo, Google para la sincronización de Calendar).
          </p>

          <h2 className="text-lg font-semibold text-slate-100">6. Revocar acceso a Google</h2>
          <p>
            Puedes revocar el acceso de OPT-IA a tu cuenta de Google en cualquier momento desde la configuración
            de permisos de tu cuenta Google. Si revocas el acceso, OPT-IA ya no podrá crear/actualizar eventos.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">7. Contacto</h2>
          <p>
            Si tienes preguntas sobre privacidad, contáctanos en:{" "}
            <span className="text-slate-100 font-medium">alimachi.404@gmail.com</span>
          </p>
        </section>

        <footer className="mt-10 pt-6 border-t border-white/10 text-xs text-slate-400 flex gap-4">
          <Link className="hover:text-slate-200" href="/">
            Volver
          </Link>
          <Link className="hover:text-slate-200" href="/terms">
            Términos
          </Link>
        </footer>
      </div>
    </main>
  );
}