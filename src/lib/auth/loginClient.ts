// src/lib/auth/loginClient.ts
//
// Piezas del inicio de sesión que usan el navegador y el cliente de Supabase Auth existente
// (src/lib/supabaseClient.ts). Solo para componentes de cliente.

import { supabase } from "@/lib/supabaseClient";
import { createSingleFlight, finishLogin, type AfterLoginResponse } from "@/lib/auth/finishLogin";

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// La identidad la resuelve el servidor con el Bearer: el cuerpo va vacío, sin ningún userId.
async function postAfterLogin(accessToken: string): Promise<AfterLoginResponse> {
  const res = await fetch("/api/auth/after-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  });
  const json: unknown = await res.json().catch(() => null);
  const explicitFailure =
    json !== null && typeof json === "object" && (json as Record<string, unknown>).ok === false;
  return { status: res.status, ok: res.ok && !explicitFailure, body: json };
}

async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

// Termina el inicio de sesión y redirige (ver finishLogin.ts). Si ya hay uno en curso, devuelve
// el mismo: after-login nunca se llama dos veces a la vez.
export const finishBrowserLogin = createSingleFlight(
  (navigate: (path: string) => void, onStatus?: (message: string) => void) =>
    finishLogin({ getAccessToken, postAfterLogin, signOut, navigate, onStatus }),
);
