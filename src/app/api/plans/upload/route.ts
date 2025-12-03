// src/app/api/plans/upload/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

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
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const userId = (formData.get("userId") as string | null) ?? "anon";

    if (!file) {
      return NextResponse.json(
        { error: "No se envió ningún archivo." },
        { status: 400 }
      );
    }

    // 1) Guardar archivo en Supabase Storage
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const fileNameStored = `${Date.now()}-${file.name}`;
    const storagePath = `plans/${userId}/${fileNameStored}`;


    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, buffer, {
        upsert: true,
        contentType: file.type || undefined,
      });

    if (uploadError) {
      console.error("Error subiendo archivo a Supabase:", uploadError);
      return NextResponse.json(
        { error: "No se pudo guardar el archivo en el servidor." },
        { status: 500 }
      );
    }

    // 2) Extraer texto según tipo de archivo
    let text = "";

    if (ext === "pdf") {
      text = await extractTextFromPdf(buffer);
    } else if (ext === "doc" || ext === "docx") {
      text = await extractTextFromDocx(arrayBuffer);
    } else {
      return NextResponse.json(
        { error: "Tipo de archivo no soportado. Usa PDF o Word." },
        { status: 400 }
      );
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json(
        {
          error:
            "No se pudo leer contenido suficiente del documento. Verifica que el archivo no esté vacío o escaneado como imagen.",
        },
        { status: 400 }
      );
    }

    // 3) Respuesta al frontend
    // 👇👇 CLAVE: el campo se llama EXACTAMENTE "text"
    return NextResponse.json({
      ok: true,
      text,                 // <- esto es lo que usará /api/plans/review
      fileName: file.name,  // nombre original
      storagePath,          // por si luego quieres guardarlo en otra tabla
    });
  } catch (err) {
    console.error("Error en /api/plans/upload:", err);
    return NextResponse.json(
      { error: "Error interno procesando el archivo de plan de mejora." },
      { status: 500 }
    );
  }
}
