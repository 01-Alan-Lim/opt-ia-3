// src/app/api/plans/final_doc/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const STAGE = 10;
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // YYYY-MM

const BodySchema = z.object({
  chatId: z.string().uuid(),
  fileName: z.string().min(1),
  storagePath: z.string().min(1),
  extractedText: z.string().min(50), // texto ya extraído desde /api/plans/upload
  versionNumber: z.number().int().min(1).max(2), // 1 o 2
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

function toISO(d: Date) {
  return d.toISOString();
}

type StageSnapshot = {
  stage: number;
  artifact_type: string;
  updated_at: string | null;
  payload: any;
};

async function loadLatestValidated(
  userId: string,
  chatId: string,
  stage: number,
  artifactType: string
): Promise<StageSnapshot | null> {
  const { data, error } = await supabaseServer
    .from("plan_stage_artifacts")
    .select("stage, artifact_type, payload, updated_at")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("stage", stage)
    .eq("artifact_type", artifactType)
    .eq("period_key", PERIOD_KEY)
    .eq("status", "validated")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as any;
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

    const { chatId, fileName, storagePath, extractedText, versionNumber, recentHistory } = parsed.data;

    // Gate: requiere que exista Etapa 9 validada (reporte de avances)
    // Nota: si por algún motivo Etapa 9 aún no existe en tu proyecto, devuelve error claro.
    const stage9 = await loadLatestValidated(user.userId, chatId, 9, "progress_final");
    if (!stage9?.payload) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 10 necesitas Etapa 9 (Reporte de avances) validada.",
        },
        { status: 400 }
      );
    }

    // Etapas previas que vamos a cruzar (si alguna falta, no inventamos: se incluye null y la IA debe ser conservadora)
    const ish = await loadLatestValidated(user.userId, chatId, 4, "ishikawa_final");
    const pareto = await loadLatestValidated(user.userId, chatId, 5, "pareto_final");
    const objectives = await loadLatestValidated(user.userId, chatId, 6, "objectives_final");
    const improvement = await loadLatestValidated(user.userId, chatId, 7, "improvement_final");
    const planning = await loadLatestValidated(user.userId, chatId, 8, "planning_final");

    // Timeline de etapas (solo validadas) para “continuidad/proceso”
    const { data: timelineRows } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("stage, artifact_type, updated_at")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .in("stage", [4, 5, 6, 7, 8, 9])
      .order("updated_at", { ascending: true });

    const timeline = (timelineRows ?? []).map((r: any) => ({
      stage: r.stage,
      artifact_type: r.artifact_type,
      updated_at: r.updated_at ?? null,
    }));

    // Horas (para coherencia con trabajo real)
    const { data: hoursRows } = await supabaseServer
      .from("hours_entries")
      .select("period_start, period_end, hours, activity, created_at")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: true })
      .limit(200);

    const hoursSummary = (hoursRows ?? []).map((h: any) => ({
      period_start: h.period_start,
      period_end: h.period_end,
      hours: h.hours,
      activity: h.activity,
      created_at: h.created_at,
    }));

    // Señales simples para la IA (sin “acusar”)
    const firstStageAt = timeline.find((t) => t.updated_at)?.updated_at ?? null;
    const lastStageAt = timeline.length ? timeline[timeline.length - 1]?.updated_at ?? null : null;

    const processSignals = {
      stageTimeline: timeline,
      firstStageValidatedAt: firstStageAt,
      lastStageValidatedAt: lastStageAt,
      hoursCount: hoursSummary.length,
      hoursFirstAt: hoursSummary[0]?.created_at ?? null,
      hoursLastAt: hoursSummary.length ? hoursSummary[hoursSummary.length - 1]?.created_at ?? null : null,
      now: toISO(new Date()),
      note:
        "Usa estas señales para evaluar continuidad/proceso. No acuses plagio; describe concentración o coherencia temporal.",
    };

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor (Ingeniería Industrial). Estás en la **Etapa 10: Revisión final del documento (Word)**.
Esto NO es chat largo. Analiza, cruza y devuelve feedback académico.

