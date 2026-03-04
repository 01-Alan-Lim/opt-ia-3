// src/app/api/plans/final_doc/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const STAGE = 10;
const PERIOD_KEY = getPeriodKeyLaPaz();

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function safeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, gate.reason, gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId } = parsed.data;

    // Si ya hay final oficial, no reabrimos
    const { data: alreadyFinal } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id, payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", "final_doc_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (alreadyFinal?.id) {
      return NextResponse.json({
        ok: true,
        valid: true,
        message: "Etapa 10 ya fue cerrada con una versión final.",
        finalArtifactId: alreadyFinal.id,
      });
    }

    // 1) Leer state Etapa 10
    const { data: stRow, error: stErr } = await supabaseServer
      .from("plan_stage_states")
      .select("state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (stErr) return fail(500, "DB_ERROR", "No se pudo leer el estado de la Etapa 10.", stErr);
    if (!stRow?.state_json) {
      return NextResponse.json({ ok: true, valid: false, message: "No hay estado guardado de la Etapa 10." });
    }

    const s: any = stRow.state_json;

    const versionNumber = safeNumber(s?.versionNumber);
    if (versionNumber !== 1 && versionNumber !== 2) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Falta versionNumber (1 o 2) en el estado de Etapa 10.",
      });
    }

    const upload = s?.upload ?? null;
    const fileName = String(upload?.fileName ?? "").trim();
    const storagePath = String(upload?.storagePath ?? "").trim();
    const extractedText = String(upload?.extractedText ?? "").trim();

    if (!fileName || !storagePath || extractedText.length < 50) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Falta el documento subido (fileName/storagePath/extractedText) para cerrar Etapa 10.",
      });
    }

    const evaluation = s?.evaluation ?? null;
    const totalScore = safeNumber(evaluation?.total_score);
    const totalLabel = String(evaluation?.total_label ?? "").trim();
    const needsResubmission = Boolean(evaluation?.needs_resubmission);

    // 2) Guardar artifact de versión (v1 o v2) como “submitted”
    const versionType = versionNumber === 1 ? "final_doc_v1" : "final_doc_v2";

    const versionPayload = {
      versionNumber,
      file: { fileName, storagePath },
      extractedSections: s?.extractedSections ?? null,
      evaluation: evaluation ?? null,
      uploadedAt: upload?.uploadedAt ?? null,
      savedAt: new Date().toISOString(),
    };

    const scoreToSave = totalScore ?? 70;

    const { data: verRow, error: verErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: versionType,
          period_key: PERIOD_KEY,
          status: "submitted",
          payload: versionPayload,
          score: scoreToSave,
          updated_at: new Date().toISOString(),
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      )
      .select("id")
      .single();

    if (verErr || !verRow) return fail(500, "DB_ERROR", "No se pudo guardar la versión del documento.", verErr);

    const versionArtifactId = verRow.id as string;

    // 3) Decidir cierre:
    // - Si es v2 => SIEMPRE cierra (definitiva aunque esté mal)
    // - Si es v1 => cierra solo si NO requiere resubmission y score/label son razonables
    const isV2 = versionNumber === 2;
    const v1CanClose =
      versionNumber === 1 &&
      !needsResubmission &&
      (totalLabel === "Adecuado" || totalLabel === "Bien" || (typeof totalScore === "number" && totalScore >= 80));

    const shouldClose = isV2 || v1CanClose;

    // 4) Si cierra, guardamos final oficial (validated)
    if (shouldClose) {
      const finalPayload = {
        officialVersion: versionNumber,
        officialArtifactType: versionType,
        officialArtifactId: versionArtifactId,
        file: { fileName, storagePath },
        extractedSections: s?.extractedSections ?? null,
        evaluation: evaluation ?? null,
        closedAt: new Date().toISOString(),
        rule: isV2 ? "v2_is_final" : "v1_good_enough",
      };

      const { data: finalRow, error: upErr } = await supabaseServer
        .from("plan_stage_artifacts")
        .upsert(
          {
            user_id: user.userId,
            chat_id: chatId,
            stage: STAGE,
            artifact_type: "final_doc_final",
            period_key: PERIOD_KEY,
            status: "validated",
            payload: finalPayload,
            score: scoreToSave,
            updated_at: new Date().toISOString(),
          },
          { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
        )
        .select("id")
        .single();

      if (upErr || !finalRow) return fail(500, "DB_ERROR", "No se pudo cerrar la Etapa 10.", upErr);

      // plan_stage_evaluations (una por final)
      // Insertar solo si no existe
      const { data: existingEval } = await supabaseServer
        .from("plan_stage_evaluations")
        .select("id")
        .eq("user_id", user.userId)
        .eq("chat_id", chatId)
        .eq("stage", STAGE)
        .eq("artifact_type", "final_doc_final")
        .eq("period_key", PERIOD_KEY)
        .eq("artifact_id", finalRow.id)
        .maybeSingle();

      if (!existingEval && evaluation && typeof totalScore === "number") {
        await supabaseServer.from("plan_stage_evaluations").insert({
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: "final_doc_final",
          artifact_id: finalRow.id,
          period_key: PERIOD_KEY,
          rubric_json: {
            coherencia_metodologica: 30,
            consistencia_asesor: 25,
            proceso_continuidad: 30,
            calidad_redaccion: 15,
          },
          result_json: evaluation,
          total_score: totalScore,
          total_label: totalLabel,
        });
      }

      return NextResponse.json({
        ok: true,
        valid: true,
        message:
          "✅ Ya se recepcionó tu versión final del Plan de Mejora. Gracias por el trabajo del semestre. Te irá muy bien en lo que sigue.",
        final: { officialVersion: versionNumber, artifactId: finalRow.id, score: scoreToSave },
        next: { stage: null },
      });
    }

    // 5) Si NO cierra (v1 con problemas), pedir v2
    return NextResponse.json({
      ok: true,
      valid: false,
      message:
        "📩 Documento recibido (versión 1). Hay observaciones importantes. Corrige y sube una **versión 2**: esa será la definitiva, aunque queden detalles.",
      versionSaved: { artifactId: versionArtifactId, versionNumber },
      hint: "Sube la versión 2 cuando ajustes las observaciones.",
    });
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    if (msg === "FORBIDDEN_DOMAIN") return fail(403, "FORBIDDEN_DOMAIN", "Dominio no permitido.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
