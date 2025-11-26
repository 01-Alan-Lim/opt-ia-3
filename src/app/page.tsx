import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
      <div className="max-w-xl w-full px-6">
        <h1 className="text-3xl font-semibold mb-4">
          OPT-IA 3
        </h1>
        <p className="text-sm text-slate-300 mb-6">
          Agente con Inteligencia Artificial para el incremento de productividad.
          Esta es la nueva versión del sistema, optimizada para usar servicios
          más económicos (Supabase, Google AI, Vercel, etc.).
        </p>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href="/auth"
            className="inline-flex items-center justify-center rounded-lg bg-sky-500 hover:bg-sky-600 px-4 py-2 text-sm font-medium transition"
          >
            Ir a iniciar sesión
          </Link>
          <Link
            href="/chat"
            className="inline-flex items-center justify-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-900 transition"
          >
            Ir al chat (demo)
          </Link>
        </div>

        <p className="mt-6 text-xs text-slate-500">
          Más adelante esta página puede convertirse en el landing oficial
          (explicando qué es OPT-IA, casos de uso, etc.).
        </p>
      </div>
    </main>
  );
}
