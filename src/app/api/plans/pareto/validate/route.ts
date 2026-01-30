// src/app/api/plans/pareto/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const STAGE = 5;
const DraftType = "pareto_wizard_state";
const FinalType = "pareto_final";
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // "YYYY-MM"

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function ceil20Percent(n: number) {
  return Math.max(1, Math.ceil(n * 0.2));
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido.");
    }

    const { chatId } = parsed.data;

    // 1) leer draft de Etapa 5
    const { data: draft, error: draftErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id, payload, chat_id, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", DraftType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (draftErr) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto.", draftErr);
    if (!draft?.payload) return fail(400, "BAD_REQUEST", "No hay estado de Etapa 5 (Pareto).");

    const s: any = draft.payload;

    // 2) leer Ishikawa final (Etapa 4) para obtener roots oficiales
    const { data: ishFinal, error: ishErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("stage", 4)
      .eq("artifact_type", "ishikawa_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ishErr) return fail(500, "DB_ERROR", "No se pudo leer Ishikawa final (Etapa 4).", ishErr);

    const rootsOfficial: string[] = Array.isArray(ishFinal?.payload?.roots) ? ishFinal.payload.roots : [];
    if (rootsOfficial.length < 10) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Etapa 4 aún no tiene causas raíz suficientes (mínimo 10) para iniciar Pareto.",
      });
    }

    // 3) Validaciones Pareto (MVP)
    const selectedRoots: string[] = Array.isArray(s?.selectedRoots) ? s.selectedRoots.map((x: any) => String(x).trim()).filter(Boolean) : [];
    const minSelected = typeof s?.minSelected === "number" ? s.minSelected : 10;
    const maxSelected = typeof s?.maxSelected === "number" ? s.maxSelected : 15;

    if (selectedRoots.length < minSelected || selectedRoots.length > maxSelected) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: `Selecciona entre ${minSelected} y ${maxSelected} causas raíz para el Pareto. Actualmente: ${selectedRoots.length}.`,
      });
    }

    // asegurar que selectedRoots exista dentro de rootsOfficial
    const rootsSet = new Set(rootsOfficial);
    const invalidSelected = selectedRoots.filter((r) => !rootsSet.has(r));
    if (invalidSelected.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas seleccionadas no coinciden con las raíces oficiales del Ishikawa. Revisa la lista.",
        detail: { invalidSelected },
      });
    }

    // criterios (3) con peso 1-10
    const criteria = Array.isArray(s?.criteria) ? s.criteria : [];
    if (criteria.length !== 3) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Debes definir exactamente 3 criterios para el Pareto (con peso 1 a 10).",
      });
    }

    for (const c of criteria) {
      const name = String(c?.name ?? "").trim();
      const w = Number(c?.weight);
      if (!name) {
        return NextResponse.json({ ok: true, valid: false, message: "Hay un criterio sin nombre. Corrígelo." });
      }
      if (!Number.isFinite(w) || w < 1 || w > 10) {
        return NextResponse.json({
          ok: true,
          valid: false,
          message: `El peso del criterio "${name}" debe estar entre 1 y 10.`,
        });
      }
    }

    // criticalRoots (top 20% devuelto por el estudiante tras Excel)
    const criticalRoots: string[] = Array.isArray(s?.criticalRoots)
      ? s.criticalRoots.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    const minCritical = ceil20Percent(selectedRoots.length);
    if (criticalRoots.length < minCritical) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: `Aún falta la lista final de causas críticas (top 20%). Para ${selectedRoots.length} causas, envía al menos ${minCritical} causas críticas (según tu Excel).`,
      });
    }

    const selectedSet = new Set(selectedRoots);
    const invalidCritical = criticalRoots.filter((r) => !selectedSet.has(r));
    if (invalidCritical.length > 0) {
      return NextResponse.json({
        ok: true,
        valid: false,
        message: "Algunas causas críticas no están dentro de tu lista seleccionada de causas raíz.",
        detail: { invalidCritical },
      });
    }

    // 4) Guardar final artifact (Etapa 5)
    const finalPayload = {
      selectedRoots,
      criteria: criteria.map((c: any) => ({
        id: String(c?.id ?? "").trim() || crypto.randomUUID(),
        name: String(c?.name ?? "").trim(),
        weight: Number(c?.weight),
      })),
      criticalRoots,
      note: "El cálculo 80/20 se realizó en Excel (herramienta de la materia).",
      validatedAt: new Date().toISOString(),
      fromStage4: { rootsCount: rootsOfficial.length, ishikawaUpdatedAt: ishFinal?.updated_at ?? null },
    };

    // Rúbrica simple Pareto (MVP): 40% criterios+pesos, 60% priorización final.
    // Como este endpoint solo llega aquí si todo está OK, el score queda en 100.
    const score = 100;

    // upsert final
    const { data: existingFinal, error: exErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", FinalType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (exErr) return fail(500, "DB_ERROR", "No se pudo verificar Pareto final.", exErr);

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
      if (insErr) return fail(500, "DB_ERROR", "No se pudo guardar Pareto final.", insErr);
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
      if (updErr) return fail(500, "DB_ERROR", "No se pudo actualizar Pareto final.", updErr);
    }

    return NextResponse.json(
      {
        ok: true,
        valid: true,
        message: "Etapa 5 (Pareto) finalizada. Ya puedes continuar al Avance 2.",
        final: finalPayload,
        score,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
