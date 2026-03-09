// src/app/api/plans/pareto/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

const PARETO_STEP_VALUES = [
  "select_roots",
  "define_criteria",
  "set_weights",
  "excel_work",
  "collect_critical",
  "done",
] as const;

type ParetoStep = (typeof PARETO_STEP_VALUES)[number];

const CriterionSchema = z.object({
  id: z.string(),
  name: z.string().trim(),
  weight: z.number().optional(),
});

const ParetoStateSchema = z.object({
  roots: z.array(z.string()),
  selectedRoots: z.array(z.string()),
  criteria: z.array(CriterionSchema),
  criticalRoots: z.array(z.string()),
  minSelected: z.number(),
  maxSelected: z.number(),
  step: z.enum(PARETO_STEP_VALUES),
});

const BodySchema = z.object({
  studentMessage: z.string().trim().min(1).max(4000),
  paretoState: z.unknown(),
  caseContext: z.record(z.string(), z.unknown()).nullable().optional(),
  recentHistory: z.string().max(12000).optional(),
});

type ParetoState = z.infer<typeof ParetoStateSchema>;

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

function normalizeText(input: string) {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function ceil20Percent(n: number) {
  return Math.max(1, Math.ceil(n * 0.2));
}

function isOkConfirm(msg: string) {
  const t = normalizeText(msg);
  return ["ok", "okay", "dale", "listo", "de acuerdo", "si", "sí"].includes(t);
}

function hasThreeCriteria(state: ParetoState) {
  return (
    Array.isArray(state.criteria) &&
    state.criteria.length === 3 &&
    state.criteria.every((c) => c.name.trim().length > 0)
  );
}

function hasWeights(state: ParetoState) {
  if (!Array.isArray(state.criteria) || state.criteria.length !== 3) return false;

  return state.criteria.every((c) => {
    const w = Number(c.weight);
    return Number.isFinite(w) && w >= 1 && w <= 10;
  });
}

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function normalizeWeight(input: unknown): number | undefined {
  const n = Number(input);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1 || n > 10) return undefined;
  return n;
}

function defaultCriterionName(index: number): string {
  if (index === 0) return "Impacto";
  if (index === 1) return "Frecuencia";
  return "Controlabilidad";
}

function normalizeCriteria(input: unknown) {
  const raw = Array.isArray(input) ? input : [];

  const cleaned = raw
    .map((item, index) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};

      const name = String(record.name ?? "").trim();
      const id = String(record.id ?? "").trim() || crypto.randomUUID();
      const weight = normalizeWeight(record.weight);

      return {
        id,
        name: name || defaultCriterionName(index),
        ...(weight !== undefined ? { weight } : {}),
      };
    })
    .filter((item) => item.name.length > 0)
    .slice(0, 3);

  while (cleaned.length < 3) {
    const index = cleaned.length;
    cleaned.push({
      id: crypto.randomUUID(),
      name: defaultCriterionName(index),
    });
  }

  return cleaned;
}

function normalizeStep(input: unknown): ParetoStep {
  const raw = String(input ?? "").trim();

  if ((PARETO_STEP_VALUES as readonly string[]).includes(raw)) {
    return raw as ParetoStep;
  }

  const legacyMap: Record<string, ParetoStep> = {
    init: "select_roots",
    start: "select_roots",
    roots: "select_roots",
    select: "select_roots",
    criteria: "define_criteria",
    define: "define_criteria",
    weights: "set_weights",
    weight: "set_weights",
    excel: "excel_work",
    critical: "collect_critical",
    critical_roots: "collect_critical",
    review: "collect_critical",
    finished: "done",
    final: "done",
  };

  return legacyMap[raw] ?? "select_roots";
}

function normalizePositiveInt(input: unknown, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : fallback;
}

