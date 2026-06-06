// src/app/api/companies/route.ts
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser, getAuthErrorCode } from "@/lib/auth/supabase";
import { supabase } from "@/lib/supabaseClient";
import { ok, failResponse } from "@/lib/api/response";

// Solo columnas NO sensibles. Se EXCLUYE deliberadamente `nombre_de_la_empresa`
// (razón social real) para no revelar la identidad de las empresas.
const SAFE_COLUMNS = "id_empresa";

const QuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Escapa comodines LIKE para evitar abuso del patrón ilike.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function GET(req: NextRequest) {
  // Auth server-side: nunca confiamos en userId enviado por el cliente.
  try {
    await requireUser(req);
  } catch (err) {
    const code = getAuthErrorCode(err);
    if (code === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }
    if (code === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN", "Acceso restringido.", 403);
    }
    if (code === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal.",
        503
      );
    }
    return failResponse("INTERNAL", "No se pudo validar la sesión.", 500);
  }

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams)
  );
  if (!parsed.success) {
    return failResponse("BAD_REQUEST", "Parámetros inválidos.", 400);
  }

  const { q, limit } = parsed.data;

  let query = supabase.from("companies").select(SAFE_COLUMNS).limit(limit);

  // Filtro seguro: ilike parametrizado sobre una sola columna.
  // No se usa .or(...) con interpolación de strings del usuario.
  if (q) {
    query = query.ilike("id_empresa", `%${escapeLike(q)}%`);
  }

  const { data, error } = await query;

  if (error) {
    // No exponemos el detalle interno de Supabase al cliente.
    console.error("Error consultando companies:", error);
    return failResponse("INTERNAL", "Error al consultar empresas.", 500);
  }

  // Etiqueta anónima; nunca se devuelve el nombre real de la empresa.
  const companies = (data ?? []).map((row, i) => ({
    alias: `Empresa C-${String(i + 1).padStart(2, "0")}`,
    id_empresa: (row as { id_empresa: string | null }).id_empresa ?? null,
  }));

  return ok({ companies });
}
