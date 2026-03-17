// src/app/api/plans/objectives/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { supabaseServer } from "@/lib/supabaseServer";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

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

function normalizeText(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const raw = String(value ?? "").trim();
    const key = normalizeText(raw);
    if (!raw || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  return out;
}



function keepOnlyOfficialCriticalRoots(
  candidateRoots: string[],
  officialRoots: string[]
): string[] {
  const officialMap = new Map<string, string>();

  for (const root of officialRoots) {
    officialMap.set(normalizeText(root), root);
  }

  const matched: string[] = [];
  const seen = new Set<string>();

  for (const root of candidateRoots) {
    const key = normalizeText(root);
    const official = officialMap.get(key);
    if (!official) continue;

    const officialKey = normalizeText(official);
    if (seen.has(officialKey)) continue;

    seen.add(officialKey);
    matched.push(official);
  }

  return matched;
}

function tokenizeForRootMatch(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let common = 0;
  for (const token of setA) {
    if (setB.has(token)) common += 1;
  }

  return common / Math.max(setA.size, setB.size, 1);
}

function inferLinkedCriticalRootsFromText(input: {
  sources: string[];
  officialRoots: string[];
}): string[] {
  const matched: string[] = [];
  const seen = new Set<string>();

  const official = input.officialRoots.map((root) => ({
    original: root,
    normalized: normalizeText(root),
    tokens: tokenizeForRootMatch(root),
  }));

  for (const rawSource of input.sources) {
    const source = String(rawSource ?? "").trim();
    if (!source) continue;

    const sourceNormalized = normalizeText(source);
    const sourceTokens = tokenizeForRootMatch(source);

    for (const root of official) {
      let score = 0;

      if (
        sourceNormalized.includes(root.normalized) ||
        root.normalized.includes(sourceNormalized)
      ) {
        score = 1;
      } else {
        score = overlapRatio(sourceTokens, root.tokens);
      }

      if (score >= 0.6) {
        const key = normalizeText(root.original);
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(root.original);
        }
      }
    }
  }

  return matched;
}


function sanitizeSpecificObjectives(values: string[]): string[] {
  return uniqueStrings(
    values
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length >= 10)
  ).slice(0, 6);
}

function parseSpecificObjectivesFromStudentMessage(studentMessage: string): string[] {
  const text = String(studentMessage ?? "").trim();
  if (!text) return [];

  const lines = text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/^objetivos?\s+espec[ií]ficos?\s*:?/i, "")
        .replace(/^mis\s+objetivos?\s+espec[ií]ficos?\s+son\s*:?/i, "")
        .trim()
    )
    .filter(Boolean);

  return sanitizeSpecificObjectives(lines);
}

function looksLikeSpecificObjectivesDelivery(studentMessage: string): boolean {
  const normalized = normalizeText(studentMessage);
  const parsed = parseSpecificObjectivesFromStudentMessage(studentMessage);

  if (parsed.length >= 3) return true;

  if (
    parsed.length >= 2 &&
    (
      normalized.includes("objetivos especificos") ||
      normalized.includes("mis objetivos especificos") ||
      normalized.includes("objetivos especificos son") ||
      normalized.includes("especificos")
    )
  ) {
    return true;
  }

  return false;
}

function looksLikeGeneralObjectiveDraftDelivery(studentMessage: string): boolean {
  const raw = String(studentMessage ?? "").trim();
  const normalized = normalizeText(raw);

  if (!raw || raw.length < 30) return false;
  if (looksLikeSpecificObjectivesDelivery(raw)) return false;
  if (raw.includes("?") || raw.includes("¿")) return false;

  if (
    normalized.includes("mi objetivo general") ||
    normalized.includes("objetivo general") ||
    normalized.includes("mi objetivo principal")
  ) {
    return true;
  }

  const hasObjectiveVerb =
    /\b(mejorar|reducir|disminuir|incrementar|optimizar|fortalecer)\b/i.test(raw);

  const hasPurpose =
    /\b(para|mediante|a traves de|a través de)\b/i.test(raw);

  return hasObjectiveVerb && hasPurpose;
}

