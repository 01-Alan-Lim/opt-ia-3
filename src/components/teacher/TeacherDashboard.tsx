"use client";

export function TeacherDashboard() {
  const url = process.env.NEXT_PUBLIC_LOOKER_REPORT_URL;
  const hasUrl = Boolean(url);

  return (
    <div className="space-y-4">
      {!hasUrl && (
        <div className="rounded-2xl border border-amber-800 bg-amber-950/20 p-4 text-sm text-amber-200">
          Falta configurar la URL de embed del reporte en{" "}
          <code className="text-amber-100">.env.local</code>.
        </div>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/20 overflow-hidden">
        {hasUrl ? (
          <iframe
            src={url}
            title="Looker Studio Report"
            className="w-full"
            style={{ height: "calc(100vh - 160px)" }}
            frameBorder={0}
            allowFullScreen
          />
        ) : (
          <div className="p-6 text-sm text-slate-400">
            Configura la URL de Looker Studio para poder visualizar el reporte.
          </div>
        )}
      </div>
    </div>
  );
}