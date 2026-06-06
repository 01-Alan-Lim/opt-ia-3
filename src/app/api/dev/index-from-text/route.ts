// src/app/api/dev/index-from-text/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { embedText } from "@/lib/embeddings";
import { requireUser, getAuthErrorCode } from "@/lib/auth/supabase";
import { failResponse } from "@/lib/api/response";
import DOMMatrix from "@thednp/dommatrix";
const globalForDomMatrix = globalThis as typeof globalThis & {
  DOMMatrix?: unknown;
};
globalForDomMatrix.DOMMatrix =
  globalForDomMatrix.DOMMatrix || (DOMMatrix as unknown);

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
  const blocked = await guardDev(req);
  if (blocked) return blocked;

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
