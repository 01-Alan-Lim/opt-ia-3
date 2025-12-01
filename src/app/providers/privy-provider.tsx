"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export function PrivyAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
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
          accentColor: "#0ea5e9",      // azul tipo Tailwind sky-500 (ajusta si quieres)
          logo: "/logo-opt.png",     // 👈 archivo en /public/optia-logo.png
          landingHeader: "Inicia sesión en OPT-IA",
          loginMessage:
            "Accede con tu correo, Google o GitHub para usar el asistente OPT-IA.",
        },

        // Opcional: cómo maneja las wallets internas
        embeddedWallets: {
          createOnLogin: false,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
