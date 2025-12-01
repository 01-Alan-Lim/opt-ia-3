// src/app/api/method-experiences/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // Filtros que vas a usar desde el front
    const rubro = searchParams.get("rubro");            // ej: textil
    const size = searchParams.get("company_size");      // ej: pequeña
    const sector = searchParams.get("sector");          // ej: alimentos
    const department = searchParams.get("department");  // ej: La Paz
    const city = searchParams.get("municipio");         // ej: El Alto
    const tool = searchParams.get("tool");              // ej: foda, ishikawa, pareto
    const companyCode = searchParams.get("company_code");// ej: 202056911
    const q = searchParams.get("q");                    // búsqueda libre
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : 100;

    let query = supabase
      .from("method_engineering_experiences")
      .select("*")
      .limit(limit);

    // ---- Filtros estructurados ----

    if (rubro) {
      query = query.ilike("rubro", `%${rubro}%`);
    }

    if (sector) {
      query = query.ilike("rubro", `%${sector}%`);
    }

    if (size) {
      query = query.ilike("tamano_empresa", `%${size}%`);
    }

    if (department) {
      query = query.ilike("departamento", `%${department}%`);
    }

    if (city) {
      query = query.ilike("municipio", `%${city}%`);
    }

    if (companyCode) {
      query = query.eq("codigo_id_de_la_empresa", companyCode);
    }

    // Filtrar por herramienta usada (los campos son SI/NO)
    if (tool) {
      const toolMap: Record<string, string[]> = {
        foda: ["matriz_foda_herramienta"],
        ishikawa: ["diagrama_de_ishikawa"],
        pareto: ["diagrama_de_pareto"],
        vsm: ["mapeo_de_la_cadena_de_valor"],
        tiempos: ["estudio_de_tiempos"],
        muestreo: ["muestreo_del_trabajo"],
        // cualquier herramienta -> al menos una en SI
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

      const cols = toolMap[tool] ?? [];
      if (cols.length) {
        const orParts = cols.map((c) => `${c}.eq.SI`);
        query = query.or(orParts.join(","));
      }
    }

    // ---- Búsqueda libre en columnas "importantes" ----
    if (q) {
      query = query.or(
        [
          `nombre_o_razon_social_de_la_empresa.ilike.%${q}%`,
          `rubro.ilike.%${q}%`,
          `actividad_economica.ilike.%${q}%`,
          `area_de_intervencion.ilike.%${q}%`,
          `descripcion_mejora_planteada.ilike.%${q}%`,
          `enfoque_de_la_solucion.ilike.%${q}%`,
          `otra_herramienta_empleada.ilike.%${q}%`,
        ].join(",")
      );
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error consultando method_engineering_experiences:", error);
      return NextResponse.json(
        { error: "Error al consultar method_engineering_experiences" },
        { status: 500 }
      );
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("Error en /api/method-experiences:", err);
    return NextResponse.json(
      { error: "Error interno en /api/method-experiences" },
      { status: 500 }
    );
  }
}
