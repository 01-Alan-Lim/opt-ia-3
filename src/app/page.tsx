import { Suspense } from "react";
import { LoginButton } from "@/components/LoginButton";
import { AuthNotice } from "@/components/auth/AuthNotice";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
      <div className="max-w-xl w-full px-6">
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>

        <h1 className="text-3xl font-semibold mb-4">OPT-IA</h1>

        <p className="text-sm text-slate-300 mb-6">
          Agente con Inteligencia Artificial para el incremento de productividad.
          Esta es la nueva versión del sistema.
        </p>

        <div className="flex flex-col sm:flex-row gap-3">
          {/* Botón principal: inicia sesión con Google (Supabase). Si ya está logueado, envía a /chat o /docente */}
          <LoginButton />
        </div>

        <p className="mt-6 text-xs text-slate-500">
          Más adelante esta página puede convertirse en el landing oficial
          (explicando qué es OPT-IA, casos de uso, etc.).
        </p>
      </div>
    </main>
  );
}
