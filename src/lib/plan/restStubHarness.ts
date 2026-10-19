// src/lib/plan/restStubHarness.ts

// SOLO PARA TESTS. Supabase simulado (Auth y PostgREST) con tablas en memoria, para ejecutar
// rutas y módulos de servidor reales sin red. Entiende lo que usa supabase-js en este proyecto:
//   - GET con filtros col=eq|neq|is|in|gte|gt|lte|lt, order=col.asc|desc, limit;
//   - POST (insert, y upsert con Prefer resolution=merge-duplicates + on_conflict);
//   - PATCH (update) y DELETE con filtros;
//   - Accept vnd.pgrst.object (single) -> 406 PGRST116 si no hay exactamente una fila.
// Las restricciones únicas se declaran por tabla (con un predicado para los índices parciales)
// y devuelven 409 23505, como PostgREST. Una tabla en `missingTables` responde 404 PGRST205.
// Cualquier destino que no sea el Supabase de prueba pasa a `external` o falla.
//
// Ninguna ruta ni componente importa este archivo.

import { TEST_SUPABASE_URL } from "./assistantRouteHarness";

const SUPABASE_HOST = new URL(TEST_SUPABASE_URL).host;

export type RestRow = Record<string, unknown>;

export type UniqueRule = { name: string; columns: string[]; where?: (row: RestRow) => boolean };

export type RestStubState = {
  user: { id: string; email: string } | null;
  tables: Record<string, RestRow[]>;
  uniques?: Record<string, UniqueRule[]>;
  defaults?: Record<string, () => RestRow>;
  missingTables?: string[];
  failTables?: Record<string, { status: number; code: string; message: string }>;
};

export type RestCall = { method: string; table: string | null; url: string };

export type RestStub = {
  calls: RestCall[];
  writes(table: string): number;
  reset(): void;
  restore(): void;
};

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const pgError = (status: number, code: string, message: string) => json({ code, details: null, hint: null, message }, status);

type Filter = { column: string; op: string; value: string };

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function parseFilters(params: URLSearchParams): Filter[] {
  const filters: Filter[] = [];
  for (const [column, raw] of params) {
    if (RESERVED.has(column)) continue;
    const dot = raw.indexOf(".");
    if (dot < 0) continue;
    filters.push({ column, op: raw.slice(0, dot), value: raw.slice(dot + 1) });
  }
  return filters;
}

function matches(row: RestRow, f: Filter): boolean {
  const v = row[f.column];
  const s = v === null || v === undefined ? null : String(v);
  switch (f.op) {
    case "eq":
      return s === f.value;
    case "neq":
      return s !== f.value;
    case "is":
      if (f.value === "null") return s === null;
      return s === f.value;
    case "in": {
      const list = f.value.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
      return s !== null && list.includes(s);
    }
    case "gte":
      return s !== null && s >= f.value;
    case "gt":
      return s !== null && s > f.value;
    case "lte":
      return s !== null && s <= f.value;
    case "lt":
      return s !== null && s < f.value;
    default:
      throw new Error(`filtro no simulado: ${f.op}`);
  }
}

function applyOrder(rows: RestRow[], order: string | null): RestRow[] {
  if (!order) return rows;
  const keys = order.split(",").map((part) => {
    const [column, dir] = part.split(".");
    return { column, desc: dir === "desc" };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = String(a[k.column] ?? "");
      const y = String(b[k.column] ?? "");
      if (x !== y) return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
    }
    return 0;
  });
}

let clock = Date.parse("2026-10-18T15:00:00Z");
export const nextTimestamp = () => new Date((clock += 1000)).toISOString();

export function installRestStub(
  state: RestStubState,
  external?: (req: Request, url: URL) => Promise<Response | null>,
): RestStub {
  const calls: RestCall[] = [];
  const original = globalThis.fetch;

  function conflict(table: string, candidate: RestRow, except?: RestRow): UniqueRule | null {
    const rows = state.tables[table] ?? [];
    for (const rule of state.uniques?.[table] ?? []) {
      if (rule.where && !rule.where(candidate)) continue;
      const clash = rows.some(
        (r) => r !== except && (!rule.where || rule.where(r)) && rule.columns.every((c) => String(r[c] ?? "") === String(candidate[c] ?? "")),
      );
      if (clash) return rule;
    }
    return null;
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const table =
      url.host === SUPABASE_HOST && url.pathname.startsWith("/rest/v1/") ? url.pathname.slice("/rest/v1/".length) : null;
    calls.push({ method: req.method, table, url: req.url });

    if (url.host !== SUPABASE_HOST) {
      const handled = external ? await external(req, url) : null;
      if (handled) return handled;
      throw new TypeError(`Red bloqueada en tests: ${req.method} ${url.host}${url.pathname}`);
    }

    if (url.pathname === "/auth/v1/user") {
      if (!state.user) return json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
      return json({ id: state.user.id, aud: "authenticated", role: "authenticated", email: state.user.email, app_metadata: {}, user_metadata: {} });
    }
    if (table === null) throw new TypeError(`Ruta de Supabase no simulada: ${url.pathname}`);
    if (state.missingTables?.includes(table)) {
      return pgError(404, "PGRST205", `Could not find the table 'public.${table}' in the schema cache`);
    }
    const failure = state.failTables?.[table];
    if (failure) return pgError(failure.status, failure.code, failure.message);

    const rows = (state.tables[table] ??= []);
    const filters = parseFilters(url.searchParams);
    const selected = () => rows.filter((r) => filters.every((f) => matches(r, f)));
    const wantsObject = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const respond = (out: RestRow[], status = 200) => {
      if (!wantsObject) return json(out, status);
      if (out.length === 1) return json(out[0], status);
      return pgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
    };

    if (req.method === "GET" || req.method === "HEAD") {
      let out = applyOrder(selected(), url.searchParams.get("order"));
      const limit = url.searchParams.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      return respond(out);
    }

    const body: unknown = req.method === "DELETE" ? null : await req.json().catch(() => null);

    if (req.method === "POST") {
      const items = (Array.isArray(body) ? body : [body]) as RestRow[];
      const upsert = (req.headers.get("prefer") ?? "").includes("resolution=merge-duplicates");
      const onConflict = (url.searchParams.get("on_conflict") ?? "").split(",").filter(Boolean);
      const written: RestRow[] = [];
      for (const item of items) {
        const candidate: RestRow = { ...(state.defaults?.[table]?.() ?? {}), ...item };
        if (upsert && onConflict.length) {
          const existing = rows.find((r) => onConflict.every((c) => String(r[c] ?? "") === String(candidate[c] ?? "")));
          if (existing) {
            Object.assign(existing, item);
            written.push(existing);
            continue;
          }
        }
        const clash = conflict(table, candidate);
        if (clash) return pgError(409, "23505", `duplicate key value violates unique constraint "${clash.name}"`);
        rows.push(candidate);
        written.push(candidate);
      }
      return respond(written, 201);
    }

    if (req.method === "PATCH") {
      const patch = (body ?? {}) as RestRow;
      const targets = selected();
      for (const r of targets) {
        const next = { ...r, ...patch };
        const clash = conflict(table, next, r);
        if (clash) return pgError(409, "23505", `duplicate key value violates unique constraint "${clash.name}"`);
      }
      for (const r of targets) Object.assign(r, patch);
      return respond(targets);
    }

    if (req.method === "DELETE") {
      const targets = selected();
      state.tables[table] = rows.filter((r) => !targets.includes(r));
      return respond(targets);
    }

    return pgError(405, "PGRST000", "método no simulado");
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
