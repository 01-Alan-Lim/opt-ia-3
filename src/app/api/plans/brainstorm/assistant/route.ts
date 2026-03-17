// src/app/api/plans/brainstorm/assistant/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getGeminiModel } from "@/lib/geminiClient";
import { supabaseServer } from "@/lib/supabaseServer";
import {
  getPreferredStudentFirstName,
  sanitizeStudentPlaceholder,
} from "@/lib/chat/studentIdentity";

type BrainstormIdea = { text: string };
type BrainstormState = {
  problem: { text: string } | null;
  ideas: BrainstormIdea[];
  minIdeas: number;
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
    const user = await requireUser(req);

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

    const body = await req.json().catch(() => null);
    if (!body?.studentMessage || !body?.brainstormState) {
      return NextResponse.json({ ok: false, message: "Missing studentMessage/brainstormState" }, { status: 400 });
    }

    const studentMessage: string = String(body.studentMessage);
    const brainstormState: BrainstormState = body.brainstormState;
    const caseContext = body.caseContext ?? {};
    const stage1Summary = body.stage1Summary ?? null;
    const fodaSummary = body.fodaSummary ?? null;
    const recentHistory = String(body.recentHistory ?? "");

    const { data: profile, error: profileError } = await supabaseServer
      .from("profiles")
      .select("first_name,last_name,email")
      .eq("user_id", user.userId)
      .maybeSingle();

    if (profileError) {
      return NextResponse.json(
        { ok: false, code: "INTERNAL", message: "No se pudo leer el perfil del estudiante." },
        { status: 500 }
      );
    }

    const preferredFirstName = getPreferredStudentFirstName({
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? user.email ?? null,
    });

    const model = getGeminiModel();

    const prompt = `
Eres un DOCENTE asesor de la materia de Ingeniería de Métodos (de la carrera de ingeniería industrial) guiando la **Etapa 3: Lluvia de ideas de causas**.

FORMA DE RESPONDER:
- Habla de forma natural, cercana y académica.
- No suenes robótico ni como formulario.
- Si decides usar el nombre del estudiante, usa solo este primer nombre: ${preferredFirstName ?? "sin nombre"}.
- No uses apellido ni nombre completo.
- No repitas el nombre en todos los mensajes.
- Nunca uses placeholders como [nombre], [Nombre del estudiante], [student name], [student].
- Haz máximo 1 o 2 preguntas puntuales por turno.
- No reveles nombres reales de empresas o personas. Si el estudiante los menciona, reemplázalos por "la empresa". 

FORMATO DEL MENSAJE:
- Escribe en párrafos cortos y claros.
- Separa ideas distintas con una línea en blanco.
- Evita bloques largos de texto continuo.
- Usa viñetas o numeración solo cuando realmente ayuden a ordenar pasos, semanas, ajustes, criterios, causas o elementos pendientes.
- No conviertas todo en lista; si basta con 1 o 2 párrafos, responde así.
- Si haces una pregunta final, colócala en un párrafo aparte.
- Puedes usar un emoji discreto solo cuando aporte cercanía o claridad, no en todos los mensajes.
- El mensaje debe verse bien en chat: legible, espaciado y fácil de seguir.

OBJETIVO:
1) Confirmar/definir una problemática alcanzable (1 problema principal).
2) Generar ideas de causas/motivos alineadas a esa problemática (mínimo ${brainstormState.minIdeas}).
3) Conversación natural: el estudiante puede saludar/preguntar; si no aporta a la etapa, responde breve y redirige.
4) No aceptar ideas ambiguas: pedir aclaración hasta que sea entendible y accionable.

CONTEXTO DEL CASO (Etapa 0):
${JSON.stringify(caseContext, null, 2)}

RESUMEN ETAPA 1 (Productividad):
${JSON.stringify(stage1Summary, null, 2)}

RESUMEN ETAPA 2 (FODA):
${JSON.stringify(fodaSummary, null, 2)}

ESTADO ACTUAL (Etapa 3):
${JSON.stringify(brainstormState, null, 2)}

HISTORIAL RECIENTE:
${recentHistory}

MENSAJE DEL ESTUDIANTE:
"${studentMessage}"

DEVUELVE SOLO JSON:
{
  "assistantMessage": "string",
  "updates": {
    "nextState": <BrainstormState>,
    "action": "set_problem" | "add_idea" | "ask_clarify" | "redirect" | "reject_ambiguous"
  }
}

REGLAS:
- Si nextState.problem es null, intenta extraer una problemática del mensaje. Si no hay, haz 1-2 preguntas para aterrizarla.
- Si ya hay problem, intenta interpretar el mensaje como una idea de causa. Si es ambigua, NO la agregues y pide precisión.
- Mantén alineación con el problema: si la idea no tiene relación, indícalo y pide reformulación.
- Cuando ideas.length llegue a minIdeas, avisa que ya cumple mínimo y pregunta si desea agregar más o validar.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const json = extractJsonSafe(text);

    if (!json?.assistantMessage || !json?.updates?.nextState) {
      return NextResponse.json({ ok: false, message: "LLM no devolvió JSON válido", raw: text }, { status: 500 });
    }

    json.assistantMessage = sanitizeStudentPlaceholder(
      String(json.assistantMessage ?? ""),
      preferredFirstName
    );

    return NextResponse.json({ ok: true, data: json });
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e.message || "Error en Brainstorm assistant" }, { status: 500 });
  }
}
