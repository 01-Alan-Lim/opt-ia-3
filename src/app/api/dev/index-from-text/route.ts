// src/app/api/dev/index-from-text/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import DOMMatrix from "@thednp/dommatrix";
;(globalThis as any).DOMMatrix =
  (globalThis as any).DOMMatrix || (DOMMatrix as any);

// Helper: partir texto en chunks
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

// POST /api/dev/index-from-text
// Body JSON:
// {
//   "path": "mypes/GUIA_14.1_BALANCEO_DE_LINEA.pdf",
//   "title": "Guía 14.1 Balanceo de línea",
//   "description": "Guía real...",
//   "text": "todo el texto plano del PDF"
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
        { error: "Faltan 'path', 'title' y/o 'text' en el cuerpo del request." },
        { status: 400 }
      );
    }

    if (!text.trim()) {
      return NextResponse.json(
        { error: "El texto está vacío." },
        { status: 400 }
      );
    }

    console.log("📄 Indexando TEXTO para PDF:", path);

    const chunks = splitTextIntoChunks(text, 1000);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "No se pudieron generar chunks a partir del texto." },
        { status: 400 }
      );
    }

    // 1) Crear documento en documents
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

    // 2) Embeddings + chunks
    let index = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await embedText(chunk);

        const { error: chunkError } = await supabase
          .from("document_chunks")
          .insert({
            document_id: documentId,
            chunk_index: index,
            content: chunk,
            embedding,
          });

        if (chunkError) {
          console.error(
            `Error insertando chunk ${index} del documento ${documentId}:`,
            chunkError
          );
        }
      } catch (err) {
        console.error(
          `Error generando embedding o insertando chunk ${index}:`,
          err
        );
      }

      index++;
    }

    return NextResponse.json({
      ok: true,
      message: "Texto indexado correctamente",
      documentId,
      chunksCount: chunks.length,
    });
  } catch (err) {
    console.error("Error en index-from-text:", err);
    return NextResponse.json(
      { error: "Error al indexar el texto." },
      { status: 500 }
    );
  }
}
