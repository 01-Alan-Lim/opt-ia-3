// src/app/api/plans/pareto/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

export const runtime = "nodejs";

type ParetoCriterion = { id: string; name: string; weight?: number };
type ParetoState = {
  roots: string[]; // viene de Etapa 4
  selectedRoots: string[]; // 10-15
  criteria: ParetoCriterion[]; // 3
  criticalRoots: string[]; // top 20% (devuelto por el estudiante luego del Excel)
  minSelected: number; // 10
  maxSelected: number; // 15
  step: "select_roots" | "define_criteria" | "set_weights" | "excel_work" | "collect_critical" | "done";
};

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
    await requireUser(req);
    await assertChatAccess(req);

    const body = await req.json().catch(() => null);
    if (!body?.studentMessage || !body?.paretoState) {
      return NextResponse.json({ ok: false, message: "Missing studentMessage/paretoState" }, { status: 400 });
    }

    const studentMessage: string = String(body.studentMessage);
    const paretoState: ParetoState = body.paretoState;
    const caseContext = body.caseContext ?? {};
    const recentHistory = String(body.recentHistory ?? "");

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de Ingeniería de Métodos guiando la **Etapa 5: Diagrama de Pareto (MVP)**.

IMPORTANTE (MVP real):
- El Excel se trabaja FUERA (lo entrega la materia).
- Aquí SOLO:
  1) Confirmar/depurar lista final de causas raíz (10 a 15).
  2) Definir 3 criterios y un peso por criterio (1 a 10).
  3) Indicar al estudiante que haga el Pareto en Excel (80/20) y luego vuelva con la lista de causas críticas (top 20%).
- Conversación natural, no robótica. Si el estudiante se desvía, redirige breve.

CONTEXTO DEL CASO:
${JSON.stringify(caseContext, null, 2)}

ESTADO ACTUAL (Etapa 5):
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

REGLAS:
- Si step es "select_roots": ayuda a dejar selectedRoots entre minSelected y maxSelected, sin duplicados.
- Si step es "define_criteria": termina con exactamente 3 criterios (name claros). Si ya están, pasa a "set_weights".
- Si step es "set_weights": pide 3 pesos (1-10) y valida coherencia (sin inventar datos).
- Si step es "excel_work": explica corto cómo usar el Excel (80/20) y pide que vuelva con las causas críticas.
- Si step es "collect_critical": pide lista de causas críticas (top 20%); si ya las dio, marca "done".
- NO muestres scores numéricos del sistema; enfócate en guía y claridad.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json({ ok: false, message: "LLM no devolvió JSON válido", raw: text }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data: json });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e.message || "Error en Pareto assistant" }, { status: 500 });
  }
}
