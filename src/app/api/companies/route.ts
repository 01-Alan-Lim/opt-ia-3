// src/app/api/companies/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q"); // búsqueda por nombre/código (opcional)
    const limitParam = searchParams.get("limit");

    const limit = limitParam ? Number(limitParam) : 100;

    let query = supabase.from("companies").select("*").limit(limit);

    // Si envías ?q=alimentos, filtra por nombre o código que contenga eso
    if (q) {
      query = query.or(
        `id_empresa.ilike.%${q}%,nombre_de_la_empresa.ilike.%${q}%`
      );
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error consultando companies:", error);
      return NextResponse.json(
        { error: "Error al consultar companies" },
        { status: 500 }
      );
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("Error en /api/companies:", err);
    return NextResponse.json(
      { error: "Error interno en /api/companies" },
      { status: 500 }
    );
  }
}
