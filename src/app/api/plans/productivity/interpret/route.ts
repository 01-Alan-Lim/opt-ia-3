// src/app/api/plans/productivity/interpret/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { ok, fail, failResponse } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const InterpretSchema = z.object({
  userText: z.string().min(1).max(2000),
  // lo que ya tenemos (para que el modelo complete sin inventar)
  currentDraft: z.record(z.string(), z.any()).optional(),
});

const InterpretResultSchema = z.object({
  intent: z.enum(["QUESTION", "ANSWER", "VALIDATE", "EDIT", "OTHER", "HELP_ME_CHOOSE"]),
  // respuesta humana (cuando el user pregunta algo)
  assistantReply: z.string().optional(),
  // campos extraídos (solo lo que esté en el userText)
  extracted: z
    .object({
      period_key: z.string().regex(/^\d{4}-\d{2}$/).optional(), // YYYY-MM
      productivity_type: z.enum(["monetaria", "fisica"]).optional(),
      income_bs: z.number().nonnegative().optional(),
      // costos como lista simple (nombre + monto)
      costs: z
        .array(
          z.object({
            name: z.string().min(1).max(80),
            amount_bs: z.number().nonnegative(),
          })
        )
        .optional(),
      notes: z.string().max(2000).optional(),
      justification: z.string().max(500).optional(),
      has_justification: z.boolean().optional()
    })
    .optional(),
  // para volver al flujo siempre
  nextQuestion: z.string().optional(),
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().optional(),
});

/**
 * Extrae el primer objeto JSON {...} balanceando llaves.
 */
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
    // "loose"
  }
  const cleaned = extracted
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\u0000/g, "")
    .trim();

  return JSON.parse(cleaned);
}

function buildSystemPrompt() {
  return `
You are an academic assistant for Industrial Engineering students.

Goal: help the student complete "Stage 1 - Productivity Report" in a guided but natural conversation in Spanish.

You will receive:
- CURRENT_DRAFT_JSON: what is already captured. Use it to avoid asking again.
- USER_MESSAGE: the student's latest message.

Return ONLY VALID JSON with keys:
- intent: "QUESTION" | "ANSWER" | "VALIDATE" | "EDIT" | "OTHER" | "HELP_ME_CHOOSE"
- assistantReply: string (only if intent=QUESTION/OTHER and user needs a brief explanation in Spanish)
- extracted: object with any extracted fields found in USER_MESSAGE (do NOT invent):
   - period_key: "YYYY-MM"
   - productivity_type: "monetaria" | "fisica"
   - income_bs: number
   - costs: [{ name: string, amount_bs: number }]
   - notes: string
   - has_justification: boolean (true ONLY if the user explicitly gave a reason for choosing monetaria/fisica)
   - justification: string (short reason, only if present)
- nextQuestion: string (Spanish) - the best next question to continue the report
- confidence: 0..1
- needsClarification: boolean
- clarificationQuestion: string (Spanish) only if needsClarification=true

Core conversation rules:
1) Natural conversation: the user does NOT need to answer "A" or "B". They might say:
   - "Trabajaré con monetaria"
   - "Unidades físicas"
   - "No estoy seguro, ayúdame a elegir"
2) Justification requirement (IMPORTANT):
   - If USER_MESSAGE indicates a choice of productivity_type but NO reason is given,
     set extracted.productivity_type accordingly, set extracted.has_justification=false,
     set needsClarification=true, and ask a follow-up "¿Por qué?" in clarificationQuestion.
   - If a reason exists, set extracted.has_justification=true and include extracted.justification.
3) If the user says they are not sure or asks for help choosing:
   - intent MUST be "HELP_ME_CHOOSE"
   - needsClarification can be false
   - nextQuestion should ask 1 short diagnostic question to decide (e.g., whether they have ingresos/costos OR physical output/time).
4) If the user asks what something means:
   - intent="QUESTION"
   - provide assistantReply briefly in Spanish
   - set nextQuestion to continue the workflow.
5) If user says "validar", "revisar", "ya está", "listo para validar":
   - intent="VALIDATE"
6) Do NOT invent numbers or fields. Extract data even if mixed in a paragraph.
7) If you cannot confidently extract required info: needsClarification=true + a short clarificationQuestion.

Output must be ONLY JSON. No markdown. No extra text.

Examples:

Example A (choice WITHOUT justification):
USER_MESSAGE: "Ok, usaré unidades monetarias."
{
  "intent":"ANSWER",
  "extracted":{"productivity_type":"monetaria","has_justification":false},
  "confidence":0.85,
  "needsClarification":true,
  "clarificationQuestion":"Perfecto ✅ ¿Por qué elegiste productividad monetaria?",
  "nextQuestion":""
}

Example B (choice WITH justification):
USER_MESSAGE: "Monetaria, porque sí tengo ingresos y costos mensuales."
{
  "intent":"ANSWER",
  "extracted":{"productivity_type":"monetaria","has_justification":true,"justification":"Tiene ingresos y costos mensuales"},
  "confidence":0.9,
  "needsClarification":false,
  "nextQuestion":"🧩 Paso 2/4 — Periodo mensual: dime el mes en formato YYYY-MM. Ej: 2026-02"
}

Example C (help choosing):
USER_MESSAGE: "No sé cuál escoger, ayúdame."
{
  "intent":"HELP_ME_CHOOSE",
  "confidence":0.9,
  "needsClarification":false,
  "nextQuestion":"¿Tienes registrados ingresos y costos en Bs por mes para esa línea? (sí/no)"
}
`.trim();
}


export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });

    const raw = await req.json().catch(() => null);
    const parsed = InterpretSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const { userText, currentDraft } = parsed.data;

    const model = getGeminiModel();
    const system = buildSystemPrompt();

    const resp = await model.generateContent([
      { text: system },
      { text: `CURRENT_DRAFT_JSON: ${JSON.stringify(currentDraft ?? {})}` },
      { text: `USER_MESSAGE: ${userText}` },
    ]);

    const text = resp.response.text().trim();
    console.log("[prod-interpret] RAW_MODEL_TEXT:", text);

    let json: unknown;
    try {
      const extracted = extractFirstJsonObject(text);
      if (!extracted) throw new Error("NO_JSON_OBJECT");
      json = tryParseJsonLoose(extracted);
    } catch (err) {
      console.warn("[prod-interpret] PARSE_FAILED:", err);
      return ok({
        intent: "ANSWER",
        confidence: 0.2,
        needsClarification: true,
        clarificationQuestion:
          "No pude interpretar bien tu respuesta. ¿Puedes decirlo en una frase corta (con números si aplica)?",
      });
    }

    const valid = InterpretResultSchema.safeParse(json);
    if (!valid.success) {
      return ok({
        intent: "ANSWER",
        confidence: 0.2,
        needsClarification: true,
        clarificationQuestion:
          "No pude interpretar bien tu respuesta. ¿Puedes reformularla en una frase corta?",
      });
    }

    console.log("[prod-interpret] PARSED_RESULT:", valid.data);

    const out = valid.data;
    // Si detectó productivity_type pero no incluyó has_justification,
    // asumimos que falta (para no avanzar por error).
    if (out.extracted?.productivity_type && typeof out.extracted.has_justification !== "boolean") {
      out.extracted.has_justification = false;
    }

    return ok(out);
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    return failResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "Error interno.",
      500
    );
  }
}
