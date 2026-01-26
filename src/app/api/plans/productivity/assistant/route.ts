// src/app/api/plans/productivity/assistant/route.ts
// Orquestador LLM para Etapa 1 (Productividad): conversación fluida tipo ChatGPT,
// pero salida JSON estructurada para actualizar estado y aplicar gates.

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

// -----------------------------
// Schemas
// -----------------------------

const CostSchema = z.object({
  name: z.string().min(1).max(80),
  amount_bs: z.number().finite().nonnegative(),
  note: z.string().min(1).max(400).optional(),
});

const PatchSchema = z
  .object({
    unit_type: z.enum(["monetaria", "fisica"]).nullable().optional(),
    unit_reason: z.string().max(600).nullable().optional(),
    period: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
    income_bs: z.number().finite().nonnegative().nullable().optional(),
    income_line: z.string().max(120).nullable().optional(),
  })
  .strict();

const AssistantResponseSchema = z
  .object({
    assistantMessage: z.string().min(1).max(6000),
    updates: z
      .object({
        step: z.number().int().min(1).max(5),
        patch: PatchSchema,
        addCosts: z.array(CostSchema).max(10),
      })
      .strict(),
    control: z
      .object({
        needsClarification: z.boolean(),
        doneWithStage: z.boolean(),
      })
      .strict(),
    signals: z
      .object({
        uncertainty: z.number().min(0).max(1),
        confusion: z.number().min(0).max(1),
        confidence_extract: z.number().min(0).max(1),
      })
      .partial()
      .optional(),
  })
  .strict();

const BodySchema = z.object({
  // mensaje del estudiante (se permite "__START__" para iniciar el flujo)
  studentMessage: z.string().min(1).max(2000),
  // estado actual del wizard
  prodStep: z.number().int().min(1).max(5),
  prodDraft: z.record(z.string(), z.unknown()),
  // contexto del caso ya confirmado (Etapa 0)
  caseContext: z.record(z.string(), z.unknown()).optional(),
  // historial reciente (texto resumido) para ayudar coherencia sin inflar tokens
  recentHistory: z.string().max(6000).optional(),
});

// -----------------------------
// JSON parsing helpers
// -----------------------------

function extractFirstJsonObject(rawText: string): string | null {
  const text = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function tryParseJsonLoose(extracted: string): unknown {
  try {
    return JSON.parse(extracted);
  } catch {
    // continue
  }

  const cleaned = extracted
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\u0000/g, "")
    .trim();

  return JSON.parse(cleaned);
}

function buildSystemPrompt(): string {
  return `
Eres OPT-IA, un asesor académico y práctico para estudiantes de Ingeniería Industrial.
Tu estilo conversacional debe sentirse como ChatGPT: natural, humano, pedagógico, con ejemplos breves, y preguntas bien guiadas.
PERO estás operando dentro de un flujo estructurado (Etapa 1: Productividad) y debes actualizar un estado en base de datos.

PRIVACIDAD
- No pidas ni repitas nombres reales de empresas/personas. Si el estudiante los menciona, reemplázalos por "la empresa".

OBJETIVO GLOBAL (Etapa 1: Productividad)
Debes completar estos campos del estado:
1) unit_type: monetaria o fisica
2) unit_reason: justificación breve
3) period: YYYY-MM
4) income_bs: ingreso mensual (solo si monetaria)
5) income_line: línea/producto
6) costs: exactamente REQUIRED_COSTS costos con name + amount_bs + note

GATE
- NO marques doneWithStage=true hasta que:
  - unit_type definido
  - period válido
  - income_bs definido si unit_type=monetaria
  - costs tenga exactamente REQUIRED_COSTS items completos
- Cuando esté completo, resume y pide confirmación.
- Solo si el estudiante confirma, marca doneWithStage=true.

NO INVENTES DATOS
- No inventes montos ni periodos.
- Si falta claridad o hay ambigüedad, needsClarification=true y haz UNA pregunta.

STEPS
Step 1: elegir unit_type y reason.
Step 2: elegir period (YYYY-MM).
Step 3: ingresos (si monetaria).
Step 4: costos (uno por uno hasta REQUIRED_COSTS).
Step 5: confirmación final.

INICIO
- Si USER_MESSAGE es "__START__", da una breve introducción (1-2 frases) y pregunta del Step actual.

SALIDA OBLIGATORIA
Responde SOLO con JSON válido (sin markdown, sin texto extra) con este formato:
{
  "assistantMessage": string,
  "updates": {
    "step": 1..5,
    "patch": {
      "unit_type": "monetaria"|"fisica"|null,
      "unit_reason": string|null,
      "period": "YYYY-MM"|null,
      "income_bs": number|null,
      "income_line": string|null
    },
    "addCosts": [ {"name": string, "amount_bs": number, "note": string} ]
  },
  "control": { "needsClarification": boolean, "doneWithStage": boolean },
  "signals": { "uncertainty": 0..1, "confusion": 0..1, "confidence_extract": 0..1 }
}

REGLAS DE patch y addCosts
- patch: solo coloca valores si estás seguro; si no, null.
- addCosts: agrega SOLO costos completos (name + amount + note). Si falta monto/explicación, no agregues.
- step: solo avanza cuando el dato del step actual está suficientemente completo.
`.trim();
}

export async function POST(req: Request) {
  try {
    await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const { studentMessage, prodStep, prodDraft, caseContext, recentHistory } = parsed.data;

    const requiredCostsRaw = prodDraft["required_costs"];
    const requiredCosts =
    typeof requiredCostsRaw === "number" && Number.isFinite(requiredCostsRaw)
        ? (Math.trunc(requiredCostsRaw) === 3 ? 3 : 4)
        : 4;

    const model = getGeminiModel();
    const system = buildSystemPrompt().replaceAll("REQUIRED_COSTS", String(requiredCosts));

    const resp = await model.generateContent([
      { text: system },
      { text: `CASE_CONTEXT_JSON: ${JSON.stringify(caseContext ?? {})}` },
      { text: `CURRENT_STATE_JSON: ${JSON.stringify({ prodStep, prodDraft })}` },
      { text: `RECENT_HISTORY: ${recentHistory ?? ""}` },
      { text: `USER_MESSAGE: ${studentMessage}` },
    ]);

    const text = resp.response.text().trim();

    let json: unknown;
    try {
      const extracted = extractFirstJsonObject(text);
      if (!extracted) throw new Error("NO_JSON_OBJECT");
      json = tryParseJsonLoose(extracted);
    } catch {
      return ok({
        assistantMessage:
          "No pude interpretar bien tu respuesta. ¿Puedes decirlo en una frase corta (con números si aplica)?",
        updates: { step: prodStep, patch: {}, addCosts: [] },
        control: { needsClarification: true, doneWithStage: false },
        signals: { uncertainty: 0.8, confusion: 0.4, confidence_extract: 0.2 },
      });
    }

    const valid = AssistantResponseSchema.safeParse(json);
    if (!valid.success) {
      return ok({
        assistantMessage:
          "No pude interpretar bien tu respuesta. ¿Puedes reformularla en una frase corta?",
        updates: { step: prodStep, patch: {}, addCosts: [] },
        control: { needsClarification: true, doneWithStage: false },
        signals: { uncertainty: 0.8, confusion: 0.4, confidence_extract: 0.2 },
      });
    }

    // Normalización: si signals no viene, poner defaults suaves
    const out = valid.data;
    const signals = {
      uncertainty: out.signals?.uncertainty ?? 0,
      confusion: out.signals?.confusion ?? 0,
      confidence_extract: out.signals?.confidence_extract ?? 1,
    };

    return ok({ ...out, signals });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
