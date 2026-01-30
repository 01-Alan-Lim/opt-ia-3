// src/app/api/plans/objectives/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const STAGE = 6;
const FinalType = "objectives_final";
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // "YYYY-MM"

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function nonEmptyTrimmed(s: unknown): string {
  return String(s ?? "").trim();
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

    // 1) Leer Pareto final validado (Etapa 5) y obtener criticalRoots oficiales
    const { data: paretoFinal, error: paretoErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", 5)
      .eq("artifact_type", "pareto_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (paretoErr) return fail(500, "DB_ERROR", "No se pudo leer Pareto final (Etapa 5).", paretoErr);

    const criticalRootsOfficial: string[] = Array.isArray(paretoFinal?.payload?.criticalRoots)
      ? paretoFinal!.payload.criticalRoots.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    if (criticalRootsOfficial.length === 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Para validar Objetivos (Etapa 6) primero debes tener Pareto final validado con causas críticas (top 20%).",
      });
    }

    // 2) Leer estado actual de la Etapa 6 desde plan_stage_states
    const { data: stRow, error: stErr } = await supabaseServer
      .from("plan_stage_states")
      .select("state_json, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (stErr) return fail(500, "DB_ERROR", "No se pudo leer el estado de la Etapa 6.", stErr);
    if (!stRow?.state_json) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "No hay estado guardado de la Etapa 6 (Objetivos).",
      });
    }

    const s: any = stRow.state_json;

    // 3) Validaciones MVP
    const generalObjective = nonEmptyTrimmed(s?.generalObjective);
    if (generalObjective.length < 15) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "El Objetivo General es muy corto. Redáctalo con mayor claridad (mínimo ~15 caracteres).",
      });
    }

    const specificObjectives: string[] = Array.isArray(s?.specificObjectives)
      ? s.specificObjectives.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    if (specificObjectives.length < 3) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes formular al menos 3 Objetivos Específicos.",
      });
    }

    const linkedCriticalRoots: string[] = Array.isArray(s?.linkedCriticalRoots)
      ? s.linkedCriticalRoots.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    if (linkedCriticalRoots.length < 1) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes vincular al menos 1 causa crítica (top 20%) del Pareto a tus objetivos.",
      });
    }

    const officialSet = new Set(criticalRootsOfficial);
    const invalidLinked = linkedCriticalRoots.filter((r) => !officialSet.has(r));
    if (invalidLinked.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas vinculadas no coinciden con las causas críticas oficiales del Pareto (top 20%).",
        detail: { invalidLinked },
      });
    }

    // 4) Guardar objectives_final (Etapa 6)
    const finalPayload = {
      generalObjective,
      specificObjectives,
      linkedCriticalRoots,
      validatedAt: new Date().toISOString(),
      fromPareto: {
        criticalRootsCount: criticalRootsOfficial.length,
        paretoUpdatedAt: paretoFinal?.updated_at ?? null,
      },
    };

    // MVP: si pasa el gate, score = 100
    const score = 100;

    const { data: existingFinal, error: exErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", FinalType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (exErr) return fail(500, "DB_ERROR", "No se pudo verificar Objectives final.", exErr);

    if (!existingFinal) {
      const { error: insErr } = await supabaseServer.from("plan_stage_artifacts").insert({
        user_id: user.userId,
        chat_id: chatId,
        stage: STAGE,
        artifact_type: FinalType,
        period_key: PERIOD_KEY,
        status: "validated",
        payload: finalPayload,
        score,
      });
      if (insErr) return fail(500, "DB_ERROR", "No se pudo guardar Objectives final.", insErr);
    } else {
      const { error: updErr } = await supabaseServer
        .from("plan_stage_artifacts")
        .update({
          status: "validated",
          payload: finalPayload,
          score,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingFinal.id);
      if (updErr) return fail(500, "DB_ERROR", "No se pudo actualizar Objectives final.", updErr);
    }

    return NextResponse.json(
      {
        ok: true,
        valid: true,
        message: "Etapa 6 (Objetivos) finalizada. Puedes continuar con la Etapa 7 (Plan de Mejora).",
        final: finalPayload,
        score,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    if (msg === "FORBIDDEN_DOMAIN") return fail(403, "FORBIDDEN_DOMAIN", "Dominio no permitido.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
