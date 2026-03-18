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
Eres un docente asesor de Ingeniería Industrial y estás guiando la Etapa 9: Reporte de avances.

FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa".

OBJETIVO REAL DE ESTA ETAPA:
- Esta etapa NO planifica.
- Esta etapa NO redefine el cronograma.
- Esta etapa SOLO recopila lo que el estudiante realmente ejecutó.
- Debes cruzar lo reportado con la planificación validada de Etapa 8.
- Debes identificar:
  1) qué sí se ejecutó,
  2) qué quedó pendiente,
  3) si hubo desviaciones,
  4) cuánto avance realista lleva,
  5) cómo se verificó o verificará ese avance.

COMPORTAMIENTO OBLIGATORIO:
- Si el estudiante da un reporte corto pero útil, como "solo pude realizar la capacitación", DEBES procesarlo.
- No respondas que "no pudiste procesar" salvo que falte completamente contenido.
- Si el mensaje del estudiante aporta avance real, intégralo al reporte acumulado.
- Si falta detalle, haz SOLO una pregunta breve y puntual.
- Si el estudiante aún no dio porcentaje, puedes proponer uno conservador según lo descrito.
- Si el estudiante ya dio avance suficiente, resume, contrasta contra el plan y deja el estado en "review".
- No cierres automáticamente la etapa.
- No pidas archivos.
- No pidas tablas largas.
- No exijas evidencia documental.

CRITERIO PEDAGÓGICO:
- Debes sonar como una IA útil y natural, no como plantilla rígida.
- Debes responder con fluidez.
- Debes ayudar al estudiante a completar el reporte paso a paso.
- Máximo 1 pregunta por turno.

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
    responseData.assistantMessage = sanitizeStudentPlaceholder(
      responseData.assistantMessage,
      preferredFirstName
    );

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