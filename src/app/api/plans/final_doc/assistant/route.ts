// src/app/api/plans/final_doc/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { supabaseServer } from "@/lib/supabaseServer";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

export const runtime = "nodejs";

const STAGE = 10;
const PERIOD_KEY = getPeriodKeyLaPaz();

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
    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "No se pudo leer el perfil del estudiante.",
        },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });


    // Gate: requiere que exista Etapa 9 validada (reporte de avances)
    const stage9Result = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 9,
      artifactType: "progress_final",
      periodKey: PERIOD_KEY,
    });

    if (!stage9Result.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Etapa 9 (Reporte de avances) validada.",
          detail: stage9Result.error,
        },
        { status: 500 }
      );
    }

    const stage9 = stage9Result.row;
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

    const fodaResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 2,
      artifactType: "foda_analysis",
      periodKey: PERIOD_KEY,
    });

    const brainstormResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 3,
      artifactType: "brainstorm_ideas",
      periodKey: PERIOD_KEY,
    });

    const ishResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 4,
      artifactType: "ishikawa_final",
      periodKey: PERIOD_KEY,
    });

    const paretoResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 5,
      artifactType: "pareto_final",
      periodKey: PERIOD_KEY,
    });

    const objectivesResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 6,
      artifactType: "objectives_final",
      periodKey: PERIOD_KEY,
    });

    const improvementResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 7,
      artifactType: "improvement_final",
      periodKey: PERIOD_KEY,
    });

    const planningResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 8,
      artifactType: "planning_final",
      periodKey: PERIOD_KEY,
    });

    const foda = fodaResult.ok ? fodaResult.row : null;
    const brainstorm = brainstormResult.ok ? brainstormResult.row : null;
    const ish = ishResult.ok ? ishResult.row : null;
    const pareto = paretoResult.ok ? paretoResult.row : null;
    const objectives = objectivesResult.ok ? objectivesResult.row : null;
    const improvement = improvementResult.ok ? improvementResult.row : null;
    const planning = planningResult.ok ? planningResult.row : null;

    // Timeline de etapas (solo validadas) para “continuidad/proceso”
    const timelineChatIds = Array.from(
      new Set(
        [
          foda?.chat_id,
          brainstorm?.chat_id,
          ish?.chat_id,
          pareto?.chat_id,
          objectives?.chat_id,
          improvement?.chat_id,
          planning?.chat_id,
          stage9?.chat_id,
        ].filter((value): value is string => typeof value === "string" && value.length > 0)
      )
    );

    let timelineQuery = supabaseServer
      .from("plan_stage_artifacts")
      .select("stage, artifact_type, updated_at, chat_id")
      .eq("user_id", user.userId)
      .eq("period_key", PERIOD_KEY)
      .eq("status", "validated")
      .in("stage", [2, 3, 4, 5, 6, 7, 8, 9]);

    if (timelineChatIds.length > 0) {
      timelineQuery = timelineQuery.in("chat_id", timelineChatIds);
    }

    const { data: timelineRows } = await timelineQuery.order("updated_at", {
      ascending: true,
    });

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
FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa". 

FORMATO DEL MENSAJE:
- Escribe en párrafos cortos y claros.
- Separa ideas distintas con una línea en blanco.
- Evita bloques largos de texto continuo.
- Usa viñetas o numeración solo cuando realmente ayuden a ordenar pasos, semanas, ajustes, criterios, causas o elementos pendientes.
- No conviertas todo en lista; si basta con 1 o 2 párrafos, responde así.
- Si haces una pregunta final, colócala en un párrafo aparte.
- Puedes usar un emoji discreto solo cuando aporte cercanía o claridad, no en todos los mensajes.
- El mensaje debe verse bien en chat: legible, espaciado y fácil de seguir.

OBJETIVO:
- Leer el documento final (texto extraído).
- Extraer secciones clave del formato PAP-PM-01.
- Cruzar con las etapas validadas (2–9) y con el registro de horas (semanal).
- Emitir feedback + calificación estricta (notas variadas, no siempre 100).

REGLAS:
- Máximo 2 versiones: si es versión 2, será la definitiva aunque tenga fallas.
- Si es versión 1 y hay problemas importantes, se pide corrección (subir versión 2).
- NO exigir evidencias extra ni archivos adicionales.
- NO acusar plagio: solo describir señales de concentración temporal, vacíos metodológicos o inconsistencias y recomendar justificar o corregir.
- Sé estricto con la nota: no otorgues puntajes altos por simple buena redacción si hay incoherencias metodológicas.
- Un documento puede estar bien redactado y aun así recibir nota media si no coincide con lo validado antes.
- Penaliza con claridad cuando haya cambios no justificados entre Pareto, Objetivos, Plan de Mejora, Planificación, Avance y documento final.

RÚBRICA (0-100) — 4 ítems:
1) Coherencia metodológica del documento (30%)
   - diagnóstico -> causas -> objetivos -> propuesta -> implementación
   - sin saltos lógicos
   - penaliza fuerte si el documento cambia de enfoque sin explicación
2) Consistencia con lo validado en el Asesor (30%)
   - coherencia con Pareto/Objetivos/Plan/Planificación/Avance
   - cambios deben ser justificables
   - si el documento contradice lo validado, baja la nota aunque el texto esté bien escrito
3) Proceso y continuidad de trabajo (25%)
   - señales temporales de etapas + horas
   - coherencia entre “lo que dice el documento” y “lo que registró”
   - penaliza concentración excesiva del trabajo al final si el documento presume un proceso largo no respaldado
4) Calidad técnica y redacción (15%)
   - claridad, estructura, redacción técnica
   - no premies redacción bonita si el contenido metodológico es débil

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
      "continuidad_observada": "string",
      "secciones_debiles": ["string"],
      "justificaciones_faltantes": ["string"]
    },
    "mejoras": ["string","string","string"],
    "needs_resubmission": boolean
  }
}

CRITERIOS DE SEVERIDAD:
- "Bien" solo si el documento es consistentemente sólido y alineado con lo trabajado antes.
- "Adecuado" si cumple razonablemente pero aún tiene vacíos o ajustes importantes.
- "Regular" si hay incoherencias metodológicas, cambios poco justificados o proceso débil.
- "Deficiente" si el documento no sostiene la lógica del proyecto aunque tenga buena forma.
- No entregues 95+ salvo que la coherencia metodológica, la consistencia con el asesor y la continuidad del proceso sean realmente fuertes.

ENTRADAS:
- Versión del documento: ${versionNumber}
- Archivo: ${fileName}
- Texto del documento (extracto completo):
${extractedText}

ETAPAS VALIDADAS (si falta alguna, sé conservador y menciona que no hay evidencia suficiente):
- FODA (2): ${JSON.stringify(foda?.payload ?? null)}
- Lluvia de ideas (3): ${JSON.stringify(brainstorm?.payload ?? null)}
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
        assistantMessage: sanitizeStudentPlaceholder(
          String(json.assistantMessage ?? ""),
          preferredFirstName
        ),
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
