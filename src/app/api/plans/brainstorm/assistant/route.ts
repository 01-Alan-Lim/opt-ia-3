// src/app/api/plans/brainstorm/assistant/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";

import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import { failResponse, ok } from "@/lib/api/response";
import {
  BrainstormState,
  sanitizeBrainstormState,
  resolveBrainstormStep,
} from "@/lib/plan/brainstormFlow";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

export const runtime = "nodejs";

const BodySchema = z.object({
  studentMessage: z.string().trim().min(1).max(4000),
  brainstormState: z.unknown(),
  caseContext: z.record(z.string(), z.unknown()).nullable().optional(),
  stage1Summary: z.unknown().nullable().optional(),
  fodaSummary: z.unknown().nullable().optional(),
  recentHistory: z.string().max(12000).optional(),
});

const AssistantActionSchema = z.enum([
  "guide_strategy",
  "set_strategy",
  "set_problem",
  "add_idea",
  "ask_clarify",
  "redirect",
  "ready_to_close",
]);

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

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);

    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Payload inválido.",
        400
      );
    }

    const {
      studentMessage,
      brainstormState: brainstormStateRaw,
      caseContext,
      stage1Summary,
      fodaSummary,
      recentHistory,
    } = parsed.data;

    const brainstormState = sanitizeBrainstormState(brainstormStateRaw);
    const currentStep = resolveBrainstormStep(brainstormState);

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return failResponse(
        "INTERNAL",
        "No se pudo leer el perfil del estudiante.",
        500
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos guiando la **Etapa 3: Lluvia de ideas de causas** de un plan de mejora.

Tu tarea NO es solo extraer datos.
Tu tarea es conversar como un asesor real:
- interpretar la intención del estudiante,
- ayudarlo si está perdido,
- reformular cuando haga falta,
- y mover el flujo según el subestado actual.

NOMBRE DEL ESTUDIANTE:
- Si decides usar el nombre, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido.
- No uses placeholders tipo [nombre].

ESTILO:
- Natural, claro, académico y cercano.
- No robótico.
- Párrafos cortos.
- Máximo 1 o 2 preguntas por turno.
- No reveles nombres reales de empresas o personas. Si aparecen, reemplázalos por "la empresa".

SUBESTADO ACTUAL DE ETAPA 3:
${currentStep}

SIGNIFICADO DE CADA SUBESTADO:
- choose_strategy: el estudiante debe elegir estrategia FO / DO / FA / DA.
- define_problem: la estrategia ya está elegida; ahora hay que aterrizar 1 problemática principal.
- generate_causes: ya hay estrategia y problemática; ahora hay que construir causas claras.
- review: ya se llegó al mínimo de causas; se puede seguir refinando o cerrar.

ESTADO ACTUAL:
${JSON.stringify(brainstormState, null, 2)}

CONTEXTO DEL CASO:
${JSON.stringify(caseContext ?? {}, null, 2)}

RESUMEN ETAPA 1:
${JSON.stringify(stage1Summary ?? null, null, 2)}

RESUMEN ETAPA 2 (FODA):
${JSON.stringify(fodaSummary ?? null, null, 2)}

HISTORIAL RECIENTE:
${String(recentHistory ?? "")}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

REGLAS CRÍTICAS:
1) NO trates una pregunta de ayuda como si fuera una causa ambigua.
2) Si el estudiante pregunta "ayúdame a elegir", "cuál conviene", "no sé si FO o DO", debes ayudarlo a elegir estrategia.
3) Si el estudiante aún no definió estrategia, NO le pidas causas.
4) Si ya eligió estrategia pero no problema, ayúdalo a formular la problemática principal.
5) Si ya hay problema y el estudiante propone una causa medio cruda pero entendible, puedes reformularla tú y guardarla en forma clara.
6) Solo pide aclaración cuando realmente no se pueda entender la intención.
7) No cierres etapa automáticamente; solo deja listo el estado.
8) Si ya está en review, puedes decir que ya cumple el mínimo y preguntar si quiere seguir agregando o pasar a Ishikawa.

SALIDA OBLIGATORIA: SOLO JSON
{
  "assistantMessage": "string",
  "updates": {
    "nextState": {
      "step": "choose_strategy | define_problem | generate_causes | review",
      "strategy": { "type": "FO | DO | FA | DA", "rationale": "string opcional" } | null,
      "problem": { "text": "string" } | null,
      "ideas": [{ "text": "string" }],
      "minIdeas": number
    },
    "action": "guide_strategy | set_strategy | set_problem | add_idea | ask_clarify | redirect | ready_to_close"
  }
}

GUÍA DE COMPORTAMIENTO POR SUBESTADO:

A) Si currentStep = choose_strategy
- Puedes explicar FO / DO / FA / DA con relación al FODA real.
- Puedes recomendar una estrategia si el contexto lo sugiere.
- Si el estudiante ya eligió una estrategia aunque sea breve, guárdala.
- Si falta justificación, puedes aceptar la estrategia y luego pedir una justificación breve.
- No respondas con "no pude procesar tu idea" si en realidad te está pidiendo ayuda.

B) Si currentStep = define_problem
- Ayuda a aterrizar una problemática concreta y alcanzable.
- Si el estudiante pregunta cómo redactarla, propón 1 o 2 versiones posibles.
- Si da una versión aceptable, guárdala.

C) Si currentStep = generate_causes
- Interpreta el mensaje como posible causa o conjunto de causas.
- Si la causa es entendible pero está mal redactada, reformúlala mejor.
- Si no está alineada al problema, explícalo y redirige.
- Evita duplicados semánticos.

D) Si currentStep = review
- Reconoce que ya se cumplió el mínimo.
- Permite agregar más causas o dejar lista la etapa para pasar.

Recuerda:
- Debes pensar como asesor conversacional, no como parser rígido.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json || typeof json !== "object") {
      return failResponse(
        "INTERNAL",
        "La IA no devolvió un JSON válido para Etapa 3.",
        500,
        { raw: text }
      );
    }

    const assistantMessageRaw =
      typeof json.assistantMessage === "string" ? json.assistantMessage : "";

    const actionParsed = AssistantActionSchema.safeParse(json?.updates?.action);
    if (!assistantMessageRaw || !actionParsed.success) {
      return failResponse(
        "INTERNAL",
        "La IA devolvió una respuesta incompleta para Etapa 3.",
        500,
        { raw: text }
      );
    }

    const nextState = sanitizeBrainstormState(
      json?.updates?.nextState ?? brainstormState
    );

    const assistantMessage = sanitizeStudentPlaceholder(
      assistantMessageRaw,
      preferredFirstName
    );

    return ok({
      assistantMessage,
      updates: {
        nextState,
        action: actionParsed.data,
      },
    });
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

    if (err instanceof z.ZodError) {
      return failResponse(
        "BAD_REQUEST",
        err.issues[0]?.message ?? "Payload inválido.",
        400,
        err.flatten()
      );
    }

    return failResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "Error en Brainstorm assistant",
      500
    );
  }
}