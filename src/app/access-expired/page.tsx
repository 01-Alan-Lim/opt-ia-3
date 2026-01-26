export default function AccessExpiredPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 px-6">
      <div className="max-w-xl w-full text-center">
        <h1 className="text-2xl font-semibold mb-3">Acceso expirado</h1>
        <p className="text-sm text-slate-300 mb-3">
          Tu periodo de acceso a OPT-IA terminó. Si crees que es un error, contacta al docente.
        </p>
        <p className="text-xs text-slate-500">
          (Esto se controla por cohorte y fechas de acceso).
        </p>
      </div>
    </main>
  );
}
