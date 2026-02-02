//src/app/layout.tsx
import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OPT-IA",
  description: "Agente con IA para el incremento de productividad",
  icons: {
    icon: "/icon.ico",
    shortcut: "/icon.ico",
    apple: "/icon.png",
  },
};

const THEME_INIT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem("optia-theme");
    if (t === "light" || t === "dark") {
      document.documentElement.dataset.theme = t;
    } else {
      // default: dark (como está hoy)
      document.documentElement.dataset.theme = "dark";
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" data-theme="dark" suppressHydrationWarning>
      <head>
        <Script id="optia-theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body className={`${inter.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
