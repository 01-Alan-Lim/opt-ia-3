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

    function normalizeText(s: string) {
      return (s ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .trim();
    }

    function isOkConfirm(msg: string) {
      const t = normalizeText(msg);
      return ["ok", "okay", "dale", "listo", "de acuerdo", "si", "sí"].includes(t);
    }

    function hasThreeCriteria(state: any) {
      return Array.isArray(state?.criteria) && state.criteria.length === 3 && state.criteria.every((c: any) => String(c?.name ?? "").trim());
    }

    function hasWeights(state: any) {
      if (!Array.isArray(state?.criteria) || state.criteria.length !== 3) return false;
      return state.criteria.every((c: any) => {
        const w = Number(c?.weight);
        return Number.isFinite(w) && w >= 1 && w <= 10;
      });
    }

    function assistantResponse(assistantMessage: string, nextState: any, action: string) {
      return NextResponse.json({
        ok: true,
        data: {
          assistantMessage,
          updates: { nextState, action },
        },
      });
    }

    // ✅ Short-circuit determinístico para "OK"
    if (isOkConfirm(studentMessage)) {

        // ✅ Caso clave: OK cuando ya confirmó la lista de causas (selectedRoots)
        // En tu captura: el bot pide "responde OK" para pasar a definir pesos/criterios,
        // pero si el step sigue siendo "select_roots", sin esto cae a Gemini y puede fallar.
        if (paretoState.step === "select_roots") {
          const selected = Array.isArray(paretoState.selectedRoots)
            ? paretoState.selectedRoots.map((x) => String(x).trim()).filter(Boolean)
            : [];

          const minSelected = Number.isFinite(paretoState.minSelected) ? paretoState.minSelected : 10;
          const maxSelected = Number.isFinite(paretoState.maxSelected) ? paretoState.maxSelected : 15;

          // Si todavía no está en rango, NO avanzar: pedir ajuste (sin IA)
          if (selected.length < minSelected || selected.length > maxSelected) {
            return assistantResponse(
              `Aún no estamos en el rango. Selecciona entre **${minSelected} y ${maxSelected}** causas raíz.\n` +
                `Actualmente tienes **${selected.length}**.\n\n` +
                `👉 Responde con la lista final (puede ser en viñetas o separada por comas).`,
              { ...paretoState }, // no cambia step
              "ask_clarify"
            );
          }

          // Si está en rango, avanzar a definir criterios
          const nextState = { ...paretoState, step: "define_criteria" as const };
          return assistantResponse(
            "Perfecto ✅ La lista de causas está lista.\n\n" +
              "Ahora define **exactamente 3 criterios** para priorizar (ej: Impacto, Frecuencia, Costo).\n" +
              "Escríbelos así:\n" +
              "- Criterio 1: ...\n" +
              "- Criterio 2: ...\n" +
              "- Criterio 3: ...",
            nextState,
            "define_criteria"
          );
        }


      // Si el bot ya te mostró 3 criterios y espera confirmación → pasar a pesos
      if (paretoState.step === "define_criteria" && hasThreeCriteria(paretoState)) {
        const nextState = { ...paretoState, step: "set_weights" as const };
        return assistantResponse(
          "Perfecto ✅ Ahora asigna **pesos (1–10)** a cada criterio.\n\n" +
            "Escríbelos así:\n" +
            "- Criterio 1: 8\n" +
            "- Criterio 2: 6\n" +
            "- Criterio 3: 9",
          nextState,
          "set_weights"
        );
      }

      // Si ya hay pesos y el estudiante dice OK → instruir Excel
      if (paretoState.step === "set_weights" && hasWeights(paretoState)) {
        const nextState = { ...paretoState, step: "excel_work" as const };
        return assistantResponse(
          "Listo ✅ Ahora haz el **Pareto en Excel (80/20)** con tus causas.\n\n" +
            `👉 Cuando termines, vuelve y envíame la lista de **causas críticas (Top 20%)**.\n` +
            `Ejemplo: "Causas críticas: A, B, C".`,
          nextState,
          "instruct_excel"
        );
      }

      // Si está en excel_work y dice OK → pedir críticas (sin fallar)
      if (paretoState.step === "excel_work") {
        const nextState = { ...paretoState, step: "collect_critical" as const };
        return assistantResponse(
          "Genial. Ahora envíame tu lista de **causas críticas (Top 20%)** según tu Excel.\n" +
            "Escríbelas en viñetas o separadas por comas.",
          nextState,
          "collect_critical"
        );
      }
    }


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
