//src/app/api/plans/foda/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";

type FodaQuadrant = "F" | "D" | "O" | "A";

type FodaState = {
  currentQuadrant: FodaQuadrant;
  items: {
    F: { text: string; evidence?: string }[];
    D: { text: string; evidence?: string }[];
    O: { text: string; evidence?: string }[];
    A: { text: string; evidence?: string }[];
  };
  pendingEvidence?: { quadrant: FodaQuadrant; index: number } | null;
};

function extractJsonSafe(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export async function POST(req: NextRequest) {
  try {
    await requireUser(req);
    await assertChatAccess(req);

    const body = await req.json().catch(() => null);
    if (!body?.studentMessage || !body?.fodaState) {
      return NextResponse.json(
        { ok: false, message: "Missing studentMessage/fodaState" },
        { status: 400 }
      );
    }

    const studentMessage: string = String(body.studentMessage);
    const fodaState: FodaState = body.fodaState;
    const caseContext = body.caseContext ?? {};
    const recentHistory = String(body.recentHistory ?? "");

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE de Ingeniería Industrial guiando un FODA técnico (Etapa 2).
Tu tarea NO es solo contar puntos. Debes:
- Evaluar si lo que dice el estudiante es válido para el cuadrante actual.
- Rechazar o pedir precisión si es ambiguo/genérico.
- Pedir datos cuantitativos o cualitativos cuando haga falta (pero no siempre).
- En OPORTUNIDADES y AMENAZAS (externo) exigir sustento: fuente/fecha/dato (no frases genéricas).
- Si el estudiante manda algo que corresponde a otro cuadrante, dilo y guíalo.

Estado actual:
${JSON.stringify(fodaState, null, 2)}

Contexto del caso:
${JSON.stringify(caseContext, null, 2)}

Historial reciente:
${recentHistory}

Mensaje del estudiante:
"${studentMessage}"

Devuelve SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": <FodaState>,
    "action": "add_item" | "ask_clarify" | "ask_evidence" | "add_evidence" | "reject_generic" | "advance_quadrant" | "complete"
  }
}

REGLAS:
- Si pendingEvidence existe, interpreta el mensaje como evidencia para ese item.
- Cada cuadrante requiere 3 items de calidad.
- Si un item está muy genérico: NO lo aceptes, pide reformulación con criterio técnico.
- Si cuadrante es O o A: siempre exigir evidencia (fuente/dato).

REGLAS EXTRA DE AVANCE:
- Orden de cuadrantes: F -> D -> O -> A.
- Si el cuadrante actual ya tiene 3 items y pendingEvidence es null, la acción DEBE ser "advance_quadrant" y nextState.currentQuadrant debe pasar al siguiente cuadrante.
- Si F, D, O y A ya tienen 3 items cada uno y pendingEvidence es null, la acción DEBE ser "complete" (no pedir más puntos).
- Si el estudiante pide "¿qué llevo?" o "resume", muestra el conteo por cuadrante y los ítems ya registrados.

`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json(
        { ok: false, message: "LLM no devolvió JSON válido", raw: text },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: json });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, message: e.message || "Error en FODA assistant" },
      { status: 500 }
    );
  }
}
