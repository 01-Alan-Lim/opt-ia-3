// src/lib/plan/messageRouteHarness.ts

// SOLO PARA TESTS. Ejecuta las rutas reales que escriben mensajes (/api/messages,
// /api/plans/context) sin red: reemplaza fetch por un Supabase simulado (Auth y PostgREST) con
// tablas en memoria. La tabla messages imita la de producción con M2 (CHECK de role e índices
// únicos de receipt_nonce y de chat_id+client_message_id, con los mismos códigos y estados que
// PostgREST: 23505 -> 409, 23514/PGRST204 -> 400) o sin M2 (schema "m1"). Cualquier otro destino
// falla: ningún test puede tocar una base real ni llamar a Gemini.
//
// Ninguna ruta ni componente importa este archivo.

import { TEST_SUPABASE_URL } from "./assistantRouteHarness";

const SUPABASE_HOST = new URL(TEST_SUPABASE_URL).host;

export type MessageRowStub = {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  created_at: string;
  receipt_nonce: string | null;
  client_message_id: string | null;
};

export type MessageStubState = {
  user: { id: string; email: string } | null;
  profile: Record<string, unknown> | null;
  cohortActive: boolean;
  chats: Record<string, { client_id: string; mode: string | null }>;
  messages: MessageRowStub[];
  // m2: esquema con la migración; m1: esquema actual de producción, sin M2.
  schema: "m1" | "m2";
  // plan_case_contexts por user_id (para /api/plans/context).
  contexts: Record<string, Record<string, unknown>>;
};

export type MessageStub = {
  calls: Array<{ method: string; table: string | null }>;
  writes(table: string): number;
  reset(): void;
  restore(): void;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const pgError = (status: number, code: string, message: string) => json({ code, details: null, hint: null, message }, status);

function eqFilters(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of params) {
    if (value.startsWith("eq.")) out[name] = value.slice(3);
  }
  return out;
}

let clock = Date.parse("2026-10-18T15:00:00Z");
const nextTimestamp = () => new Date((clock += 1000)).toISOString();

const M1_ROLES = ["user", "assistant", "system"];
const M2_ROLES = ["user", "assistant", "advisor"];
const M2_COLUMNS = ["receipt_nonce", "client_message_id"];

