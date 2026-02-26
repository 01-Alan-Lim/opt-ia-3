// src/app/terms/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Spotlight } from "@/components/Spotlight";

export const metadata: Metadata = {
  title: "Términos y Condiciones | OPT-IA",
  description: "Términos y Condiciones de uso de OPT-IA.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen midnightStars text-slate-100">
      <Spotlight />
      <div className="starsBright" />

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold">Términos y Condiciones</h1>
          <p className="text-sm text-slate-300 mt-2">
            Última actualización: {new Date().toISOString().slice(0, 10)}
          </p>
        </header>

        <section className="space-y-6 text-sm text-slate-200 leading-6">
          <p>
            Estos Términos regulan el uso de OPT-IA. Al acceder o usar la plataforma, aceptas estos
            Términos.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">1. Uso académico</h2>
          <p>
            OPT-IA está orientado a fines académicos (prácticas empresariales, seguimiento y elaboración
            de planes de mejora). Debes usar la plataforma de forma responsable y conforme a normas
            institucionales.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">2. Cuenta y acceso</h2>
          <p>
            Eres responsable de mantener la confidencialidad de tu acceso. El sistema puede restringir
            funcionalidades según rol (estudiante/docente) y reglas de cohorte.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">3. Integración con Google Calendar</h2>
          <p>
            Si conectas Google Calendar, autorizas a OPT-IA a crear y actualizar eventos académicos
            relacionados con tu cohorte. Puedes revocar el permiso en cualquier momento desde tu cuenta
            Google.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">4. Disponibilidad</h2>
          <p>
            OPT-IA se ofrece “tal cual”. Se realizarán esfuerzos razonables para mantener la disponibilidad,
            pero pueden ocurrir interrupciones por mantenimiento o fallas de terceros (por ejemplo, Google).
          </p>

          <h2 className="text-lg font-semibold text-slate-100">5. Contenido y responsabilidad</h2>
          <p>
            Las recomendaciones generadas por la plataforma son de apoyo académico. La responsabilidad final
            de las entregas y decisiones recae en el usuario y/o su tutor/docente.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">6. Cambios</h2>
          <p>
            Podemos actualizar estos Términos. La fecha de actualización se mostrará en esta página.
          </p>

          <h2 className="text-lg font-semibold text-slate-100">7. Contacto</h2>
          <p>
            Para consultas:{" "}
            <span className="text-slate-100 font-medium">alimachi.404@gmail.com</span>
          </p>
        </section>

        <footer className="mt-10 pt-6 border-t border-white/10 text-xs text-slate-400 flex gap-4">
          <Link className="hover:text-slate-200" href="/">
            Volver
          </Link>
          <Link className="hover:text-slate-200" href="/privacy">
            Privacidad
          </Link>
        </footer>
      </div>
    </main>
  );
}