function looksLikeGeneralObjectiveConfirmation(studentMessage: string): boolean {
  const normalized = normalizeText(studentMessage);

  return (
    normalized.includes("si esta bien") ||
    normalized.includes("si ese esta bien") ||
    normalized.includes("me parece bien") ||
    normalized.includes("queda bien") ||
    normalized.includes("esa version esta bien") ||
    normalized.includes("usemos ese") ||
    normalized.includes("podemos usar ese") ||
    normalized.includes("aprobado") ||
    normalized.includes("validado") ||
    normalized.includes("continuemos con los especificos") ||
    normalized.includes("pasemos a los especificos") ||
    normalized.includes("ahora los especificos")
  );
}

function buildSuggestedGeneralObjective(input: {
  criticalRoots: string[];
  caseContext: Record<string, unknown> | null;
}) {
  const area =
    typeof input.caseContext?.area === "string" && input.caseContext.area.trim()
      ? input.caseContext.area.trim()
      : typeof input.caseContext?.process === "string" && input.caseContext.process.trim()
      ? input.caseContext.process.trim()
      : "el proceso analizado";

  const roots = uniqueStrings(input.criticalRoots).slice(0, 2);

  if (roots.length >= 2) {
    return `Mejorar ${area} mediante la intervención de las causas prioritarias más viables de abordar, especialmente ${roots[0].toLowerCase()} y ${roots[1].toLowerCase()}, para reducir las fallas que afectan el desempeño del proceso.`;
  }

  if (roots.length === 1) {
    return `Mejorar ${area} mediante la intervención de la causa prioritaria ${roots[0].toLowerCase()}, para reducir las fallas que afectan el desempeño del proceso.`;
  }

  return `Mejorar ${area} mediante acciones enfocadas en la causa prioritaria más viable de intervenir, para reducir las fallas que afectan el desempeño del proceso.`;
}


function resolveNextObjectivesState(input: {
  currentState: ObjectivesState;
  llmState: ObjectivesState;
  officialCriticalRoots: string[];
  caseContext: Record<string, unknown> | null;
  studentMessage: string;
}): ObjectivesState {
  const current = input.currentState;
  const llm = input.llmState;
  const officialRoots = uniqueStrings(input.officialCriticalRoots);

  const studentProvidedSpecifics = looksLikeSpecificObjectivesDelivery(input.studentMessage)
    ? parseSpecificObjectivesFromStudentMessage(input.studentMessage)
    : [];

  const studentProvidedGeneralDraft = looksLikeGeneralObjectiveDraftDelivery(
    input.studentMessage
  );

  let generalObjective = (
    String(llm.generalObjective ?? "").trim() ||
    String(current.generalObjective ?? "").trim()
  );

  const studentMsg = String(input.studentMessage ?? "").trim();
  const isVeryShort = studentMsg.length <= 25;

  if (!generalObjective && isVeryShort) {
    generalObjective = buildSuggestedGeneralObjective({
      criticalRoots: officialRoots,
      caseContext: input.caseContext,
    });
  }

  let cleanedSpecifics = sanitizeSpecificObjectives([
    ...asStringArray(current.specificObjectives),
    ...studentProvidedSpecifics,
  ]);

  if (studentProvidedSpecifics.length >= 1) {
    cleanedSpecifics = sanitizeSpecificObjectives([
      ...cleanedSpecifics,
      ...asStringArray(llm.specificObjectives),
    ]);
  }

  const candidateLinkedRoots = keepOnlyOfficialCriticalRoots(
    [
      ...asStringArray(current.linkedCriticalRoots),
      ...asStringArray(llm.linkedCriticalRoots),
    ],
    officialRoots
  );

  const inferredLinkedRoots = inferLinkedCriticalRootsFromText({
    sources: [
      input.studentMessage,
      generalObjective,
      ...studentProvidedSpecifics,
    ],
    officialRoots,
  });

  const linkedCriticalRoots = uniqueStrings([
    ...candidateLinkedRoots,
    ...inferredLinkedRoots,
  ]).slice(0, 2);

  const generalConfirmed =
    current.step === "specific" ||
    current.step === "review" ||
    looksLikeGeneralObjectiveConfirmation(input.studentMessage) ||
    studentProvidedGeneralDraft;

  let step: ObjectivesState["step"] = current.step;

  if (generalObjective.trim().length < 15) {
    step = "general";
  } else if (linkedCriticalRoots.length < 1) {
    step = "general";
  } else if (!generalConfirmed && cleanedSpecifics.length === 0) {
    step = "general";
  } else if (cleanedSpecifics.length < 3) {
    step = "specific";
  } else {
    step = "review";
  }

  return {
    generalObjective,
    specificObjectives: cleanedSpecifics,
    linkedCriticalRoots,
    step,
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
          detail: profileError,
        },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });


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
- Sabes que estás hablando con un estudiante real, no uses placeholders.
- Si decides usar su nombre, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No lo menciones en todos los mensajes; úsalo solo de forma ocasional y natural.
- Nunca uses placeholders como [Nombre del estudiante], [nombre], [student name] ni variantes similares.

