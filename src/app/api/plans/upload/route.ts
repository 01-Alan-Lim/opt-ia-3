// src/app/api/plans/upload/route.ts
// Upload de archivo (PDF/DOCX) + extracción de texto.
// - Auth server-side: requireUser(req)
// - Storage server-only: supabaseServer (service role)
// - NO confiar en userId desde FormData
// - Respuestas consistentes: ok()/fail()

import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabaseServer";
import { requireUser } from "@/lib/auth/supabase";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";

export const runtime = "nodejs";

// ---- Helpers para extraer texto ----
async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const pdfParseModule: any = await import("pdf-parse");
    const pdfParse = pdfParseModule.default ?? pdfParseModule;

    if (typeof pdfParse !== "function") {
      console.error("pdf-parse no es una función:", pdfParse);
      throw new Error("No se pudo cargar correctamente pdf-parse.");
    }

    const data = await pdfParse(buffer);
    const text = (data.text ?? "").trim();
    return text;
  } catch (err) {
    console.error("❌ No se pudo cargar pdf-parse:", err);
    throw new Error("No se pudo extraer texto del PDF.");
  }
}

async function extractTextFromDocx(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const mammothModule: any = await import("mammoth");
    const { value } = await mammothModule.extractRawText({
      buffer: Buffer.from(arrayBuffer),
    });
    return (value ?? "").trim();
  } catch (err) {
    console.error("❌ Error usando mammoth:", err);
    throw new Error("No se pudo extraer texto del archivo Word.");
  }
}

// ---- Handler principal ----
export async function POST(req: Request) {
  try {
    // ✅ Auth server-side (no confiar en userId del cliente)
    const authed = await requireUser(req);

    // ✅ Gate server-side: si no puede chatear, tampoco puede subir/revisar plan
    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      const code =
        gate.reason === "NEEDS_ONBOARDING"
          ? "NEEDS_ONBOARDING"
          : gate.reason === "PENDING_APPROVAL"
            ? "PENDING_APPROVAL"
            : gate.reason === "COHORT_INACTIVE"
              ? "COHORT_INACTIVE"
              : gate.reason === "ACCESS_NOT_STARTED"
                ? "ACCESS_NOT_STARTED"
                : gate.reason === "ACCESS_EXPIRED"
                  ? "ACCESS_EXPIRED"
                  : "FORBIDDEN";

      return NextResponse.json(fail(code, gate.message), { status: 403 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(fail("BAD_REQUEST", "No se envió ningún archivo."), { status: 400 });
    }

    const originalName = file.name || "documento";
    const ext = originalName.split(".").pop()?.toLowerCase() ?? "";

    if (!["pdf", "doc", "docx"].includes(ext)) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Tipo de archivo no soportado. Usa PDF o Word."),
        { status: 400 }
      );
    }

    // 1) Guardar archivo en Supabase Storage
    const fileNameStored = `${Date.now()}-${originalName}`;
    const storagePath = `plans/${authed.userId}/${fileNameStored}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabaseServer.storage
      .from("documents")
      .upload(storagePath, buffer, {
        upsert: true,
        contentType: file.type || undefined,
      });

    if (uploadError) {
      console.error("Error subiendo archivo a Supabase:", uploadError);
      return NextResponse.json(
        fail("INTERNAL", "No se pudo guardar el archivo en el servidor."),
        { status: 500 }
      );
    }

    // 2) Extraer texto según tipo de archivo
    let text = "";

    if (ext === "pdf") {
      text = await extractTextFromPdf(buffer);
    } else {
      // doc o docx
      text = await extractTextFromDocx(arrayBuffer);
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json(
        fail(
          "BAD_REQUEST",
          "No se pudo leer contenido suficiente del documento. Verifica que el archivo no esté vacío o escaneado como imagen."
        ),
        { status: 400 }
      );
    }

    // 3) Respuesta al frontend (manteniendo campos clave)
    return NextResponse.json(
      ok({
        text, // <- lo usará /api/plans/review
        fileName: originalName,
        storagePath,
      }),
      { status: 200 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        fail("FORBIDDEN", "Acceso restringido a correos autorizados."),
        { status: 403 }
      );
    }

    console.error("Error en /api/plans/upload:", err);
    return NextResponse.json(
      fail("INTERNAL", "Error interno procesando el archivo de plan de mejora."),
      { status: 500 }
    );
  }
}
