"use client";

import { useSearchParams, useRouter } from "next/navigation";

export function AuthNotice() {
  const params = useSearchParams();
  const router = useRouter();

  const reason = params.get("reason");

  if (reason !== "forbidden") return null;

  return (
    <div className="mb-6 rounded-xl border border-red-800/40 bg-red-950/40 px-4 py-3 text-sm text-red-100">
      <div className="flex items-center justify-between gap-4">
        <p>
          Acceso restringido. Debes iniciar sesión con un correo institucional autorizado.
        </p>
        <button
          className="text-xs text-red-200 hover:text-white"
          onClick={() => router.replace("/")}
        >
          Cerrar
        </button>
      </div>
    </div>
  );
}
