// src/app/api/plans/context/interpret/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { ok, fail, failResponse } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const InterpretSchema = z.object({
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  userText: z.string().min(1).max(2000),
  currentContextJson: z.record(z.string(), z.any()).optional(),
});

const InterpretResultSchema = z.object({
  intent: z.enum(["GREETING", "QUESTION", "START", "EDIT", "CONFIRM", "ANSWER"]),
  sector: z.string().optional(),
  products: z.array(z.string()).optional(),
  process_focus: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().optional(),
});

/**
 * Extrae el primer objeto JSON {...} balanceando llaves.
 * Tolera fences ```json ... ``` y texto extra fuera del JSON.
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
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJsonLoose(extracted: string): unknown {
  // 1) intento estricto
  try {
    return JSON.parse(extracted);
  } catch {
    // seguimos
  }

  // 2) intento "loose" (errores típicos del LLM)
  const cleaned = extracted
    // comillas simples -> dobles (frecuente)
    .replace(/'/g, '"')
    // trailing commas: { "a": 1, }  o  [1,2,]
    .replace(/,\s*([}\]])/g, "$1")
    // caracteres invisibles raros
    .replace(/\u0000/g, "")
    .trim();

  return JSON.parse(cleaned);
}

function buildSystemPrompt(step: 1 | 2 | 3) {
  const stepDesc =
    step === 1
      ? "Step 1: need ONLY the company sector/rubro (e.g., alimentos, textil, servicios)."
      : step === 2
      ? "Step 2: need ONLY 1-3 main products/services (strings)."
      : "Step 3: need ONLY the main working area/process focus (1-3 items, e.g., Producción, Calidad, Logística).";

  // Importante: mostrar un ejemplo de JSON VALIDADO (sin ? y sin tipos TypeScript)
    return `
You are an assistant that extracts structured answers for a 3-question onboarding wizard.

Return ONLY a VALID JSON object with these keys:
- intent: "GREETING" | "QUESTION" | "START" | "EDIT" | "CONFIRM" | "ANSWER"
- sector: string (only when step=1 and intent=ANSWER)
- products: string[] (only when step=2 and intent=ANSWER)
- process_focus: string[] (only when step=3 and intent=ANSWER)
- confidence: number between 0 and 1
- needsClarification: boolean
- clarificationQuestion: string (Spanish) only if needsClarification=true

Rules:
- ${stepDesc}
- If user greets or small talk, intent=GREETING.
- If user asks what to answer, says they do not understand, asks for examples, or asks a question about the wizard, intent=QUESTION.
- If user says "empezar/iniciar/comenzar", intent=START.
- If user says they want to change/edit/modify previous answers, intent=EDIT.
- If user confirms "ok/listo/vamos/si", intent=CONFIRM.
- Otherwise intent=ANSWER.
- For intent=ANSWER: extract ONLY the field relevant to the current step. Do NOT hallucinate.
- If the user message is not semantically compatible with the current step, then:
  needsClarification=true
  and provide a short clarificationQuestion in Spanish.
- Step 1 expects the business sector or rubro. A valid answer is a category such as alimentos, textil, servicios, logística, manufactura, metalmecánica, etc.
- Step 2 expects the main product(s) or service(s) the student will work with. A valid answer names what the company makes or delivers.
- Step 3 expects the main working area or process. A valid answer names where the student will focus, such as Producción, Calidad, Logística, Inventarios, Ventas, Mantenimiento, etc.
- If the user gives a reply that belongs to another step, do not accept it as valid for the current step.
- If the user mixes useful information with extra context, rescue only the fragment that clearly answers the current step.
- Do not over-extract. If the answer is ambiguous, partial, or weakly implied, prefer needsClarification=true.
- If the message mainly expresses confusion, doubt, lack of understanding, or asks for help, mark needsClarification=true and ask a short helpful question in Spanish.
- Prefer semantic understanding over keyword matching.
- If the answer includes both a valid field and unrelated commentary, keep only the valid field.
- If the info is clear:
  needsClarification=false and set confidence >= 0.7.
- Output must be ONLY JSON. No markdown. No commentary.

Example output (valid JSON):
{
  "intent": "ANSWER",
  "sector": "Alimentos",
  "confidence": 0.9,
  "needsClarification": false
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

    const { step, userText } = parsed.data;

    const model = getGeminiModel();
    const system = buildSystemPrompt(step);

    const resp = await model.generateContent([
      { text: system },
      { text: `USER_MESSAGE: ${userText}` },
    ]);

    const text = resp.response.text().trim();
    console.log("[interpret] RAW_MODEL_TEXT:", text);

    // Parseo tolerante: extraemos el primer JSON válido
    let json: unknown;
    try {
      const extracted = extractFirstJsonObject(text);

      if (!extracted) {
        console.warn("[interpret] NO_JSON_OBJECT. Raw model text:", text);
        throw new Error("NO_JSON_OBJECT");
      }

      // ✅ parse estricto + parse loose
      json = tryParseJsonLoose(extracted);
    } catch (err) {
      console.warn("[interpret] PARSE_FAILED. Raw model text:", text);
      console.warn("[interpret] Error:", err);

      return ok({
        intent: "ANSWER",
        confidence: 0.2,
        needsClarification: true,
        clarificationQuestion:
          step === 1
            ? "¿Me dices el **sector/rubro** de la empresa? (ej: alimentos, textil, servicios)"
            : step === 2
            ? "¿Cuáles son 1 a 3 **productos/servicios** principales?"
            : "¿En qué **área** trabajarás principalmente? (Producción, Calidad, Logística, etc.)",
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

    console.log("[interpret] PARSED_RESULT:", valid.data);
    return ok(valid.data);
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