export function installMessageStub(state: MessageStubState): MessageStub {
  const calls: Array<{ method: string; table: string | null }> = [];
  const original = globalThis.fetch;

  function insertMessage(body: Record<string, unknown>): Response {
    if (state.schema === "m1") {
      const unknown = M2_COLUMNS.find((c) => c in body);
      if (unknown) return pgError(400, "PGRST204", `Could not find the '${unknown}' column of 'messages' in the schema cache`);
    }
    const roles = state.schema === "m1" ? M1_ROLES : M2_ROLES;
    if (!roles.includes(String(body.role))) {
      return pgError(400, "23514", 'new row for relation "messages" violates check constraint "messages_role_check"');
    }
    const chatId = String(body.chat_id);
    if (!state.chats[chatId]) {
      return pgError(409, "23503", 'insert or update on table "messages" violates foreign key constraint "messages_chat_fk"');
    }
    const nonce = typeof body.receipt_nonce === "string" ? body.receipt_nonce : null;
    const clientId = typeof body.client_message_id === "string" ? body.client_message_id : null;
    if (nonce && state.messages.some((m) => m.receipt_nonce === nonce)) {
      return pgError(409, "23505", 'duplicate key value violates unique constraint "messages_receipt_nonce_key"');
    }
    if (clientId && state.messages.some((m) => m.chat_id === chatId && m.client_message_id === clientId)) {
      return pgError(409, "23505", 'duplicate key value violates unique constraint "messages_chat_client_message_id_key"');
    }
    const row: MessageRowStub = {
      id: crypto.randomUUID(),
      chat_id: chatId,
      role: String(body.role),
      content: String(body.content),
      created_at: nextTimestamp(),
      receipt_nonce: nonce,
      client_message_id: clientId,
    };
    state.messages.push(row);
    return json(row, 201);
  }

  function selectMessages(params: URLSearchParams): Response | MessageRowStub[] {
    const filters = eqFilters(params);
    if (state.schema === "m1") {
      const unknown = M2_COLUMNS.find((c) => c in filters);
      if (unknown) return pgError(400, "42703", `column messages.${unknown} does not exist`);
    }
    let rows = state.messages.filter((m) =>
      Object.entries(filters).every(([column, value]) => String(m[column as keyof MessageRowStub]) === value),
    );
    if ((params.get("order") ?? "").startsWith("created_at")) {
      rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return rows;
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const table =
      url.host === SUPABASE_HOST && url.pathname.startsWith("/rest/v1/") ? url.pathname.slice("/rest/v1/".length) : null;
    calls.push({ method: req.method, table });

    // Deja que otras peticiones se intercalen, como en un servidor real.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (url.host !== SUPABASE_HOST) {
      throw new TypeError(`Red bloqueada en tests: ${req.method} ${url.host}${url.pathname}`);
    }

    if (url.pathname === "/auth/v1/user") {
      if (!state.user) return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
      return json({ id: state.user.id, aud: "authenticated", role: "authenticated", email: state.user.email, app_metadata: {}, user_metadata: {} });
    }
    if (table === null) throw new TypeError(`Ruta de Supabase no simulada: ${url.pathname}`);

    const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const respond = (rows: unknown[], status = 200) => {
      if (!wantsObject) return json(rows, status);
      if (rows.length === 1) return json(rows[0], status);
      return pgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
    };
    const body = req.method === "GET" || req.method === "HEAD" ? null : ((await req.json()) as Record<string, unknown>);
    const filters = eqFilters(url.searchParams);

    switch (table) {
      case "profiles":
        return respond(state.profile ? [state.profile] : []);
      case "cohorts":
        return respond([{ id: state.profile?.cohort_id ?? null, is_active: state.cohortActive }]);
      case "chats": {
        if (req.method === "POST" && body) {
          const id = crypto.randomUUID();
          state.chats[id] = { client_id: String(body.client_id), mode: (body.mode as string | undefined) ?? "general" };
          return respond([{ id, ...state.chats[id] }], 201);
        }
        const id = filters.id ?? "";
        const chat = state.chats[id];
        return respond(chat ? [{ id, client_id: chat.client_id, mode: chat.mode }] : []);
      }
      case "messages": {
        if (req.method === "POST" && body) return insertMessage(body);
        if (req.method !== "GET") return pgError(403, "42501", "permission denied for table messages");
        const rows = selectMessages(url.searchParams);
        return rows instanceof Response ? rows : respond(rows);
      }
      case "plan_case_contexts": {
        if (req.method === "POST" && body) {
          const userId = String(body.user_id);
          state.contexts[userId] = { ...state.contexts[userId], ...body, updated_at: nextTimestamp() };
          return respond([state.contexts[userId]], 201);
        }
        const row = state.contexts[filters.user_id ?? ""];
        if (req.method === "PATCH" && body) {
          // Escritura condicional sobre chat_id (eq.<id> o is.null), como la de planChat.ts.
          const chatFilter = url.searchParams.get("chat_id");
          const current = row?.chat_id ?? null;
          const matchesChat = !chatFilter || (chatFilter === "is.null" ? current === null : chatFilter === `eq.${current}`);
          if (!row || !matchesChat) return respond([]);
          Object.assign(row, body, { updated_at: nextTimestamp() });
          return respond([row]);
        }
        return respond(row ? [row] : []);
      }
      // Estados de etapa: estos tests no tienen avance en E1-E10. Confirmar E0 crea el de E1
      // (advancePlanStage): se acepta y no se guarda.
      case "plan_stage_states":
        if (req.method === "POST" && body) return respond([{ id: crypto.randomUUID(), ...body }], 201);
        return respond([]);
      default:
        return pgError(404, "42P01", `relation "${table}" does not exist`);
    }
  };

  return {
    calls,
    writes(name) {
      return calls.filter((c) => c.table === name && c.method !== "GET" && c.method !== "HEAD").length;
    },
    reset() {
      calls.length = 0;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
