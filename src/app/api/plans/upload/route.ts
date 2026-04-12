// src/app/api/plans/upload/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { supabaseServer } from "@/lib/supabaseServer";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { ok, fail, failResponse, type ApiErrorCode } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { extractTextFromPDF } from "@/lib/pdfText";

export const runtime = "nodejs";

const UploadFormSchema = z.object({
  chatId: z.string().uuid(),
  versionNumber: z.coerce.number().int().min(1).max(2),
});

function sanitizeFileName(fileName: string): string {
  return fileName
    .normalize("NFKD")
    .replace(/[^\w.\-() ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

type ChatOwnershipOk = {
  ok: true;
};

type ChatOwnershipFail = {
  ok: false;
  status: 404 | 403;
  code: ApiErrorCode;
  message: string;
};

type ChatOwnershipResult = ChatOwnershipOk | ChatOwnershipFail;

async function assertChatOwnership(
  userId: string,
  chatId: string
): Promise<ChatOwnershipResult> {
  const { data: chatRow, error } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (error || !chatRow) {
    return {
      ok: false as const,
      status: 404,
      code: "NOT_FOUND",
      message: "Chat no encontrado.",
    };
  }

  if (chatRow.client_id !== userId) {
    return {
      ok: false as const,
      status: 403,
      code: "FORBIDDEN",
      message: "No tienes acceso a este chat.",
    };
  }

  return { ok: true as const };
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const text = await extractTextFromPDF(buffer);
    return text.trim();
  } catch (err) {
    console.error("❌ Error extrayendo texto del PDF:", err);
    throw new Error("No se pudo extraer texto del PDF.");
  }
}

async function extractTextFromDocx(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const mammothModule = await import("mammoth");
    const { extractRawText } = mammothModule;

    const { value } = await extractRawText({
      buffer: Buffer.from(arrayBuffer),
    });

    return (value ?? "").trim();
  } catch (err) {
    console.error("❌ Error extrayendo texto del DOCX:", err);
    throw new Error("No se pudo extraer texto del archivo Word (.docx).");
  }
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
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
    const rawChatId = formData.get("chatId");
    const rawVersionNumber = formData.get("versionNumber");
    const file = formData.get("file");

    const parsed = UploadFormSchema.safeParse({
      chatId: typeof rawChatId === "string" ? rawChatId : "",
      versionNumber: typeof rawVersionNumber === "string" ? rawVersionNumber : "",
    });

    if (!parsed.success) {
      return NextResponse.json(
        fail(
          "BAD_REQUEST",
          parsed.error.issues[0]?.message ?? "Datos de subida inválidos."
        ),
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        fail("BAD_REQUEST", "No se envió ningún archivo."),
        { status: 400 }
      );
    }

    const ownership = await assertChatOwnership(authed.userId, parsed.data.chatId);
    if (!ownership.ok) {
      return NextResponse.json(fail(ownership.code, ownership.message), {
        status: ownership.status,
      });
    }

    const originalName = file.name || "documento";
    const safeOriginalName = sanitizeFileName(originalName) || "documento";
    const ext = safeOriginalName.split(".").pop()?.toLowerCase() ?? "";

    if (!["pdf", "docx"].includes(ext)) {
      return NextResponse.json(
        fail(
          "BAD_REQUEST",
          "Tipo de archivo no soportado. Usa únicamente PDF o Word (.docx)."
        ),
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let text = "";

    if (ext === "pdf") {
      text = await extractTextFromPdf(buffer);
    } else {
      text = await extractTextFromDocx(arrayBuffer);
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json(
        fail(
          "BAD_REQUEST",
          "No se pudo leer contenido suficiente del documento. Verifica que no esté vacío o que el PDF no sea solo una imagen escaneada."
        ),
        { status: 400 }
      );
    }

    const timestamp = Date.now();
    const storagePath = [
      "plans",
      authed.userId,
      "stage-10",
      parsed.data.chatId,
      `v${parsed.data.versionNumber}`,
      `${timestamp}-${safeOriginalName}`,
    ].join("/");

    const { error: uploadError } = await supabaseServer.storage
      .from("documents")
      .upload(storagePath, buffer, {
        upsert: true,
        contentType: file.type || undefined,
      });

    if (uploadError) {
      console.error("❌ Error subiendo archivo a Supabase Storage:", uploadError);
      return NextResponse.json(
        fail("INTERNAL", "No se pudo guardar el archivo en el servidor."),
        { status: 500 }
      );
    }

    return ok({
      text,
      fileName: originalName,
      storagePath,
      versionNumber: parsed.data.versionNumber,
    });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    console.error("❌ Error en /api/plans/upload:", err);
    return failResponse(
      "INTERNAL",
      err instanceof Error
        ? err.message
        : "Error interno procesando el archivo del plan de mejora.",
      500
    );
  }
}