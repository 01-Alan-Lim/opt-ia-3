// src/app/api/plans/progress/assistant/route.ts
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

const PERIOD_KEY = getPeriodKeyLaPaz();

const ProgressStateSchema = z.object({
  step: z.enum(["intro", "report", "clarify", "review"]),
  reportText: z.string().nullable(),
  progressPercent: z.number().min(0).max(100).nullable(),
  measurementNote: z.string().nullable(),
  summary: z.string().nullable(),
  updatedAtLocal: z.string().nullable(),
});

type ProgressState = z.infer<typeof ProgressStateSchema>;

const ProgressAssistantResponseSchema = z.object({
  assistantMessage: z.string().min(1),
  updates: z.object({
    nextState: ProgressStateSchema,
    action: z.enum(["ask_report", "ask_clarify", "summarize", "ready_to_validate"]),
  }),
});

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  progressState: z.record(z.string(), z.unknown()),
  recentHistory: z.string().optional(),
});

function extractJsonSafe(text: string): unknown | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function trimOrNull(value: string | null | undefined): string | null {
  const parsed = String(value ?? "").trim();
  return parsed.length > 0 ? parsed : null;
}

function normalizeProgressState(input: ProgressState): ProgressState {
  return {
    step: input.step,
    reportText: trimOrNull(input.reportText),
    progressPercent: clampPercent(input.progressPercent),
    measurementNote: trimOrNull(input.measurementNote),
    summary: trimOrNull(input.summary),
    updatedAtLocal: trimOrNull(input.updatedAtLocal),
  };
}

