// src/app/api/method-experiences/route.ts
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireUser, getAuthErrorCode } from "@/lib/auth/supabase";
import { supabase } from "@/lib/supabaseClient";
import { ok, failResponse } from "@/lib/api/response";

// Solo columnas analíticas NO sensibles. Se EXCLUYEN identificadores de
// empresa/persona: nombre_o_razon_social_de_la_empresa, nombre/precio/materia
// prima del producto y las causas en texto libre (causa_principal_1/2/3).
const SAFE_COLUMNS = [
  "codigo_id_de_la_empresa",
  "rubro",
  "clasificacion_caeb",
  "tamano_empresa",
  "departamento",
  "municipio",
  "gestion",
  "tipo_de_plan",
  "materia",
  "area_de_intervencion",
  "otra_area_de_intervencion",
  "linea_de_produccion_servicio_priorizada",
  "matriz_foda_herramienta",
  "lluvia_de_ideas",
  "diagrama_de_ishikawa",
  "diagrama_de_pareto",
  "cursograma_sinoptico",
  "cursograma_analitico",
  "diagrama_de_recorrido",
  "mapeo_de_la_cadena_de_valor",
  "analisis_de_la_operacion",
  "tecnica_del_interrogatorio",
  "analisis_de_desperdicios",
  "muestreo_del_trabajo",
  "estudio_de_tiempos",
  "otra_herramienta_empleada",
  "enfoque_de_la_solucion",
  "otro_enfoque_de_la_solucion",
  "descripcion_mejora_planteada",
  "implementacion_de_la_mejora",
  "perspectivas_de_implementacion",
].join(",");

// Mapa fijo herramienta -> columnas (campos SI/NO). Solo nombres de columna
// internos; el usuario únicamente elige una clave validada por enum.
const TOOL_COLUMNS: Record<string, string[]> = {
  foda: ["matriz_foda_herramienta"],
  ishikawa: ["diagrama_de_ishikawa"],
  pareto: ["diagrama_de_pareto"],
  vsm: ["mapeo_de_la_cadena_de_valor"],
  tiempos: ["estudio_de_tiempos"],
  muestreo: ["muestreo_del_trabajo"],
  any: [
    "matriz_foda_herramienta",
    "lluvia_de_ideas",
    "diagrama_de_ishikawa",
    "diagrama_de_pareto",
    "cursograma_sinoptico",
    "cursograma_analitico",
    "diagrama_de_recorrido",
    "mapeo_de_la_cadena_de_valor",
    "analisis_de_la_operacion",
    "tecnica_del_interrogatorio",
    "analisis_de_desperdicios",
    "muestreo_del_trabajo",
    "estudio_de_tiempos",
    "otra_herramienta_empleada",
  ],
};

const QuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  rubro: z.string().trim().max(80).optional(),
  sector: z.string().trim().max(80).optional(),
  company_size: z.string().trim().max(80).optional(),
  department: z.string().trim().max(80).optional(),
  municipio: z.string().trim().max(80).optional(),
  company_code: z.string().trim().max(80).optional(),
  tool: z
    .enum(["foda", "ishikawa", "pareto", "vsm", "tiempos", "muestreo", "any"])
    .optional(),
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

  const {
    q,
    rubro,
    sector,
    company_size,
    department,
    municipio,
    company_code,
    tool,
    limit,
  } = parsed.data;

  let query = supabase
    .from("method_engineering_experiences")
    .select(SAFE_COLUMNS)
    .limit(limit);

  // ---- Filtros estructurados (ilike/eq parametrizados, valores como argumento) ----
  if (rubro) query = query.ilike("rubro", `%${escapeLike(rubro)}%`);
  if (sector) query = query.ilike("rubro", `%${escapeLike(sector)}%`);
  if (company_size) query = query.ilike("tamano_empresa", `%${escapeLike(company_size)}%`);
  if (department) query = query.ilike("departamento", `%${escapeLike(department)}%`);
  if (municipio) query = query.ilike("municipio", `%${escapeLike(municipio)}%`);
  if (company_code) query = query.eq("codigo_id_de_la_empresa", company_code);

  // Filtro por herramienta: solo columnas de un mapa fijo (sin valor del usuario
  // interpolado). `tool` ya viene validado por el enum de Zod.
  if (tool) {
    const cols = TOOL_COLUMNS[tool] ?? [];
    if (cols.length) {
      query = query.or(cols.map((c) => `${c}.eq.SI`).join(","));
    }
  }

  // Búsqueda libre `q`: ilike parametrizado sobre una sola columna NO sensible.
  // No se busca sobre el nombre/razón social y no se usa .or(...) interpolado.
  if (q) {
    query = query.ilike("descripcion_mejora_planteada", `%${escapeLike(q)}%`);
  }

  const { data, error } = await query;

  if (error) {
    // No exponemos el detalle interno de Supabase al cliente.
    console.error("Error consultando method_engineering_experiences:", error);
    return failResponse("INTERNAL", "Error al consultar experiencias.", 500);
  }

  // Etiqueta anónima por fila; nunca se devuelve el nombre real de la empresa.
  const experiences = (data ?? []).map((row, i) => ({
    alias: `Empresa E-${String(i + 1).padStart(2, "0")}`,
    ...(row as unknown as Record<string, unknown>),
  }));

  return ok({ experiences });
}