function normalizeParetoState(input: unknown): ParetoState {
  const source =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const roots = dedupeStrings(asStringArray(source.roots));
  const minSelected = normalizePositiveInt(source.minSelected, 10);
  const maxSelectedRaw = normalizePositiveInt(source.maxSelected, 15);
  const maxSelected = Math.max(minSelected, maxSelectedRaw);

  const selectedRootsRaw = asStringArray(source.selectedRoots);
  const selectedRootsBase =
    selectedRootsRaw.length > 0 ? selectedRootsRaw : roots.slice(0, maxSelected);

  const rootsSet = new Set(roots.map((item) => normalizeText(item)));
  const selectedRoots = dedupeStrings(
    selectedRootsBase.filter((item) => rootsSet.size === 0 || rootsSet.has(normalizeText(item)))
  ).slice(0, maxSelected);

  const selectedSet = new Set(selectedRoots.map((item) => normalizeText(item)));
  const criticalRoots = dedupeStrings(asStringArray(source.criticalRoots)).filter((item) =>
    selectedSet.size === 0 ? true : selectedSet.has(normalizeText(item))
  );

  return {
    roots,
    selectedRoots,
    criteria: normalizeCriteria(source.criteria),
    criticalRoots,
    minSelected,
    maxSelected,
    step: normalizeStep(source.step),
  };
}

function parseCriticalRootsFromMessage(studentMessage: string): string[] {
  const raw = studentMessage
    .split(/\n|;/g)
    .flatMap((line) => line.split(","))
    .map((line) =>
      line
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/^causas?\s+criticas?\s*:?/i, "")
        .replace(/^top\s*20%?\s*:?/i, "")
        .trim()
    )
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function matchAgainstSelectedRoots(
  candidates: string[],
  selectedRoots: string[]
): { matched: string[]; invalid: string[] } {
  const byNormalized = new Map<string, string>();

  for (const root of selectedRoots) {
    byNormalized.set(normalizeText(root), root);
  }

  const matched: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const item of candidates) {
    const key = normalizeText(item);
    const official = byNormalized.get(key);

    if (!official) {
      invalid.push(item);
      continue;
    }

    if (seen.has(normalizeText(official))) continue;
    seen.add(normalizeText(official));
    matched.push(official);
  }

  return { matched, invalid };
}

