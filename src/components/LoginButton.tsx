"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";

export function LoginButton() {
  const { ready, authenticated, user, login } = usePrivy();
  const router = useRouter();
  const [loadingRole, setLoadingRole] = useState(false);

  async function goToApp() {
    if (!user) return;

    setLoadingRole(true);
    try {
      const email =
        // @ts-ignore
        user.email?.address ??
        // @ts-ignore
        user.google?.email ??
        null;

      const res = await fetch("/api/auth/after-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          email,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        console.error(data.error || "Error al obtener rol");
        router.push("/chat"); // fallback
        return;
      }

      const role = data.role as "student" | "teacher" | undefined;

      if (role === "teacher") {
        router.push("/docente");
      } else {
        router.push("/chat");
      }
    } catch (err) {
      console.error("Error en goToApp:", err);
      router.push("/chat");
    } finally {
      setLoadingRole(false);
    }
  }

  function handleClick() {
    if (!ready) return;

    if (!authenticated) {
      // abre el modal de Privy
      login();
    } else {
      // ya está logueado → decidir a dónde va
      goToApp();
    }
  }

  const disabled = !ready || loadingRole;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="px-4 py-2 rounded bg-sky-500 hover:bg-sky-600 disabled:opacity-60 text-white text-sm font-medium"
    >
      {loadingRole
        ? "Ingresando..."
        : !ready
        ? "Cargando..."
        : authenticated
        ? "Entrar a OPT-IA"
        : "Iniciar sesión con Privy"}
    </button>
  );
}
