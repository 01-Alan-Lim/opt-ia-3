// src/app/api/plans/planning/assistant/route.ts
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

const STAGE = 8;
const PERIOD_KEY = getPeriodKeyLaPaz();

type PlanningMilestone = {
  id: string;
  title: string;
  week: number | null; // 1..N
  deliverable: string | null;
};

type PlanningWeekItem = {
  week: number;
  focus: string; // resumen de la semana
  tasks: string[];
  evidence: string | null;
  measurement: string | null;
};

export type PlanningState = {
  stageIntroDone: boolean;
  step: "time_window" | "breakdown" | "schedule" | "review";
  time: {
    studentWeeks: number | null;
    courseCutoffDate: string | null; // ISO date, opcional (desde contexto del curso)
    effectiveWeeks: number | null; // calculado (si hay cutoff)
    notes: string | null;
  };
  plan: {
    weekly: PlanningWeekItem[];
    milestones: PlanningMilestone[];
    risks: string[]; // opcional, simple
  };
  lastSummary: string | null;
};

const BodySchema = z.object({
  chatId: z.string().uuid(),
  studentMessage: z.string().min(1),
  planningState: z.record(z.string(), z.unknown()),
  caseContext: z.record(z.string(), z.unknown()).optional(),
  recentHistory: z.string().optional(),
});

// intenta extraer JSON del LLM
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

function asString(v: unknown): string {
  return String(v ?? "").trim();
}

function parseCourseCutoffDate(ctx: Record<string, unknown> | undefined): string | null {
  // No inventamos de dónde sale; solo aceptamos si el contexto ya lo trae.
  const v = ctx?.courseCutoffDate;
  const s = asString(v);
  if (!s) return null;
  return s;
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

    const { chatId, studentMessage, planningState, caseContext, recentHistory } = parsed.data;

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

    // 1) Leer Plan de Mejora final validado (Etapa 7)
    const improvementResult = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId,
      stage: 7,
      artifactType: "improvement_final",
      periodKey: PERIOD_KEY,
    });

    if (!improvementResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: "DB_ERROR",
          message: "No se pudo leer Plan de Mejora final (Etapa 7).",
          detail: improvementResult.error,
        },
        { status: 500 }
      );
    }

    const improvementFinal = improvementResult.row;

    if (!improvementFinal?.payload) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Para iniciar Etapa 8 necesitas Etapa 7 (Plan de Mejora) validada.",
        },
        { status: 400 }
      );
    }

    const improvementPayload = improvementFinal.payload as any;

    const initiatives = Array.isArray(improvementPayload?.initiatives) ? improvementPayload.initiatives : [];
    if (initiatives.length < 1) {
      return NextResponse.json(
        { ok: false, code: "BAD_REQUEST", message: "El Plan de Mejora (Etapa 7) no tiene iniciativas." },
        { status: 400 }
      );
    }

    // corte del curso si viene en contexto
    const courseCutoffDate = parseCourseCutoffDate(caseContext);

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor (Ingeniería Industrial). Estás guiando la **Etapa 8: Planificación**.
FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa".

OBJETIVO:
- Convertir el Plan de Mejora (Etapa 7) en un **cronograma por semanas** (mini-Gantt textual).
- Debe ser realista según el tiempo disponible.
- Conversación fluida (no formulario, no A/B). Máximo 1-2 preguntas por turno.

REGLAS:
- Si el estudiante no sabe semanas o fecha, menciona el **corte del curso** si está disponible.
- Si el tiempo real es corto, ayuda a **recortar alcance**: prioriza piloto + medición mínima + ajuste básico.
- No intentes meter todo si no cabe. Señala con claridad qué sí entra en el tiempo y qué quedaría fuera.
- Construye una secuencia lógica: preparar -> implementar/pilotear -> medir -> ajustar/cerrar.
- Cada iniciativa debe quedar con: actividades base, hito(s) y medición mínima.
- Si el plan del estudiante es demasiado ambicioso, conviértelo en una versión mínima viable sin perder coherencia metodológica.
- Prioriza hitos críticos y evita cronogramas “bonitos” pero poco ejecutables.
- Al final, entrega un cronograma por semanas.

DATOS DISPONIBLES:
- Corte del curso (si existe): ${JSON.stringify(courseCutoffDate)}
- Plan de Mejora validado (Etapa 7):
${JSON.stringify(
  {
    generalObjective: improvementPayload?.generalObjective ?? null,
    linkedCriticalRoots: improvementPayload?.linkedCriticalRoots ?? null,
    initiatives: initiatives.map((i: any) => ({
      title: i?.title ?? null,
      description: i?.description ?? null,
      linkedObjective: i?.linkedObjective ?? null,
      linkedRoot: i?.linkedRoot ?? null,
      measurement: i?.measurement ?? null,
      feasibility: i?.feasibility ?? null,
    })),
  },
  null,
  2
)}

ESTADO ACTUAL (Etapa 8):
${JSON.stringify(planningState, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "stageIntroDone": boolean,
      "step": "time_window" | "breakdown" | "schedule" | "review",
      "time": {
        "studentWeeks": number | null,
        "courseCutoffDate": string | null,
        "effectiveWeeks": number | null,
        "notes": string | null
      },
      "plan": {
        "weekly": [
          { "week": number, "focus": "string", "tasks": ["string"], "evidence": "string | null", "measurement": "string | null" }
        ],
        "milestones": [
          { "id": "string", "title": "string", "week": number | null, "deliverable": "string | null" }
        ],
        "risks": ["string"]
      },
      "lastSummary": "string | null"
    },
    "action": "init" | "ask_time" | "propose_schedule" | "refine_schedule" | "summarize" | "ready_to_validate"
  }
}

NOTA:
- No inventes datos sensibles. Si faltan, pregunta.
- No cierres automáticamente la etapa solo porque ya exista un cronograma razonable.
- Si detectas que la planificación no cabe en el tiempo, dilo con claridad y ajusta el alcance.
- Si la planificación ya está bastante completa, resume lo acordado, explica por qué el cronograma sí es realista y pide confirmación antes de dejar la etapa lista para validación.
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

    // fuerza courseCutoffDate en state si viene del contexto (para consistencia)
    try {
      const next = json.updates.nextState as any;
      if (courseCutoffDate) {
        next.time = next.time ?? {};
        next.time.courseCutoffDate = courseCutoffDate;
      }
    } catch {}

    json.assistantMessage = sanitizeStudentPlaceholder(
      String(json.assistantMessage ?? ""),
      preferredFirstName
    );

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
