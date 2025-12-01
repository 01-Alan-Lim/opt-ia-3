// src/app/api/dev/index-pdf/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";

// Helper: cortar el texto en chunks (versión simple que ya funcionaba)
function splitTextIntoChunks(text: string, maxLength = 1000): string[] {
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

// POST /api/dev/index-pdf
// Body JSON:
// {
//   path: string,         // ruta en el bucket documents (ej. "mypes/GUIA_14.1_BALANCEO_DE_LINEA.pdf")
//   title: string,
//   description?: string,
//   text: string          // texto ya extraído del PDF (lo manda el cliente)
// }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const path: string | undefined = body.path;
    const title: string | undefined = body.title;
    const description: string | undefined = body.description;
    const text: string | undefined = body.text;

    if (!path || !title || !text) {
      return NextResponse.json(
        { error: "Faltan 'path', 'title' o 'text' en el cuerpo del request." },
        { status: 400 }
      );
    }

    console.log("📄 Indexando texto para PDF en storage:", path);

    // 1) Cortar el texto en chunks
    const chunks = splitTextIntoChunks(text, 1000);

    if (chunks.length === 0) {
      console.error("No se generaron chunks a partir del texto.");
      return NextResponse.json(
        { error: "No se generaron chunks a partir del texto." },
        { status: 400 }
      );
    }

    console.log("✂️  Chunks generados:", chunks.length);

    // 2) Crear registro en documents
    const { data: docData, error: docError } = await supabase
      .from("documents")
      .insert({
        title,
        path,
        description: description ?? null,
      })
      .select("id")
      .single();

    if (docError || !docData) {
      console.error("Error creando documento:", docError);
      return NextResponse.json(
        { error: "No se pudo crear el registro en documents." },
        { status: 500 }
      );
    }

    const documentId = docData.id as string;
    console.log("🆔 documentId:", documentId);

    // 3) Insertar chunks + embeddings
    let idx = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await embedText(chunk);

        const { error: chunkError } = await supabase
          .from("document_chunks")
          .insert({
            document_id: documentId,
            chunk_index: idx,
            content: chunk,
            embedding,
          });

        if (chunkError) {
          console.error(
            `Error insertando chunk ${idx} del documento ${documentId}:`,
            chunkError
          );
        } else {
          console.log(`✅ Chunk ${idx} insertado`);
        }
      } catch (err) {
        console.error(
          `Error generando embedding o insertando chunk ${idx}:`,
          err
        );
      }

      idx++;
    }

    return NextResponse.json({
      ok: true,
      message: "Texto indexado correctamente",
      documentId,
      chunksCount: chunks.length,
    });
  } catch (err) {
    console.error("Error en index-pdf:", err);
    return NextResponse.json(
      { error: "Error al indexar el texto del documento." },
      { status: 500 }
    );
  }
}
