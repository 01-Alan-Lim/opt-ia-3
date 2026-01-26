// src/app/api/plans/foda/validate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const STAGE = 2;
const STATE_ARTIFACT = "foda_wizard_state";
const FINAL_ARTIFACT = "foda_analysis";
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // "YYYY-MM"

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

function extractJsonSafe(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const userId = authed.userId;

    // 1) Leer estado actual
    const { data: stateRow, error: stateErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, chat_id")
      .eq("user_id", userId)
      .eq("stage", STAGE)
      .eq("artifact_type", STATE_ARTIFACT)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (stateErr) return fail(500, "DB_ERROR", "No se pudo leer el estado FODA.", stateErr);
    if (!stateRow?.payload) return fail(400, "BAD_REQUEST", "FODA no iniciado.");

    const st = stateRow.payload as any;
    const items = st?.items ?? null;

    const count = (q: "F" | "D" | "O" | "A") => (Array.isArray(items?.[q]) ? items[q].length : 0);

    // 2) Validación mínima: 3 por cuadrante + sin evidencia pendiente
    if (st?.pendingEvidence) {
      return fail(400, "BAD_REQUEST", "Falta completar evidencia pendiente antes de validar.", st.pendingEvidence);
    }
    const cF = count("F");
    const cD = count("D");
    const cO = count("O");
    const cA = count("A");

    if (cF < 3 || cD < 3 || cO < 3 || cA < 3) {
      return fail(400, "BAD_REQUEST", "Faltan ítems para completar el FODA (mínimo 3 por cuadrante).", {
        F: cF,
        D: cD,
        O: cO,
        A: cA,
      });
    }

    // 3) Guardar artefacto final validated
    const finalPayload = {
      items: items,
      counts: { F: cF, D: cD, O: cO, A: cA },
    };

    const { data: finalRow, error: finalErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: userId,
          chat_id: stateRow.chat_id ?? null,
          stage: STAGE,
          artifact_type: FINAL_ARTIFACT,
          period_key: PERIOD_KEY,
          status: "validated",
          payload: finalPayload,
        },
        { onConflict: "user_id,stage,artifact_type,period_key" }
      )
      .select("id")
      .single();

    if (finalErr || !finalRow?.id) {
      return fail(500, "DB_ERROR", "No se pudo guardar el análisis FODA.", finalErr);
    }

    // 4) Evaluación IA (rúbrica estándar que definiste)
    const model = getGeminiModel();
    const prompt = `
Evalúa académicamente la Etapa 2 (Análisis FODA) con la siguiente rúbrica:

- Completitud (30%): mínimo 3 ítems por cuadrante
- Pertinencia al contexto (40%): relacionado con sector/producto/área
- Calidad (30%): clasificación correcta + profundidad + sustento (especialmente O/A)

Escala fija: Deficiente / Regular / Adecuado / Bien

Devuelve SOLO JSON:
{
  "total_score": number (0-100),
  "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
  "detail": {
    "completitud": number,
    "pertinencia": number,
    "calidad": number
  },
  "feedback": "string"
}

ANÁLISIS:
${JSON.stringify(finalPayload, null, 2)}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const evaluation = extractJsonSafe(text);

    if (!evaluation || typeof evaluation.total_score !== "number") {
      return fail(500, "LLM_ERROR", "La IA no devolvió un JSON válido para la evaluación FODA.", { raw: text });
    }

    const insertEval = await supabaseServer.from("plan_stage_evaluations").insert({
      user_id: userId,
      chat_id: stateRow.chat_id ?? null,
      stage: STAGE,
      artifact_type: FINAL_ARTIFACT,
      artifact_id: finalRow.id,
      period_key: PERIOD_KEY,
      rubric_json: {
        completitud: 30,
        pertinencia: 40,
        calidad: 30,
      },
      result_json: evaluation,
      total_score: evaluation.total_score,
      total_label: evaluation.total_label,
    });

    if (insertEval.error) {
      // No bloqueamos el flujo: el FODA ya está validado.
      // Pero devolvemos warning.
      return NextResponse.json(
        {
          ok: true,
          validated: true,
          score: evaluation.total_score,
          label: evaluation.total_label,
          feedback: evaluation.feedback,
          warning: "FODA validado, pero no se pudo insertar la evaluación.",
          warningDetail: insertEval.error,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        validated: true,
        score: evaluation.total_score,
        label: evaluation.total_label,
        feedback: evaluation.feedback,
      },
      { status: 200 }
    );
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    if (msg === "FORBIDDEN_DOMAIN") return fail(403, "FORBIDDEN_DOMAIN", "Acceso restringido.");
    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
