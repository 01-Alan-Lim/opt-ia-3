// src/app/api/dev/index-demo-doc/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import { requireUser, getAuthErrorCode } from "@/lib/auth/supabase";
import { failResponse } from "@/lib/api/response";

// Guard: bloqueado en producción; en desarrollo exige docente autenticado.
// Evita escritura RAG anónima y gasto de embeddings sin control.
async function guardDev(req: Request): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === "production") {
    return failResponse(
      "FORBIDDEN_IN_PRODUCTION",
      "Endpoint no disponible en producción.",
      403
    );
  }
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return failResponse("FORBIDDEN", "Solo docentes.", 403);
    }
  } catch (err) {
    const code = getAuthErrorCode(err);
    if (code === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }
    if (code === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN", "Acceso restringido.", 403);
    }
    return failResponse("INTERNAL", "No se pudo validar la sesión.", 500);
  }
  return null;
}

// Texto demo SOLO de MyPEs y productividad
const DEMO_TEXT = `
OPT-IA es un agente de inteligencia artificial diseñado para apoyar a micro y pequeñas empresas (MyPEs) en la mejora de su productividad.
El sistema se conecta a diferentes fuentes de datos (formularios, reportes, documentos técnicos) y genera recomendaciones claras y accionables.

En el contexto de MyPEs comerciales o manufactureras, OPT-IA puede:
- Dar ideas de cómo organizar mejor el trabajo del equipo.
- Sugerir indicadores simples para medir productividad (por ejemplo: ventas por empleado, pedidos entregados a tiempo, tiempo de ciclo por pedido).
- Proponer acciones de mejora basadas en problemas frecuentes detectados en encuestas o formularios.
- Ayudar a priorizar tareas diarias y separar mejor el trabajo operativo del trabajo de mejora.

OPT-IA también puede apoyar en:
- Estandarizar procesos mediante listas de verificación sencillas.
- Explicar conceptos básicos de mejora continua de forma entendible para personas sin formación técnica.
- Generar resúmenes de información para que el dueño de la empresa tome decisiones más rápidas y con mayor claridad.
`;

function splitTextIntoChunks(text: string, maxLength = 500): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const p of paragraphs) {
    if ((current + " " + p).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? " " : "") + p;
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks;
}

export async function POST(req: Request) {
  const blocked = await guardDev(req);
  if (blocked) return blocked;

  try {
    // 1) Crear un documento de ejemplo
    const { data: docData, error: docError } = await supabase
      .from("documents")
      .insert({
        title: "Documento demo OPT-IA productividad en MyPEs",
        path: "demo/opt-ia-demo.txt",
        description:
          "Texto de ejemplo que describe el rol de OPT-IA en MyPEs y mejora de productividad.",
      })
      .select("id")
      .single();

    if (docError || !docData) {
      console.error("Error creando documento:", docError);
      return NextResponse.json(
        { error: "No se pudo crear el documento" },
        { status: 500 }
      );
    }

    const documentId = docData.id as string;

    // 2) Trocear el texto en chunks
    const chunks = splitTextIntoChunks(DEMO_TEXT, 500);

    // 3) Para cada chunk, generar embedding y guardar
    let index = 0;
    for (const chunk of chunks) {
      const embedding = await embedText(chunk); // number[]

      const { error: chunkError } = await supabase
        .from("document_chunks")
        .insert({
          document_id: documentId,
          chunk_index: index,
          content: chunk,
          embedding,
        });

      if (chunkError) {
        console.error("Error insertando chunk:", chunkError);
      }

      index++;
    }

    return NextResponse.json({
      ok: true,
      message: "Documento demo indexado correctamente",
      documentId,
      chunksCount: chunks.length,
    });
  } catch (err: unknown) {
    console.error("Error en index-demo-doc:", err);
    return NextResponse.json(
      { error: "Error al indexar documento demo" },
      { status: 500 }
    );
  }
}