OBJETIVO:
- Leer el documento final (texto extraído).
- Extraer secciones clave del formato PAP-PM-01.
- Cruzar con las etapas validadas (4–9) y con el registro de horas (semanal).
- Emitir feedback + calificación estricta (notas variadas, no siempre 100).

REGLAS:
- Máximo 2 versiones: si es versión 2, será la definitiva aunque tenga fallas.
- Si es versión 1 y hay problemas importantes, se pide corrección (subir versión 2).
- NO exigir evidencias extra ni archivos adicionales.
- NO acusar plagio: solo describir señales (concentración temporal, inconsistencias) y recomendar justificar o corregir.

RÚBRICA (0-100) — 4 ítems:
1) Coherencia metodológica del documento (30%)
   - diagnóstico → causas → objetivos → propuesta → implementación
   - sin saltos lógicos
2) Consistencia con lo validado en el Asesor (25%)
   - coherencia con Pareto/Objetivos/Plan/Planificación/Avance
   - cambios deben ser justificables
3) Proceso y continuidad de trabajo (30%)
   - señales temporales de etapas + horas
   - coherencia entre “lo que dice el documento” y “lo que registró”
4) Calidad técnica y redacción (15%)
   - claridad, estructura, redacción técnica (sin relleno genérico)

Devuelve SOLO JSON:
{
  "assistantMessage": "string (feedback corto, accionable, sin acusar)",
  "extractedSections": {
    "resumen_ejecutivo": "string|null",
    "diagnostico": "string|null",
    "objetivos": "string|null",
    "propuesta_mejora": "string|null",
    "plan_implementacion": "string|null",
    "conclusiones": "string|null"
  },
  "evaluation": {
    "total_score": number (0-100),
    "total_label": "Deficiente" | "Regular" | "Adecuado" | "Bien",
    "detail": {
      "coherencia_metodologica": number,
      "consistencia_asesor": number,
      "proceso_continuidad": number,
      "calidad_redaccion": number
    },
    "signals": {
      "inconsistencias_detectadas": ["string"],
      "cambios_importantes": ["string"],
      "continuidad_observada": "string"
    },
    "mejoras": ["string","string","string"],
    "needs_resubmission": boolean
  }
}

ENTRADAS:
- Versión del documento: ${versionNumber}
- Archivo: ${fileName}
- Texto del documento (extracto completo):
${extractedText}

ETAPAS VALIDADAS (si falta alguna, sé conservador y menciona que no hay evidencia suficiente):
- Ishikawa (4): ${JSON.stringify(ish?.payload ?? null)}
- Pareto (5): ${JSON.stringify(pareto?.payload ?? null)}
- Objetivos (6): ${JSON.stringify(objectives?.payload ?? null)}
- Plan de Mejora (7): ${JSON.stringify(improvement?.payload ?? null)}
- Planificación (8): ${JSON.stringify(planning?.payload ?? null)}
- Avance (9): ${JSON.stringify(stage9?.payload ?? null)}

SEÑALES DE PROCESO (timeline + horas):
${JSON.stringify({ processSignals, hoursSummary }, null, 2)}

HISTORIAL RECIENTE (solo contexto conversacional, no inventes):
${String(recentHistory ?? "")}
`;

    const llmRes = await model.generateContent(prompt);
    const llmText = llmRes.response.text();
    const json = extractJsonSafe(llmText);

    if (!json?.assistantMessage || !json?.evaluation?.detail) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "IA no devolvió JSON válido.", raw: llmText },
        { status: 500 }
      );
    }

    // Construir nextState mínimo para guardar en Stage 10
    const nextState = {
      step: "review",
      versionNumber,
      upload: {
        fileName,
        storagePath,
        extractedText,
        uploadedAt: new Date().toISOString(),
      },
      extractedSections: json.extractedSections ?? null,
      evaluation: json.evaluation ?? null,
      finalized: false,
    };

    return NextResponse.json(
      {
        ok: true,
        assistantMessage: json.assistantMessage,
        updates: {
          nextState,
          action: (json?.evaluation?.needs_resubmission ? "request_v2" : "ready_to_finalize") as
            | "request_v2"
            | "ready_to_finalize",
        },
      },
      { status: 200 }
    );
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
