// src/app/providers/privy-provider.tsx
"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";

interface PrivyAuthProviderProps {
  children: ReactNode;
}

export function PrivyAuthProvider({ children }: PrivyAuthProviderProps) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    console.warn(
      "⚠️ NEXT_PUBLIC_PRIVY_APP_ID no está definido. Privy no funcionará correctamente."
    );
  }

  return (
    <PrivyProvider
      appId={appId ?? ""}
      config={{
        // Métodos de login permitidos
        loginMethods: ["email", "google", "github"],

        // Apariencia del widget de Privy
        appearance: {
          theme: "dark",
          accentColor: "#0ea5e9", // azul tipo Tailwind sky-500
          logo: "/logo-opt.png",
          landingHeader: "Inicia sesión en OPT-IA",
          loginMessage:
            "Accede con tu correo, Google o GitHub para usar el asistente OPT-IA.",
        },

        // Cómo maneja las wallets internas
        embeddedWallets: {
          ethereum: {
            // Opciones válidas: "off" | "users-without-wallets" | "all-users"
            createOnLogin: "off",
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