function normalizeStudentMessage(text: string): string {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

function isGenericContinuationMessage(text: string): boolean {
  const normalized = normalizeStudentMessage(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:!?¡¿()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const exactMatches = new Set([
    "ok",
    "si",
    "sí",
    "listo",
    "dale",
    "sigamos",
    "continuemos",
    "que sigue",
    "qué sigue",
    "como avanzamos",
    "cómo avanzamos",
    "ok continuemos",
    "ok sigamos",
    "ok seguimos",
    "listo sigamos",
    "listo continuemos",
    "dale sigamos",
    "dale continuemos",
    "ok ya",
    "ok entonces",
    "listo entonces",
  ]);

  if (exactMatches.has(normalized)) {
    return true;
  }

  const starterPatterns = [
    /^ok\b/,
    /^listo\b/,
    /^dale\b/,
    /^sigamos\b/,
    /^continuemos\b/,
  ];

  return starterPatterns.some((pattern) => pattern.test(normalized));
}

function mergeReportText(current: string | null, studentMessage: string, next: string | null): string | null {
  const nextText = trimOrNull(next);
  if (nextText) return nextText;

  const currentText = trimOrNull(current);
  const studentText = trimOrNull(studentMessage);

  if (!studentText || isGenericContinuationMessage(studentText)) {
    return currentText;
  }

  if (!currentText) return studentText;
  if (currentText.includes(studentText)) return currentText;

  return `${currentText}\n${studentText}`;
}

function shortenAssistantMessage(message: string): string {
  const clean = String(message ?? "").replace(/\s+/g, " ").trim();

  if (clean.length <= 220) {
    return clean;
  }

  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return clean.slice(0, 220).trimEnd() + "...";
  }

  const firstTwo = sentences.slice(0, 2).join(" ").trim();

  if (firstTwo.length <= 220) {
    return firstTwo;
  }

  return firstTwo.slice(0, 220).trimEnd() + "...";
}

function softenProgressAssistantLead(message: string, preferredFirstName: string | null): string {
  let text = String(message ?? "").trim();

  const escapedName = String(preferredFirstName ?? "")
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const leadPatterns = [
    /^entendido,\s*/i,
    /^registrado,\s*/i,
    /^perfecto,\s*/i,
    /^de acuerdo,\s*/i,
    /^muy bien,\s*/i,
  ];

  for (const pattern of leadPatterns) {
    text = text.replace(pattern, "");
  }

  if (escapedName) {
    const nameLeadPatterns = [
      new RegExp(`^${escapedName}[,.:;\\-\\s]+`, "i"),
      new RegExp(`^(entendido|registrado|perfecto|de acuerdo|muy bien)\\s*,?\\s*${escapedName}[,.:;\\-\\s]+`, "i"),
    ];

    for (const pattern of nameLeadPatterns) {
      text = text.replace(pattern, "");
    }
  }

  text = text.replace(/^\s+/, "");
  return text.length > 0 ? text : String(message ?? "").trim();
}

async function generateProgressJson(prompt: string) {
  const model = getGeminiModel();

  const first = await model.generateContent(prompt);
  const firstText = first.response.text();
  const firstJson = extractJsonSafe(firstText);

  if (firstJson) {
    return { json: firstJson, raw: firstText };
  }

  const repairPrompt = `
Convierte la siguiente respuesta a JSON válido, sin agregar explicaciones.

Devuelve SOLO JSON crudo con este formato exacto:
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

RESPUESTA ORIGINAL A CONVERTIR:
${firstText}
`;

  const repaired = await model.generateContent(repairPrompt);
  const repairedText = repaired.response.text();
  const repairedJson = extractJsonSafe(repairedText);

  return {
    json: repairedJson,
    raw: firstText,
    repairedRaw: repairedText,
  };
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

    const { chatId, studentMessage, progressState, recentHistory } = parsed.data;

    const progressStateParse = ProgressStateSchema.safeParse(progressState);
    if (!progressStateParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "progressState inválido.",
          detail: progressStateParse.error.flatten(),
        },
        { status: 400 }
      );
    }

    const currentProgressState = normalizeProgressState(progressStateParse.data);

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "No se pudo leer el perfil del estudiante." },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const planningResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 8,
      artifactType: "planning_final",
      periodKey: PERIOD_KEY,
    });

    if (!planningResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Planificación final (Etapa 8).",
          detail: planningResult.error,
        },
        { status: 500 }
      );
    }

    const planningFinal = planningResult.row;

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

    const normalizedStudentMessage = normalizeStudentMessage(studentMessage);
    const accumulatedReportText = mergeReportText(
      currentProgressState.reportText,
      normalizedStudentMessage,
      null
    );

    const hasRealReportText =
      typeof accumulatedReportText === "string" && accumulatedReportText.trim().length > 0;

    if (!hasRealReportText && isGenericContinuationMessage(normalizedStudentMessage)) {
      const nextState: ProgressState = normalizeProgressState({
        ...currentProgressState,
        step: "report",
        reportText: null,
        progressPercent: currentProgressState.progressPercent,
        measurementNote: currentProgressState.measurementNote,
        summary: currentProgressState.summary,
        updatedAtLocal: new Date().toISOString(),
      });

      return NextResponse.json(
        {
          ok: true,
          data: {
            assistantMessage:
              "Perfecto. Ahora sí cuéntame brevemente qué actividades lograste ejecutar hasta hoy respecto a tu cronograma. Puede ser algo simple, por ejemplo: qué sí hiciste, qué quedó pendiente o si hubo algún desvío.",
            updates: {
              nextState,
              action: "ask_report",
            },
          },
        },
        { status: 200 }
      );
    }

  const prompt = `
Eres un asistente académico de Ingeniería Industrial y estás guiando la ETAPA 9: REPORTE DE AVANCES.

TU FUNCIÓN EN ESTA ETAPA:
- Recopilar lo que el estudiante sí ejecutó.
- Contrastar brevemente contra la planificación validada de Etapa 8.
- Registrar si el avance es completo, parcial o nulo.
- Hacer seguimiento breve, no asesoría extensa.

REGLAS ESTRICTAS DE RESPUESTA:
- Responde de forma natural, breve y fluida.
- Máximo 2 oraciones cortas.
- Máximo 1 pregunta por turno.
- No hagas párrafos largos.
- No replanifiques.
- No vuelvas a explicar el cronograma completo.
- No des recomendaciones extensas.
- No hagas análisis largos.
- No pidas tablas, archivos ni evidencias.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No uses placeholders como [nombre], [student], [Nombre del estudiante].
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa".

COMPORTAMIENTO OBLIGATORIO:
1. Si el estudiante reporta un avance concreto:
   - Confirma brevemente lo registrado.
   - Indica si parece avance parcial o pendiente.
   - Haz solo una pregunta corta si falta un dato.

2. Si el estudiante dice que no avanzó:
   - Registra que esa actividad sigue pendiente.
   - Pregunta brevemente por el motivo o bloqueo.
   - Haz solo una pregunta corta.

3. Si el estudiante da suficiente información:
   - Indica que el avance ya quedó registrado.
   - Deja el estado listo para revisión o cierre, sin discurso largo.

4. Si el mensaje del estudiante es corto pero útil, debes procesarlo.
   Ejemplo:
   - "solo pude realizar la capacitación"
   - "no pude avanzar"
   - "quedó pendiente la medición"

CRITERIO DE TONO:
- Debes sonar como una IA útil y ágil.
- No como robot.
- No como un docente dando una explicación larga.
- No repitas demasiado lo ya dicho.

PLANIFICACIÓN BASE VALIDADA (ETAPA 8):
${JSON.stringify(planningFinal.payload, null, 2)}

ESTADO ACTUAL DE ETAPA 9:
${JSON.stringify(currentProgressState, null, 2)}

REPORTE ACUMULADO HASTA AHORA:
${JSON.stringify(accumulatedReportText, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

ÚLTIMO MENSAJE DEL ESTUDIANTE:
"${normalizedStudentMessage}"

IMPORTANTE:
- Devuelve SOLO JSON crudo.
- NO uses markdown.
- NO uses bloques \`\`\`.
- NO agregues texto antes ni después del JSON.
- NO expliques que responderás en JSON.

DEVUELVE SOLO JSON con este formato exacto:
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

    const llmResult = await generateProgressJson(prompt);

    if (!llmResult.json) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM no devolvió JSON válido.",
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const responseParse = ProgressAssistantResponseSchema.safeParse(llmResult.json);
    if (!responseParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "El assistant devolvió JSON, pero no con la estructura esperada en Etapa 9.",
          detail: responseParse.error.flatten(),
          raw: llmResult.raw,
          repairedRaw: llmResult.repairedRaw ?? null,
        },
        { status: 500 }
      );
    }

    const responseData = responseParse.data;
    const normalizedNextState = normalizeProgressState(responseData.updates.nextState);

    normalizedNextState.reportText = mergeReportText(
      currentProgressState.reportText,
      normalizedStudentMessage,
      normalizedNextState.reportText
    );

    normalizedNextState.progressPercent = clampPercent(normalizedNextState.progressPercent);

    if (!normalizedNextState.updatedAtLocal) {
      normalizedNextState.updatedAtLocal = new Date().toISOString();
    }

    responseData.updates.nextState = normalizedNextState;

    const sanitizedMessage = sanitizeStudentPlaceholder(
      responseData.assistantMessage,
      preferredFirstName
    );

    const softenedMessage = softenProgressAssistantLead(
      sanitizedMessage,
      preferredFirstName
    );

    responseData.assistantMessage = shortenAssistantMessage(softenedMessage);

    return NextResponse.json({ ok: true, data: responseData }, { status: 200 });
  } catch (error: unknown) {
    const err = error as { message?: string };
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