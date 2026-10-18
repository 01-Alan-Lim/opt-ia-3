// src/lib/auth/googleIdentity.ts
//
// Inicio de sesión con Google Identity Services (GIS): el botón oficial de Google entrega un ID
// token y Supabase Auth lo valida con signInWithIdToken. Supabase sigue siendo la única sesión; el
// dominio <ref>.supabase.co no aparece en la pantalla de Google porque no hay redirección a él.
//
// Lógica pura, con las dependencias inyectadas (el cableado real está en loginClient.ts):
//   - parseGoogleClientId: NEXT_PUBLIC_GOOGLE_CLIENT_ID con forma de client ID web de Google.
//     Si falta o no tiene esa forma, GIS queda desactivado y se usa el OAuth de siempre.
//   - createGoogleNonce: nonce aleatorio (32 bytes) y su SHA-256 en hexadecimal. A Google va el
//     hash y a Supabase el original: Supabase comprueba que el hash coincide con el del token.
//   - loadGoogleIdentityApi: carga https://accounts.google.com/gsi/client una sola vez.
//   - createGoogleSignInController: un controlador por página. Inicializa GIS una sola vez
//     aunque haya varios botones, dibuja el botón en cada contenedor, ignora credenciales
//     repetidas mientras hay un inicio en curso y avisa si falla para usar el OAuth de respaldo.
//
// Sin One Tap ni selección automática: nunca se llama a prompt(), auto_select es false y al
// inicializar se llama a disableAutoSelect(), así que cerrar sesión no vuelve a abrirla sola.
// Ni el ID token ni el nonce se registran en ningún log.

export const GOOGLE_IDENTITY_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

const CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

export function parseGoogleClientId(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

// ---------------------------------------------------------------- nonce

export type GoogleNonce = Readonly<{ raw: string; hashed: string }>;

type NonceCrypto = Pick<Crypto, "getRandomValues"> & { subtle: Pick<SubtleCrypto, "digest"> };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createGoogleNonce(cryptoImpl: NonceCrypto = globalThis.crypto): Promise<GoogleNonce> {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  const raw = base64Url(bytes);
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ raw, hashed });
}

// ---------------------------------------------------------------- tipos de GIS (lo que se usa)

export type GoogleCredentialResponse = { credential?: string; select_by?: string };

export type GoogleIdConfiguration = {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  nonce: string;
  auto_select: false;
  cancel_on_tap_outside: boolean;
  context: "signin";
  ux_mode: "popup";
  itp_support: boolean;
};

// size "medium" (o "small") evita el botón personalizado con nombre, foto y correo del usuario.
export type GoogleButtonOptions = {
  type: "standard";
  theme: "outline" | "filled_blue" | "filled_black";
  size: "large" | "medium";
  text: "signin_with" | "continue_with";
  shape: "pill" | "rectangular";
  logo_alignment: "left" | "center";
  width?: number;
  locale?: string;
};

// GIS admite anchos de 200 a 400 px. Si el contenedor ocupa la fila (móvil) se usa su ancho; si
// todavía no tiene ancho propio, uno parecido al del botón anterior.
export const GOOGLE_BUTTON_DEFAULT_WIDTH = 260;

export function googleButtonWidth(measuredWidth: number): number {
  const width = Math.floor(Number.isFinite(measuredWidth) ? measuredWidth : 0);
  if (width < 200) return GOOGLE_BUTTON_DEFAULT_WIDTH;
  return Math.min(width, 400);
}

export type GoogleIdApi<Container> = {
  initialize(config: GoogleIdConfiguration): void;
  renderButton(parent: Container, options: GoogleButtonOptions): void;
  disableAutoSelect(): void;
};

// ---------------------------------------------------------------- carga del script

export type ScriptLoaderEnv<Api> = {
  readApi: () => Api | null;
  scriptPresent: () => boolean;
  injectScript: (src: string, onError: () => void) => void;
  wait: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs?: number;
};