function assistantResponse(
  assistantMessage: string,
  nextState: ParetoState,
  action:
    | "init"
    | "select_roots"
    | "define_criteria"
    | "set_weights"
    | "instruct_excel"
    | "collect_critical"
    | "ask_clarify"
    | "redirect"
    | "done"
) {
  return NextResponse.json({
    ok: true,
    data: {
      assistantMessage,
      updates: { nextState, action },
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(
        {
          ok: false,
          code: gate.reason,
          message: gate.message,
        },
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

    const paretoStateNormalized = normalizeParetoState(parsed.data.paretoState);
    const stateParsed = ParetoStateSchema.safeParse(paretoStateNormalized);

    if (!stateParsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "BAD_REQUEST",
          message: "Estado de Pareto inválido después de normalizar.",
          detail: stateParsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const {
      studentMessage,
      caseContext = null,
      recentHistory = "",
    } = parsed.data;

    const paretoState = stateParsed.data;

    const selectedRoots = paretoState.selectedRoots
      .map((x) => String(x).trim())
      .filter(Boolean);

    const minSelected = Number.isFinite(paretoState.minSelected)
      ? paretoState.minSelected
      : 10;

    const maxSelected = Number.isFinite(paretoState.maxSelected)
      ? paretoState.maxSelected
      : 15;

    if (isOkConfirm(studentMessage)) {
      if (paretoState.step === "select_roots") {
        if (selectedRoots.length < minSelected || selectedRoots.length > maxSelected) {
          return assistantResponse(
            `Aún no estamos en el rango. Selecciona entre **${minSelected} y ${maxSelected}** causas raíz.\n` +
              `Actualmente tienes **${selectedRoots.length}**.\n\n` +
              "👉 Responde con la lista final (puede ser en viñetas o separada por comas).",
            { ...paretoState },
            "ask_clarify"
          );
        }

        return assistantResponse(
          "Perfecto ✅ La lista de causas está lista.\n\n" +
            "Ahora define **exactamente 3 criterios** para priorizar (por ejemplo: Impacto, Frecuencia y Controlabilidad).\n" +
            "Escríbelos así:\n" +
            "- Criterio 1: ...\n" +
            "- Criterio 2: ...\n" +
            "- Criterio 3: ...",
          { ...paretoState, step: "define_criteria" },
          "define_criteria"
        );
      }

      if (paretoState.step === "define_criteria" && hasThreeCriteria(paretoState)) {
        return assistantResponse(
          "Perfecto ✅ Ahora asigna **pesos (1–10)** a cada criterio.\n\n" +
            "Escríbelos así:\n" +
            "- Criterio 1: 8\n" +
            "- Criterio 2: 6\n" +
            "- Criterio 3: 9",
          { ...paretoState, step: "set_weights" },
          "set_weights"
        );
      }

      if (paretoState.step === "set_weights" && hasWeights(paretoState)) {
        return assistantResponse(
          "Listo ✅ Ahora haz el **Pareto en Excel (80/20)** con tus causas.\n\n" +
            "👉 Cuando termines, vuelve y envíame la lista de **causas críticas (Top 20%)**.",
          { ...paretoState, step: "excel_work" },
          "instruct_excel"
        );
      }

      if (paretoState.step === "excel_work") {
        return assistantResponse(
          "Genial. Ahora envíame tu lista de **causas críticas (Top 20%)** según tu Excel.\n" +
            "Puedes escribirlas en viñetas o separadas por comas.",
          { ...paretoState, step: "collect_critical" },
          "collect_critical"
        );
      }
    }

    if (
      paretoState.step === "excel_work" ||
      paretoState.step === "collect_critical"
    ) {
      const parsedCritical = parseCriticalRootsFromMessage(studentMessage);
      const { matched, invalid } = matchAgainstSelectedRoots(
        parsedCritical,
        selectedRoots
      );

      if (parsedCritical.length > 0) {
        const minCritical = ceil20Percent(selectedRoots.length);

        if (invalid.length > 0) {
          return assistantResponse(
            "⚠️ Algunas causas que enviaste no coinciden exactamente con tu lista seleccionada de Pareto.\n\n" +
              "Revisa la redacción y vuelve a pegar solo las causas críticas que salieron en tu Excel.",
            {
              ...paretoState,
              criticalRoots: matched,
              step: "collect_critical",
            },
            "ask_clarify"
          );
        }

        if (matched.length < minCritical) {
          return assistantResponse(
            `Aún falta completar el **top 20%**. Para tu lista actual necesito al menos **${minCritical}** causa(s) crítica(s).\n\n` +
              "👉 Vuelve a pegar exactamente las causas críticas que salieron en tu Excel.",
            {
              ...paretoState,
              criticalRoots: matched,
              step: "collect_critical",
            },
            "ask_clarify"
          );
        }

        if (matched.length > Math.ceil(selectedRoots.length * 0.3)) {
          return assistantResponse(
            "Revisa nuevamente tu análisis de Pareto. Las causas críticas deberían aproximarse al 20% del total.",
            {
              ...paretoState,
              criticalRoots: matched,
              step: "collect_critical",
            },
            "ask_clarify"
          );
        }

        return assistantResponse(
          "Perfecto. Ya registré tus causas críticas del Pareto. Ahora voy a validarlas para cerrar la etapa y pasar a Objetivos.",
          {
            ...paretoState,
            criticalRoots: matched,
            step: "done",
          },
          "done"
        );
      }
    }

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos guiando la **Etapa 5: Diagrama de Pareto (MVP)**.

IMPORTANTE:
- Conversación natural, breve y académica.
- NO anuncies que la etapa terminó.
- NO digas "ya completaste la etapa" ni "pasamos a objetivos".
- En esta ruta solo guías; el cierre real ocurre en la validación posterior.
- Si el estudiante está en la parte final, solo pídele que pegue las causas críticas exactas del Excel.

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

ESTADO ACTUAL:
${JSON.stringify(paretoState, null, 2)}

HISTORIAL RECIENTE:
${recentHistory}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": <ParetoState>,
    "action": "init" | "select_roots" | "define_criteria" | "set_weights" | "instruct_excel" | "collect_critical" | "ask_clarify" | "redirect"
  }
}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json(
        { ok: false, code: "INVALID_LLM_JSON", message: "LLM no devolvió JSON válido", detail: text },
        { status: 500 }
      );
    }

    const nextStateNormalized = normalizeParetoState(json.updates.nextState);
    const nextStateParsed = ParetoStateSchema.safeParse(nextStateNormalized);

    if (!nextStateParsed.success) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_NEXT_STATE",
          message: "nextState inválido devuelto por el assistant.",
          detail: nextStateParsed.error.flatten(),
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        assistantMessage: String(json.assistantMessage),
        updates: {
          nextState: nextStateParsed.data,
          action: ["init","select_roots","define_criteria","set_weights","instruct_excel","collect_critical","ask_clarify","redirect","done"].includes(json?.updates?.action)
          ? json.updates.action
          : "redirect",
                },
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error en Pareto assistant";
    return NextResponse.json({ ok: false, code: "INTERNAL", message }, { status: 500 });
  }
}