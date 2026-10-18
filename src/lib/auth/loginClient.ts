// src/lib/auth/loginClient.ts
//
// Piezas del inicio de sesión que usan el navegador y el cliente de Supabase Auth existente
// (src/lib/supabaseClient.ts). Solo para componentes de cliente.

import { supabase } from "@/lib/supabaseClient";
import { createSingleFlight, finishLogin, type AfterLoginResponse } from "@/lib/auth/finishLogin";
import {
  createGoogleNonce,
  createGoogleSignInController,
  GOOGLE_IDENTITY_SCRIPT_SRC,
  loadGoogleIdentityApi,
  parseGoogleClientId,
  type GoogleIdApi,
  type GoogleSignInController,
} from "@/lib/auth/googleIdentity";

// Identificador público del cliente web de Google (no es un secreto). Se lee con el nombre
// literal para que Next.js lo incruste en el bundle del navegador.
const GOOGLE_CLIENT_ID = parseGoogleClientId(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);

const GIS_LOAD_TIMEOUT_MS = 8000;

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

// ---------------------------------------------------------------- Google Identity Services

type WindowWithGoogle = Window & { google?: { accounts?: { id?: GoogleIdApi<HTMLElement> } } };

function loadBrowserGoogleApi(): Promise<GoogleIdApi<HTMLElement>> {
  return loadGoogleIdentityApi<GoogleIdApi<HTMLElement>>({
    readApi: () => (window as WindowWithGoogle).google?.accounts?.id ?? null,
    scriptPresent: () => document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`) !== null,
    injectScript: (src, onError) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.defer = true;
      script.addEventListener("error", onError, { once: true });
      document.head.appendChild(script);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: GIS_LOAD_TIMEOUT_MS,
  });
}

// Supabase valida el ID token (firma, emisor, audiencia y nonce) y crea la sesión de siempre.
// Si falla, solo se registra el código de error, nunca el token.
async function signInWithGoogleIdToken(credential: { token: string; nonce: string }): Promise<boolean> {
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: credential.token,
    nonce: credential.nonce,
  });
  if (error || !data.session) {
    console.warn("[auth] Google Identity Services: Supabase rechazó el inicio de sesión", {
      status: error?.status ?? null,
      code: error?.code ?? null,
    });
    return false;
  }
  return true;
}

// Los LoginButton montados registran su router; el último activo es el que navega al terminar.
let loginNavigator: ((path: string) => void) | null = null;

export function setLoginNavigator(navigate: (path: string) => void): () => void {
  loginNavigator = navigate;
  return () => {
    if (loginNavigator === navigate) loginNavigator = null;
  };
}

function navigateAfterLogin(path: string) {
  if (loginNavigator) loginNavigator(path);
  else window.location.assign(path);
}

let googleController: GoogleSignInController<HTMLElement> | null = null;

// Un único controlador por página, compartido por todos los LoginButton.
export function getGoogleSignInController(): GoogleSignInController<HTMLElement> {
  if (!googleController) {
    googleController = createGoogleSignInController<HTMLElement>({
      clientId: GOOGLE_CLIENT_ID,
      loadApi: loadBrowserGoogleApi,
      createNonce: () => createGoogleNonce(),
      signIn: signInWithGoogleIdToken,
      onSignedIn: async () => {
        await finishBrowserLogin(navigateAfterLogin);
      },
    });
  }
  return googleController;
}