export async function loadGoogleIdentityApi<Api>(env: ScriptLoaderEnv<Api>): Promise<Api> {
  const ready = env.readApi();
  if (ready) return ready;

  let failed = false;
  if (!env.scriptPresent()) {
    env.injectScript(GOOGLE_IDENTITY_SCRIPT_SRC, () => {
      failed = true;
    });
  }

  const pollMs = env.pollMs ?? 100;
  for (let waited = 0; waited < env.timeoutMs; waited += pollMs) {
    await env.wait(pollMs);
    const api = env.readApi();
    if (api) return api;
    if (failed) throw new Error("GIS_SCRIPT_ERROR");
  }
  throw new Error("GIS_TIMEOUT");
}

// ---------------------------------------------------------------- controlador

export const GOOGLE_SIGN_IN_ERROR =
  "No se pudo iniciar sesión con Google. Intenta de nuevo o usa el método alternativo.";

export type GoogleSignInState =
  | { status: "unavailable"; reason: "NO_CLIENT_ID" | "SCRIPT_FAILED" }
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; error: string | null }
  | { status: "signing_in" };

export type GoogleSignInDeps<Container> = {
  clientId: string | null;
  loadApi: () => Promise<GoogleIdApi<Container>>;
  createNonce: () => Promise<GoogleNonce>;
  // true si Supabase aceptó el ID token y creó la sesión.
  signIn: (credential: { token: string; nonce: string }) => Promise<boolean>;
  // Con la sesión creada: after-login y redirección (finishBrowserLogin).
  onSignedIn: () => Promise<void>;
};

export type GoogleSignInController<Container> = {
  getState(): GoogleSignInState;
  subscribe(listener: (state: GoogleSignInState) => void): () => void;
  // Registra un contenedor para el botón; devuelve la función para quitarlo.
  mount(container: Container, options: GoogleButtonOptions): () => void;
};

export function createGoogleSignInController<Container>(
  deps: GoogleSignInDeps<Container>,
): GoogleSignInController<Container> {
  let state: GoogleSignInState = deps.clientId ? { status: "idle" } : { status: "unavailable", reason: "NO_CLIENT_ID" };
  let api: GoogleIdApi<Container> | null = null;
  // Un nonce por carga de página: GIS se inicializa una sola vez y el nonce va en esa
  // inicialización.
  let nonce: GoogleNonce | null = null;
  let starting: Promise<void> | null = null;
  const containers = new Map<Container, GoogleButtonOptions>();
  const listeners = new Set<(state: GoogleSignInState) => void>();

  function setState(next: GoogleSignInState) {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function render(container: Container, options: GoogleButtonOptions) {
    if (api && state.status === "ready") api.renderButton(container, options);
  }

  async function handleCredential(response: GoogleCredentialResponse) {
    // Una credencial repetida mientras otra se procesa no inicia una segunda sesión.
    if (state.status !== "ready" || !nonce) return;

    const token = typeof response?.credential === "string" ? response.credential : "";
    if (!token) {
      setState({ status: "ready", error: GOOGLE_SIGN_IN_ERROR });
      return;
    }

    setState({ status: "signing_in" });
    let signedIn = false;
    try {
      signedIn = await deps.signIn({ token, nonce: nonce.raw });
    } catch {
      signedIn = false;
    }

    if (!signedIn) {
      setState({ status: "ready", error: GOOGLE_SIGN_IN_ERROR });
      return;
    }

    try {
      await deps.onSignedIn();
    } finally {
      setState({ status: "ready", error: null });
    }
  }

  function start(): Promise<void> {
    if (starting) return starting;
    if (state.status === "unavailable" || !deps.clientId) return Promise.resolve();
    const clientId = deps.clientId;

    starting = (async () => {
      setState({ status: "loading" });
      try {
        const loaded = await deps.loadApi();
        nonce = await deps.createNonce();
        loaded.initialize({
          client_id: clientId,
          callback: (response) => {
            void handleCredential(response);
          },
          nonce: nonce.hashed,
          auto_select: false,
          cancel_on_tap_outside: true,
          context: "signin",
          ux_mode: "popup",
          itp_support: true,
        });
        loaded.disableAutoSelect();
        api = loaded;
        setState({ status: "ready", error: null });
        for (const [container, options] of containers) render(container, options);
      } catch {
        api = null;
        nonce = null;
        setState({ status: "unavailable", reason: "SCRIPT_FAILED" });
      }
    })();
    return starting;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount(container, options) {
      containers.set(container, options);
      render(container, options);
      void start();
      return () => {
        containers.delete(container);
      };
    },
  };
}
