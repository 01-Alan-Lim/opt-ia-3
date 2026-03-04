// src/app/api/plans/progress/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const STAGE = 9;
const PERIOD_KEY = getPeriodKeyLaPaz();

type ProgressState = {
  step: "intro" | "report" | "clarify" | "review";
  reportText: string | null;
  progressPercent: number | null; // 0-100
  measurementNote: string | null; // textual (cómo verificó/medirá)
  summary: string | null;
  updatedAtLocal: string | null;
};

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  progressState: z.record(z.string(), z.unknown()),
  recentHistory: z.string().optional(),
});

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

function clampPercent(n: number) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, code: gate.reason, message: gate.message }, { status: 403 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Body inválido." },
        { status: 400 }
      );
    }

    const { chatId, studentMessage, progressState, recentHistory } = parsed.data;

    // Requiere Etapa 8 validada para comparar
    const { data: planningFinal, error: planErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", 8)
      .eq("artifact_type", "planning_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (planErr) {
      return NextResponse.json(
        { ok: false, code: "DB_ERROR", message: "No se pudo leer Planificación final (Etapa 8).", detail: planErr },
        { status: 500 }
      );
    }
    if (!planningFinal?.payload) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 9 necesitas Etapa 8 (Planificación) validada.",
        },
        { status: 400 }
      );
    }

    const model = getGeminiModel();

    const prompt = `
Eres un docente asesor (Ingeniería Industrial). Estás guiando la **Etapa 9: Reporte de avances**.
Debe ser una conversación fluida, NO robótica.

OBJETIVO:
- El estudiante reporta en texto qué logró implementar vs lo planificado (Etapa 8).
- Tu tarea es:
  1) Entender el avance (qué se hizo y qué falta)
  2) Estimar un porcentaje de avance (0-100) coherente con lo reportado
  3) Generar un resumen corto (1-3 líneas)
  4) (Opcional) pedir una sola aclaración si el reporte es muy vago.

REGLAS:
- NO pidas subir archivos.
- NO exijas evidencia.
- "Medición/verificación" es solo textual (ej: "lo verificaré con tiempos / conteo / revisión supervisor").
- Máximo 1 pregunta por turno.
- Si el estudiante ya fue claro, cierra con confirmación.

PLANIFICACIÓN BASE (Etapa 8 validada):
${JSON.stringify(planningFinal.payload, null, 2)}

ESTADO ACTUAL (Etapa 9):
${JSON.stringify(progressState, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "step": "intro" | "report" | "clarify" | "review",
      "reportText": "string | null",
      "progressPercent": number | null,
      "measurementNote": "string | null",
      "summary": "string | null",
      "updatedAtLocal": "string | null"
    },
    "action": "ask_report" | "ask_clarify" | "summarize" | "ready_to_validate"
  }
}
`;

    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "LLM no devolvió JSON válido.", raw: text },
        { status: 500 }
      );
    }

    // Sanitizar porcentaje si viene
    try {
      const next = json.updates.nextState as any;
      if (typeof next?.progressPercent === "number") {
        next.progressPercent = clampPercent(next.progressPercent);
      }
    } catch {}

    return NextResponse.json({ ok: true, data: json }, { status: 200 });
  } catch (e: unknown) {
    const msg = (e as any)?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." }, { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json({ ok: false, code: "FORBIDDEN_DOMAIN", message: "Dominio no permitido." }, { status: 403 });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL", message: "Error interno.", detail: msg }, { status: 500 });
  }
}
