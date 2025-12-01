import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// 👉 Importante: agrega tu provider de Privy
import { PrivyAuthProvider } from "./providers/privy-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OPT-IA",
  description: "Agente con IA para productividad de MyPEs",
  icons: {
    icon: "/logo-opt.ico",      // 👈 tu logo en /public/logo-opt.png
    shortcut: "/logo-opt.ico",
    apple: "/logo-opt.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* 👉 Ahora todo tu app está envuelta en el provider de Privy */}
        <PrivyAuthProvider>
          {children}
        </PrivyAuthProvider>
      </body>
    </html>
  );
}
