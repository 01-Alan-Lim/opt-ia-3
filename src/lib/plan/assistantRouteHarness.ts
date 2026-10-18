// src/lib/plan/assistantRouteHarness.ts

// SOLO PARA TESTS. Permite ejecutar las rutas reales /api/plans/*/assistant sin red: fija un
// entorno de prueba y reemplaza fetch por un servidor simulado de Supabase (Auth y REST) y de
// Gemini. supabase-js y @google/generative-ai resuelven fetch en cada llamada, así que todo
// pasa por aquí. Cualquier otro destino falla, y las escrituras en la API REST se registran y
// se rechazan: ningún test puede tocar una base real ni llamar a un modelo facturable.
//
// Ninguna ruta ni componente importa este archivo.

import { NextRequest } from "next/server";

export const TEST_SUPABASE_URL = "https://supabase.opt-ia.test";
const SUPABASE_HOST = new URL(TEST_SUPABASE_URL).host;
const GEMINI_HOST = "generativelanguage.googleapis.com";

export type RouteStubState = {
  // Usuario que devuelve /auth/v1/user para cualquier token; null = sesión inválida.
  user: { id: string; email: string } | null;
  profile: Record<string, unknown> | null;
  cohortActive: boolean;
  // chatId -> client_id.
  chatOwners: Record<string, string>;
  // Fila que devuelve plan_stage_artifacts (artefacto validado de la etapa previa).
  artifact: Record<string, unknown> | null;
  // Textos que devolverá Gemini, en orden.
  geminiReplies: string[];
};

export type StubCall = {
  method: string;
  host: string;
  path: string;
  table: string | null;
};

export type FetchStub = {
  calls: StubCall[];
  writes: StubCall[];
  reset(): void;
  tables(): string[];
  geminiCalls(): number;
  restore(): void;
};

// Fija el entorno de prueba, sobrescribiendo lo que hubiera. Debe llamarse ANTES de importar
// las rutas (supabaseServer y geminiClient leen el entorno al cargarse).
export function prepareRouteTestEnv(extra: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-de-prueba",
    SUPABASE_SERVICE_ROLE_KEY: "service-key-de-prueba",
    GEMINI_API_KEY: "gemini-key-de-prueba",
    GEMINI_MODEL: "gemini-modelo-de-prueba",
    ALLOWED_EMAIL_DOMAIN: undefined,
    TEACHER_EMAIL_ALLOWLIST: undefined,
    STUDENT_TEST_EMAIL_ALLOWLIST: undefined,
    ASSISTANT_RECEIPT_SECRET: undefined,
    NEXT_PUBLIC_ASSISTANT_RECEIPT_SECRET: undefined,
    ...extra,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rowsFor(table: string, params: URLSearchParams, state: RouteStubState): unknown[] {
  switch (table) {
    case "profiles":
      return state.profile ? [state.profile] : [];
    case "cohorts":
      return [{ id: state.profile?.cohort_id ?? null, is_active: state.cohortActive }];
    case "chats": {
      const id = (params.get("id") ?? "").replace(/^eq\./, "");
      const owner = state.chatOwners[id];
      return owner ? [{ id, client_id: owner }] : [];
    }
    case "plan_stage_artifacts":
      return state.artifact ? [state.artifact] : [];
    default:
      return [];
  }
}

export function installFetchStub(state: RouteStubState): FetchStub {
  const calls: StubCall[] = [];
  const writes: StubCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const table =
      url.host === SUPABASE_HOST && url.pathname.startsWith("/rest/v1/")
        ? url.pathname.slice("/rest/v1/".length)
        : null;
    const call: StubCall = { method: req.method, host: url.host, path: url.pathname, table };
    calls.push(call);

    if (url.host === SUPABASE_HOST) {
      if (url.pathname === "/auth/v1/user") {
        if (!state.user) return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
        return json({
          id: state.user.id,
          aud: "authenticated",
          role: "authenticated",
          email: state.user.email,
          app_metadata: {},
          user_metadata: {},
          created_at: "2026-01-01T00:00:00Z",
        });
      }

      if (table !== null) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          writes.push(call);
          return json({ message: "Escrituras bloqueadas en tests." }, 403);
        }
        const rows = rowsFor(table, url.searchParams, state);
        if ((req.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
          if (rows.length === 1) return json(rows[0]);
          return json(
            { code: "PGRST116", details: null, hint: null, message: "JSON object requested, multiple (or no) rows returned" },
            406,
          );
        }
        return json(rows);
      }
    }

    if (url.host === GEMINI_HOST) {
      const text = state.geminiReplies.shift();
      if (text === undefined) return json({ error: { code: 500, message: "Sin respuesta simulada." } }, 500);
      return json({
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
      });
    }

    throw new TypeError(`Red bloqueada en tests: ${req.method} ${url.host}${url.pathname}`);
  };

  return {
    calls,
    writes,
    reset() {
      calls.length = 0;
      writes.length = 0;
    },
    tables() {
      return calls.filter((c) => c.table !== null).map((c) => c.table as string);
    },
    geminiCalls() {
      return calls.filter((c) => c.host === GEMINI_HOST).length;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function routeRequest(path: string, body: unknown, token: string | null = "token-de-prueba"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`https://opt-ia.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function approvedProfile(userId: string, cohortId: string): Record<string, unknown> {
  return {
    user_id: userId,
    email: "ana.prueba@estudiante.test",
    role: "student",
    ru: "1234567",
    first_name: "Ana",
    last_name: "Prueba",
    semester: "1",
    cohort_id: cohortId,
    registration_status: "approved",
    access_starts_at: null,
    access_ends_at: null,
  };
}
