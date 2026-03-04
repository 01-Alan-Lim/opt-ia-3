// src/app/api/plans/improvement/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

type ImprovementInitiative = {
  id: string;
  title: string;
  description: string;
  linkedRoot: string | null; // causa crítica (Pareto) o raíz (Ishikawa)
  linkedObjective: string | null; // objetivo específico
  measurement: {
    indicator: string | null; // puede ser cualitativo
    kpi: string | null; // opcional
    target: string | null; // opcional
  };
  feasibility: {
    estimatedWeeks: number | null;
    notes: string | null;
  };
};

export type ImprovementState = {
  stageIntroDone: boolean;
  step: "discover" | "build" | "refine" | "review";
  focus: {
    chosenRoot: string | null;
    chosenObjective: string | null;
  };
  initiatives: ImprovementInitiative[];
  lastSummary: string | null;
};

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  improvementState: z.record(z.string(), z.unknown()),
  caseContext: z.record(z.string(), z.unknown()).optional(),
  recentHistory: z.string().optional(),
});

function extractJsonSafe(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // ignore
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
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

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Body inválido.",
        },
        { status: 400 }
      );
    }

    const { chatId, studentMessage, improvementState, caseContext, recentHistory } = parsed.data;

    const PERIOD_KEY = getPeriodKeyLaPaz();

    // 1) Leer Pareto final validado (Etapa 5) para raíces críticas
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
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Pareto final (Etapa 5).",
          detail: paretoErr,
        },
        { status: 500 }
      );
    }

    const paretoPayload = (paretoFinal as { payload?: unknown } | null)?.payload as
      | { criticalRoots?: unknown }
      | undefined;
    const criticalRoots = asStringArray(paretoPayload?.criticalRoots);

    if (criticalRoots.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 7 necesitas Pareto final validado con causas críticas (top 20%).",
        },
        { status: 400 }
      );
    }

    // 2) Leer Objectives final validado (Etapa 6)
    const { data: objectivesFinal, error: objErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", 6)
      .eq("artifact_type", "objectives_final")
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (objErr) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Objectives final (Etapa 6).",
          detail: objErr,
        },
        { status: 500 }
      );
    }

    const objectivesPayload = (objectivesFinal as { payload?: unknown } | null)?.payload as
      | {
          generalObjective?: unknown;
          specificObjectives?: unknown;
          linkedCriticalRoots?: unknown;
        }
      | undefined;

    const generalObjective = String(objectivesPayload?.generalObjective ?? "").trim();
    const specificObjectives = asStringArray(objectivesPayload?.specificObjectives);
    const linkedCriticalRoots = asStringArray(objectivesPayload?.linkedCriticalRoots);

    if (!generalObjective || specificObjectives.length < 1 || linkedCriticalRoots.length < 1) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 7 necesitas Objetivos (Etapa 6) validados.",
        },
        { status: 400 }
      );
    }

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos.
Estás guiando la **Etapa 7: Plan de Mejora**.

OBJETIVO DE LA ETAPA 7:
- Construir un Plan de Mejora coherente y ejecutable en ~4 a 6 semanas (1 a 1.5 meses).
- Debe responder a: Causas críticas (Pareto) -> Objetivos (Etapa 6) -> Acciones/iniciativas.
- Conversación FLUIDA (tipo docente), NO formulario.

REGLAS:
- NO uses opciones tipo “A/B”. Interpreta lo que el estudiante escribe.
- Si el estudiante ya tiene una idea, ayúdalo a pulirla y a vincularla a una causa crítica y un objetivo específico.
- Si no tiene idea o duda, propón 1-2 ideas de alto impacto (pero viables en el tiempo) basadas en el contexto.
- Evita soluciones triviales tipo “solo checklist”. Una iniciativa debe ser un pequeño paquete (2-4 componentes) como:
  - estandarizar (SOP/método),
  - control simple (registro/seguimiento),
  - micro-capacitación puntual,
  - piloto y ajuste.
- KPI NO es obligatorio. Si no hay KPI, usa indicador/criterio cualitativo y enseña cómo medir si el estudiante pregunta.
- Haz preguntas cortas y concretas (1 o 2 máximo por turno).
- Mantén tono breve, humano y útil.

CAUSAS CRÍTICAS (Pareto Etapa 5, top 20%):
${JSON.stringify(criticalRoots, null, 2)}

OBJETIVOS VALIDADOS (Etapa 6):
- Objetivo General: ${JSON.stringify(generalObjective)}
- Objetivos Específicos: ${JSON.stringify(specificObjectives, null, 2)}
- Causas críticas vinculadas oficialmente: ${JSON.stringify(linkedCriticalRoots, null, 2)}

CONTEXTO DEL CASO (si existe):
${JSON.stringify(caseContext ?? {}, null, 2)}

ESTADO ACTUAL (Etapa 7):
${JSON.stringify(improvementState, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON con este formato:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "stageIntroDone": boolean,
      "step": "discover" | "build" | "refine" | "review",
      "focus": { "chosenRoot": string | null, "chosenObjective": string | null },
      "initiatives": [
        {
          "id": "string",
          "title": "string",
          "description": "string",
          "linkedRoot": "string | null",
          "linkedObjective": "string | null",
          "measurement": { "indicator": "string | null", "kpi": "string | null", "target": "string | null" },
          "feasibility": { "estimatedWeeks": number | null, "notes": "string | null" }
        }
      ],
      "lastSummary": "string | null"
    },
    "action": "init" | "add_initiative" | "refine_initiative" | "ask_clarify" | "summarize" | "redirect" | "ready_to_validate"
  }
}

CRITERIOS INTERNOS (sin decirlos como lista al estudiante):
- Vincular iniciativas a una causa crítica (preferentemente) y a un objetivo específico.
- Mantener viabilidad (estimación total ~4-6 semanas).
- Al final, cuando haya un plan coherente, ofrecer cerrar Etapa 7 y pasar a Etapa 8 (Planificación).
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
  } catch (e: unknown) {
    const err = e as { message?: string };
    const msg = err?.message ?? "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(
        { ok: false, code: "UNAUTHORIZED", message: "Sesión inválida o ausente." },
        { status: 401 }
      );
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN_DOMAIN", message: "Dominio no permitido." },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { ok: false, code: "INTERNAL", message: "Error interno.", detail: msg },
      { status: 500 }
    );
  }
}