FORMATO DEL MENSAJE:
- Escribe en párrafos cortos y claros.
- Separa ideas distintas con una línea en blanco.
- Evita bloques largos de texto continuo.
- Usa viñetas o numeración solo cuando realmente ayuden a ordenar pasos, semanas, ajustes, criterios, causas o elementos pendientes.
- No conviertas todo en lista; si basta con 1 o 2 párrafos, responde así.
- Si haces una pregunta final, colócala en un párrafo aparte.
- Puedes usar un emoji discreto solo cuando aporte cercanía o claridad, no en todos los mensajes.
- El mensaje debe verse bien en chat: legible, espaciado y fácil de seguir.

OBJETIVO DE LA ETAPA:
- Formular 1 objetivo general.
- Formular mínimo 3 objetivos específicos.
- Asegurar trazabilidad con las causas críticas del Pareto.
- Mantener redacción clara, defendible y evaluable.
- No asumir que el objetivo general debe atacar todas las causas críticas del top 20%.
- Ayuda a elegir la causa o combinación de causas más viable y ejecutable según el caso.
- Elegir un alcance viable: el objetivo general puede atacar 1 o 2 causas críticas prioritarias, no necesariamente todas.

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
  - si el estudiante no sabe cómo empezar, propón una redacción base personalizada según su caso y según las causas críticas oficiales.
  - evita objetivos vagos como "mejorar la productividad" si no se indica qué problema concreto se atacará.
  - no asumas que debe atacar todas las causas críticas.
  - ayuda a elegir 1 o 2 causas críticas que sí sean viables de intervenir en el tiempo y alcance del proyecto.
  - cuando propongas el objetivo general, explica brevemente por qué conviene enfocarlo en esa causa o en esa combinación de causas.
  - si tú propones un borrador de objetivo general, no lo trates como aprobado automáticamente.
  - pide confirmación o ajuste antes de pasar a los objetivos específicos.
- Si step = "specific":
  - ayúdalo a construir 3 o más objetivos específicos.
  - puedes sugerirlos, pero no asumas automáticamente que ya quedaron aprobados por el estudiante.
  - evita objetivos que sean actividades sueltas.
  - cada objetivo específico debe apuntar a un resultado o mejora concreta.
  - mantén relación con las causas críticas oficiales del Pareto.
  - si el estudiante solo pidió ayuda, propón borradores en assistantMessage y deja que luego los confirme o ajuste.
- Si step = "review":
  - mejora claridad, coherencia y vínculo con causas críticas.
  - detecta si algún objetivo específico sigue sonando genérico o poco evaluable.
- Si el estudiante escribe algo muy corto como "ok como comenzamos?" o "ayúdame":
  - no lo bloquees
  - explícale brevemente qué van a construir
  - propón una primera versión tentativa útil
  - luego pídele que confirme o ajuste esa propuesta

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
- nextState.linkedCriticalRoots debe incluir solo las causas críticas oficiales realmente vinculadas al objetivo planteado.
- No cargues todas las causas críticas por defecto.
- Prioriza 1 causa crítica, o máximo 2, cuando eso haga el objetivo más viable y ejecutable.
- Si el objetivo general todavía es solo una propuesta del assistant y no una confirmación del estudiante, conserva step = "general".
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

    const resolvedNextState = resolveNextObjectivesState({
      currentState: objectivesState,
      llmState: nextStateParse.data,
      officialCriticalRoots: criticalRoots,
      caseContext,
      studentMessage,
    });

    const responseData: {
      assistantMessage: string;
      updates: {
        nextState: ObjectivesState;
        action: string;
      };
    } = {
      assistantMessage: sanitizeStudentPlaceholder(
        String(json.assistantMessage).trim(),
        preferredFirstName
      ),
      updates: {
        nextState: resolvedNextState,
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