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
  userText: z.string().min(1).max(4000),
  currentContextJson: z.record(z.string(), z.unknown()).optional(),
});

const StringArraySchema = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string()).optional()
);

const InterpretResultSchema = z.object({
  intent: z.enum(["GREETING", "QUESTION", "START", "EDIT", "CONFIRM", "ANSWER"]),
  sector: z.string().optional(),
  products: StringArraySchema,
  process_focus: StringArraySchema,
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().optional(),
});

type ContextJson = Record<string, unknown>;

function extractFirstJsonObject(rawText: string): string | null {
  const text = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }

  return null;
}

function tryParseJsonLoose(extracted: string): unknown {
  try {
    return JSON.parse(extracted);
  } catch {
    // Continue with a tolerant parse for common LLM JSON slips.
  }

  const cleaned = extracted
    .replace(/'/g, '"')
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\u0000/g, "")
    .trim();

  return JSON.parse(cleaned);
}

function cleanValue(input: string) {
  return input
    .replace(/\s+/g, " ")
    .replace(/^[-*.,;:\s]+/, "")
    .replace(/[-*.,;:\s]+$/, "")
    .trim();
}

function cleanSector(input: string | undefined) {
  if (!input) return undefined;

  const cleaned = cleanValue(input)
    .replace(/^es\s+una\s+empresa\s+de\s+/i, "")
    .replace(/^empresa\s+de\s+/i, "")
    .replace(/^sector\s*:?\s*/i, "")
    .replace(/^rubro\s*:?\s*/i, "")
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 120) : undefined;
}

function cleanList(input: string[] | undefined) {
  if (!Array.isArray(input)) return undefined;

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const cleaned = cleanValue(item)
      .replace(/^fabrican\s+/i, "")
      .replace(/^fabrica\s+/i, "")
      .replace(/^productos?\s*:?\s*/i, "")
      .replace(/^servicios?\s*:?\s*/i, "")
      .replace(/^quiero\s+(analizar|enfocarme\s+en|trabajar\s+en)\s+/i, "")
      .replace(/^area\s+de\s+/i, "")
      .replace(/^area\s*:?\s*/i, "")
      .replace(/^proceso\s*:?\s*/i, "")
      .trim();

    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.slice(0, 140));
  }

  return out.length > 0 ? out.slice(0, 3) : undefined;
}

function hasUsableExtraction(result: z.infer<typeof InterpretResultSchema>) {
  return Boolean(
    cleanSector(result.sector) ||
      cleanList(result.products)?.length ||
      cleanList(result.process_focus)?.length
  );
}

function fallbackQuestion(step: 1 | 2 | 3) {
  if (step === 1) {
    return "Me dices el sector o rubro de la empresa? Por ejemplo: alimentos, textil, servicios, manufactura o logistica.";
  }

  if (step === 2) {
    return "Cuales son 1 a 3 productos o servicios principales de la empresa?";
  }

  return "En que area o proceso principal quieres enfocar el analisis? Por ejemplo: produccion, calidad, inventarios o logistica.";
}

function getPendingFieldsLabel(contextJson: ContextJson, step: 1 | 2 | 3) {
  const sector = typeof contextJson.sector === "string" ? contextJson.sector.trim() : "";
  const products = Array.isArray(contextJson.products) ? contextJson.products : [];
  const processFocus = Array.isArray(contextJson.process_focus)
    ? contextJson.process_focus
    : [];

  const pending: string[] = [];
  if (!sector) pending.push("sector/rubro");
  if (products.length === 0) pending.push("productos/servicios");
  if (processFocus.length === 0) pending.push("area/proceso foco");

  if (pending.length > 0) return pending.join(", ");

  return step === 1
    ? "sector/rubro"
    : step === 2
      ? "productos/servicios"
      : "area/proceso foco";
}

