// src/app/api/plans/objectives/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type ObjectivesState = {
  generalObjective: string;
  specificObjectives: string[];
  linkedCriticalRoots: string[];
  step: "general" | "specific" | "review";
};

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
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(
        { ok: false, code: gate.reason, message: gate.message },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body?.studentMessage || !body?.objectivesState || !body?.chatId) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", message: "Missing chatId/studentMessage/objectivesState" },
        { status: 400 }
      );
    }

    const chatId: string = String(body.chatId);
    const studentMessage: string = String(body.studentMessage);
    const objectivesState: ObjectivesState = body.objectivesState;
    const caseContext = body.caseContext ?? {};
    const recentHistory = String(body.recentHistory ?? "");

    const PERIOD_KEY = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Leer Pareto final (Etapa 5) validado para obtener criticalRoots
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

    if (paretoErr) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "No se pudo leer Pareto final (Etapa 5).", detail: paretoErr },
        { status: 500 }
      );
    }

    const criticalRoots: string[] = Array.isArray(paretoFinal?.payload?.criticalRoots)
      ? paretoFinal!.payload.criticalRoots.map((x: any) => String(x).trim()).filter(Boolean)
      : [];

    if (criticalRoots.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Objetivos (Etapa 6) necesitas Pareto validado con causas críticas (top 20%).",
        },
        { status: 400 }
      );
    }

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos.
Estás guiando la **Etapa 6: Objetivos del Plan de Mejora (MVP)**.

PROPÓSITO:
- Formular 1 Objetivo General + mínimo 3 Objetivos Específicos.
- Deben estar fundamentados en las **causas críticas (top 20%)** del Pareto.
- Deben ser claros, medibles y alcanzables (tipo SMART, sin decir "SMART" todo el tiempo).

REGLAS IMPORTANTES:
- Conversación fluida, breve y pedagógica.
- NO inventes datos del caso.
- Si el estudiante propone objetivos que no atacan las causas críticas, corrige y redirige.
- Usa las causas críticas como “por qué / justificación”.
- Si falta información, pregunta 1-2 cosas puntuales máximo.

CAUSAS CRÍTICAS (TOP 20% - Etapa 5 Pareto):
${JSON.stringify(criticalRoots, null, 2)}

CONTEXTO DEL CASO (si existe):
${JSON.stringify(caseContext, null, 2)}

ESTADO ACTUAL (Etapa 6):
${JSON.stringify(objectivesState, null, 2)}

HISTORIAL RECIENTE:
${recentHistory}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON con este formato:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "generalObjective": "string",
      "specificObjectives": ["string", "string", "string"],
      "linkedCriticalRoots": ["string"],
      "step": "general" | "specific" | "review"
    },
    "action": "init" | "draft_general" | "draft_specific" | "refine" | "ask_clarify" | "redirect"
  }
}

CRITERIOS:
- generalObjective: 1 oración clara.
- specificObjectives: al menos 3, en infinitivo ("Reducir...", "Implementar...") y medibles (incluye una métrica o porcentaje si el estudiante la tiene; si no la tiene, propón estructura medible sin inventar números).
- linkedCriticalRoots: selecciona las causas críticas que justifican los objetivos (mínimo 1).
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "LLM no devolvió JSON válido", raw: text },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: json }, { status: 200 });
  } catch (e: any) {
    const msg = e?.message ?? "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." }, { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json({ ok: false, code: "FORBIDDEN_DOMAIN", message: "Dominio no permitido." }, { status: 403 });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL", message: "Error interno.", detail: msg }, { status: 500 });
  }
}
