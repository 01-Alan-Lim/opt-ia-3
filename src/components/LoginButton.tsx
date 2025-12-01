"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";

export function LoginButton() {
  const { login, logout, authenticated, user, ready } = usePrivy();
  const router = useRouter();

  if (!ready) {
    return (
      <button
        className="px-4 py-2 rounded bg-slate-600 text-white opacity-60 cursor-not-allowed"
        disabled
      >
        Cargando...
      </button>
    );
  }

  const handleClick = async () => {
    if (!authenticated) {
      await login(); // abre el modal de Privy
    } else {
      // si ya está logueado, lo mandamos directo al chat
      router.push("/chat");
    }
  };

  const label = authenticated
    ? `Ir al chat (${user?.email?.address ?? "usuario"})`
    : "Iniciar sesión";

  return (
    <button
      onClick={handleClick}
      className="px-4 py-2 rounded bg-sky-500 hover:bg-sky-600 text-white font-medium"
    >
      {label}
    </button>
  );
}