function buildSystemPrompt(step: 1 | 2 | 3, currentContextJson: ContextJson) {
  const stepDesc =
    step === 1
      ? "Step 1 currently needs the company sector/rubro."
      : step === 2
        ? "Step 2 currently needs 1 to 3 main products/services."
        : "Step 3 currently needs the main area/process focus.";

  return `
You are an academic mentor for OPT-IA. Your job is to interpret a student's message while collecting the base context for an Industrial Engineering improvement-plan case.

Return ONLY valid JSON with:
{
  "intent": "GREETING" | "QUESTION" | "START" | "EDIT" | "CONFIRM" | "ANSWER",
  "sector": "string, optional",
  "products": ["strings, optional"],
  "process_focus": ["strings, optional"],
  "confidence": 0.0,
  "needsClarification": true,
  "clarificationQuestion": "Spanish, optional"
}

Current step:
- ${stepDesc}
- Missing data: ${getPendingFieldsLabel(currentContextJson, step)}

Interpretation rules:
- GREETING: greetings or small talk only.
- QUESTION: the student asks what to answer, asks for examples, says "no se", says they do not understand, asks what "rubro" means, asks if a microbusiness is valid, asks what you can do, or asks an unrelated topic such as line balancing.
- START: the student asks to start.
- EDIT: the student wants to change, edit, or correct a previous context field.
- CONFIRM: short confirmation such as ok, listo, vamos, si.
- ANSWER: the message provides usable case-context data.

Extraction rules:
- Extract every clear field present in the message, even if the message includes multiple fields at once.
- Clean the values. Do not copy wrappers like "es una empresa de", "fabrican", "quiero analizar", "quiero enfocarme en".
- Sector/rubro examples: textil, alimentos, servicios, manufactura, metalmecanica, logistica.
- Products/services examples: poleras, buzos, pan, yogurt, mantenimiento, despacho.
- Area/process focus examples: produccion, calidad, inventarios, logistica, mantenimiento, ventas.
- If the student says "Es una empresa textil que fabrica poleras y quiero analizar produccion", return sector="textil", products=["poleras"], process_focus=["produccion"].
- If the message is help, example request, definition request, small talk, or unrelated, do not extract data.
- If the message has no usable context data, set needsClarification=true and ask only for the next missing field.
- If useful context data was extracted, set needsClarification=false and confidence >= 0.7.
- Be conservative: never save "no se", "dame ejemplos", "que significa rubro", "hablame de balanceo de linea", or "que puedes hacer" as case data.
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
        fail("BAD_REQUEST", "Payload invalido."),
        { status: 400 }
      );
    }

    const { step, userText } = parsed.data;
    const currentContextJson = parsed.data.currentContextJson ?? {};

    const model = getGeminiModel();
    const system = buildSystemPrompt(step, currentContextJson);

    const resp = await model.generateContent([
      { text: system },
      { text: `CURRENT_CONTEXT_JSON: ${JSON.stringify(currentContextJson, null, 2)}` },
      { text: `USER_MESSAGE: ${userText}` },
    ]);

    const text = resp.response.text().trim();

    let json: unknown;
    try {
      const extracted = extractFirstJsonObject(text);
      if (!extracted) throw new Error("NO_JSON_OBJECT");
      json = tryParseJsonLoose(extracted);
    } catch (err) {
      console.warn("[plans] context/interpret: parse fallido", err);

      return ok({
        intent: "QUESTION",
        confidence: 0.2,
        needsClarification: true,
        clarificationQuestion: fallbackQuestion(step),
      });
    }

    const valid = InterpretResultSchema.safeParse(json);
    if (!valid.success) {
      console.error("[plans] context/interpret: respuesta zod invalida", valid.error.flatten());
      return ok({
        intent: "QUESTION",
        confidence: 0.2,
        needsClarification: true,
        clarificationQuestion:
          "No pude interpretar bien tu respuesta. Puedes decirlo en una frase corta?",
      });
    }

    const normalized = {
      ...valid.data,
      sector: cleanSector(valid.data.sector),
      products: cleanList(valid.data.products),
      process_focus: cleanList(valid.data.process_focus),
    };

    if (normalized.intent === "ANSWER" && !hasUsableExtraction(valid.data)) {
      return ok({
        ...normalized,
        intent: "QUESTION" as const,
        confidence: Math.min(normalized.confidence, 0.4),
        needsClarification: true,
        clarificationQuestion: normalized.clarificationQuestion ?? fallbackQuestion(step),
      });
    }

    return ok(normalized);
  } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "Sesion invalida o ausente.", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido.", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesion por un timeout temporal con el servicio de autenticacion.",
        503
      );
    }

    console.error("[plans] context/interpret: error interno", err);
    return failResponse("INTERNAL", "Error interno.", 500);
  }
}
