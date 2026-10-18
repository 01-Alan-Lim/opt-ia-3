// src/lib/auth/finishLogin.ts
//
// Fin del inicio de sesión, común a los dos caminos de entrada: el callback de OAuth
// (/auth/callback) y el botón (Google Identity Services o "Entrar a OPT-IA"). Con la sesión de
// Supabase ya guardada en el navegador, llama a POST /api/auth/after-login, que es quien decide
// el rol (y rechaza correos no autorizados), y lleva al usuario a su sitio:
//   - docente -> /docente; estudiante -> /chat (el gate de /chat manda al onboarding, a
//     "pendiente de aprobación" o a "acceso vencido" según /api/me);
//   - 403 (correo no autorizado) -> cierra sesión y vuelve a /?reason=forbidden;
//   - 401 (sesión inválida) -> cierra sesión y vuelve a /. La portada no inicia sesión sola, así
//     que no hay bucle;
//   - sin sesión o cualquier otro fallo -> vuelve a /.
//
// Lógica pura con dependencias inyectadas; el cliente real está en loginClient.ts. Nunca envía
// ni registra el token: solo lo pasa a postAfterLogin, que lo usa como Bearer.

export type FinishLoginOutcome =
  | { kind: "redirected"; to: "/chat" | "/docente" }
  | { kind: "no_session" }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

export type AfterLoginResponse = { status: number; ok: boolean; body: unknown };

export type FinishLoginDeps = {
  getAccessToken: () => Promise<string | null>;
  postAfterLogin: (accessToken: string) => Promise<AfterLoginResponse>;
  signOut: () => Promise<void>;
  navigate: (path: string) => void;
  onStatus?: (message: string) => void;
};

export const FINISH_LOGIN_MESSAGES = {
  noSession: "No se pudo obtener sesión. Intenta iniciar sesión nuevamente.",
  verifying: "Verificando perfil...",
  forbidden: "Acceso restringido. Usa un correo institucional autorizado.",
  unauthorized: "Sesión inválida. Inicia sesión nuevamente.",
  failed: "No se pudo verificar tu perfil. Intenta nuevamente.",
} as const;

function roleFrom(body: unknown): "teacher" | "student" {
  if (!body || typeof body !== "object") return "student";
  const record = body as Record<string, unknown>;
  const payload = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  return payload.role === "teacher" ? "teacher" : "student";
}

export async function finishLogin(deps: FinishLoginDeps): Promise<FinishLoginOutcome> {
  const status = deps.onStatus ?? (() => undefined);

  const token = await deps.getAccessToken();
  if (!token) {
    status(FINISH_LOGIN_MESSAGES.noSession);
    deps.navigate("/");
    return { kind: "no_session" };
  }

  status(FINISH_LOGIN_MESSAGES.verifying);

  let res: AfterLoginResponse;
  try {
    res = await deps.postAfterLogin(token);
  } catch {
    status(FINISH_LOGIN_MESSAGES.failed);
    deps.navigate("/");
    return { kind: "failed" };
  }

  if (res.status === 403) {
    status(FINISH_LOGIN_MESSAGES.forbidden);
    await deps.signOut();
    deps.navigate("/?reason=forbidden");
    return { kind: "forbidden" };
  }

  if (res.status === 401) {
    status(FINISH_LOGIN_MESSAGES.unauthorized);
    await deps.signOut();
    deps.navigate("/");
    return { kind: "unauthorized" };
  }

  if (!res.ok) {
    status(FINISH_LOGIN_MESSAGES.failed);
    deps.navigate("/");
    return { kind: "failed" };
  }

  const to = roleFrom(res.body) === "teacher" ? "/docente" : "/chat";
  deps.navigate(to);
  return { kind: "redirected", to };
}

// Una sola ejecución a la vez: si se vuelve a pedir mientras corre (dos botones, el botón y el
// callback, un doble clic), se devuelve la misma promesa en vez de llamar otra vez a
// after-login. Al terminar se puede volver a ejecutar.
export function createSingleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: A) => {
    if (inFlight) return inFlight;
    const run = fn(...args).finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
