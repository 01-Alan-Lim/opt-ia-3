// src/app/api/plans/objectives/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";

export const runtime = "nodejs";

const ObjectivesStateSchema = z.object({
  generalObjective: z.string(),
  specificObjectives: z.array(z.string()),
  linkedCriticalRoots: z.array(z.string()),
  step: z.enum(["general", "specific", "review"]),
});

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().trim().min(1).max(4000),
  objectivesState: ObjectivesStateSchema,
  caseContext: z.record(z.string(), z.unknown()).nullable().optional(),
  recentHistory: z.string().max(12000).optional(),
});

type ObjectivesState = z.infer<typeof ObjectivesStateSchema>;

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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
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
          message: parsed.error.issues[0]?.message ?? "Payload inválido.",
        },
        { status: 400 }
      );
    }

    const {
      chatId,
      studentMessage,
      objectivesState,
      caseContext = null,
      recentHistory = "",
    } = parsed.data;

    const periodKey = getPeriodKeyLaPaz();

    const paretoResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 5,
      artifactType: "pareto_final",
      periodKey,
    });

    if (!paretoResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "No se pudo leer Pareto final (Etapa 5).",
          detail: paretoResult.error,
        },
        { status: 500 }
      );
    }

    const paretoFinal = paretoResult.row;
    const criticalRoots = asStringArray(paretoFinal?.payload?.criticalRoots);

    if (criticalRoots.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message:
            "Para iniciar Objetivos (Etapa 6) necesitas Pareto validado con causas críticas (top 20%). " +
            "Si ya terminaste Pareto pero abriste otro chat, primero hay que re-sincronizar el avance real.",
        },
        { status: 400 }
      );
    }

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos y estás guiando la ETAPA 6: OBJETIVOS.

TU FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- NO suenes robótico.
- NO repitas siempre la misma estructura.
- Lee lo que escribió el estudiante e interprétalo antes de responder.
- Si el estudiante está perdido, ayúdalo a empezar con 1 propuesta concreta.
- Si el estudiante escribió algo incompleto pero útil, rescata la idea y mejórala.
- Si el estudiante propone algo mal enfocado, corrige con tacto y explica por qué.
- Haz máximo 1 o 2 preguntas puntuales.
- No inventes datos del caso.
- No reveles nombres reales de empresas o personas.

OBJETIVO DE LA ETAPA:
- Formular 1 objetivo general.
- Formular mínimo 3 objetivos específicos.
- Asegurar trazabilidad con las causas críticas del Pareto.
- Mantener redacción clara, defendible y evaluable.

CAUSAS CRÍTICAS OFICIALES DEL PARETO:
${JSON.stringify(criticalRoots, null, 2)}

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

ESTADO ACTUAL DE OBJETIVOS:
${JSON.stringify(objectivesState, null, 2)}

HISTORIAL RECIENTE:
${recentHistory}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

INSTRUCCIONES PEDAGÓGICAS:
- Si step = "general":
  - enfócate primero en construir o corregir el objetivo general.
  - si el estudiante no sabe cómo empezar, propón una redacción base personalizada según su caso.
- Si step = "specific":
  - ayúdalo a convertir el objetivo general en 3 o más objetivos específicos.
  - evita objetivos que sean actividades sueltas.
- Si step = "review":
  - mejora claridad, coherencia y vínculo con causas críticas.
- Si el estudiante escribe algo muy corto como "ok como comenzamos?", NO lo bloquees de forma seca:
  - explícale brevemente qué van a hacer
  - propón una primera versión tentativa del objetivo general
  - luego pídele que la confirme o ajuste

DEVUELVE SOLO JSON CON ESTE FORMATO:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "generalObjective": "string",
      "specificObjectives": ["string"],
      "linkedCriticalRoots": ["string"],
      "step": "general" | "specific" | "review"
    },
    "action": "init" | "draft_general" | "draft_specific" | "refine" | "ask_clarify" | "redirect"
  }
}

REGLAS DEL JSON:
- assistantMessage debe sonar humano, guiado y contextual.
- nextState.generalObjective debe ser una sola oración cuando ya exista borrador útil.
- nextState.specificObjectives puede crecer gradualmente.
- nextState.linkedCriticalRoots debe incluir mínimo 1 causa crítica oficial cuando ya haya suficiente contexto.
- Nunca devuelvas texto fuera del JSON.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "LLM no devolvió JSON válido.",
          detail: text,
        },
        { status: 500 }
      );
    }

    const nextStateParse = ObjectivesStateSchema.safeParse(json.updates.nextState);
    if (!nextStateParse.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INTERNAL",
          message: "El assistant devolvió un nextState inválido.",
          detail: nextStateParse.error.flatten(),
        },
        { status: 500 }
      );
    }

    const responseData: {
      assistantMessage: string;
      updates: {
        nextState: ObjectivesState;
        action: string;
      };
    } = {
      assistantMessage: String(json.assistantMessage),
      updates: {
        nextState: nextStateParse.data,
        action: String(json?.updates?.action ?? "refine"),
      },
    };

    return NextResponse.json({ ok: true, data: responseData }, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

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