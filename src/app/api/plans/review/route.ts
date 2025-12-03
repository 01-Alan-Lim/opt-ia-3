// src/app/api/plans/review/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";
import { getGeminiModel } from "@/lib/geminiClient";

/**
 * Tipo para cada bloque de feedback que guardaremos en plan_reviews
 */
type ReviewSection = {
  section: string;
  feedback: string;
  score?: number | null;
};

/**
 * Construye el texto plano que se guardará en la tabla messages
 * a partir de las secciones evaluadas.
 */
function buildFeedbackTextForHistory(
  sections: ReviewSection[],
  versionNumber: number
): string {
  let feedbackText = `Aquí tienes la revisión del plan (versión ${versionNumber}):\n\n`;

  for (const section of sections) {
    if (!section.feedback || !section.feedback.trim()) continue;

    feedbackText += `🟦 *${String(section.section).toUpperCase()}*\n`;
    feedbackText += `${section.feedback}\n\n`;
  }

  return feedbackText;
}


/**
 * Extrae el primer JSON válido que encuentre dentro de un texto.
 * (igual que en el mini-agente SQL de /api/chat)
 */
function extractJsonFromText(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

/**
 * POST /api/plans/review
 *
 * Body esperado:
 * {
 *   text: string;       // texto completo del plan o avance
 *   userId: string;     // DID de Privy
 *   email?: string;
 *   chatId?: string;
 *   planId?: string;    // opcional: si ya existe un plan
 *   title?: string;     // opcional: título del plan
 * }
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { error: "Se requiere el texto del plan en el campo 'text'." },
      { status: 400 }
    );
  }

  const text: string = body.text;
  const userId: string | undefined = body.userId;
  const email: string | undefined = body.email;
  const incomingChatId: string | undefined = body.chatId;
  const incomingPlanId: string | undefined = body.planId;
  const title: string | undefined = body.title;
  const fileName: string | undefined = body.fileName; 

// Usaremos este clientId igual que en /api/chat
  const clientId: string = userId ?? "anon";

 // Crear o reutilizar chat para este plan
  let chatId = incomingChatId ?? null;

  if (!chatId) {
    try {
      const { data, error } = await supabase
        .from("chats")
        .insert({
          client_id: clientId,
          title: (title ?? text).slice(0, 60),
          mode: "plan_mejora",
        })
        .select("id")
        .single();

      if (!error && data?.id) {
        chatId = data.id as string;
      } else if (error) {
        console.error("Error creando chat para plan_mejora:", error);
      }
    } catch (e) {
      console.error("Error inesperado creando chat para plan_mejora:", e);
    }
  }


  if (!userId) {
    return NextResponse.json(
      { error: "Falta 'userId' para asociar el plan al estudiante." },
      { status: 400 }
    );
  }

  // -------------------------------------------------
  // 1) Crear o actualizar el registro en improvement_plans
  // -------------------------------------------------
  let planId = incomingPlanId ?? null;
  let versionNumber = 1;

  try {
    if (!planId) {
      // 👉 Crear un nuevo plan
      const { data, error } = await supabase
        .from("improvement_plans")
        .insert({
          user_id: userId,
          email: email ?? null,
          chat_id: chatId,
          title: title ?? fileName ?? "Plan de mejora",
          full_text: text,
          // de momento no llenamos las secciones específicas;
          // eso se puede hacer en una fase posterior de parseo.
        })
        .select("id, current_version")
        .single();

      if (error || !data) {
        console.error("Error creando improvement_plan:", error);
        return NextResponse.json(
          { error: "No se pudo crear el plan de mejora." },
          { status: 500 }
        );
      }

      planId = data.id;
      versionNumber = data.current_version ?? 1;
    } else {
      // 👉 Actualizar un plan existente: incrementar versión
      const { data: existing, error: fetchError } = await supabase
        .from("improvement_plans")
        .select("id, current_version")
        .eq("id", planId)
        .single();

      if (fetchError || !existing) {
        console.error("Error obteniendo improvement_plan:", fetchError);
        return NextResponse.json(
          { error: "No se encontró el plan de mejora especificado." },
          { status: 404 }
        );
      }

      versionNumber = (existing.current_version ?? 1) + 1;

      const { error: updateError } = await supabase
        .from("improvement_plans")
        .update({
          full_text: text,
          current_version: versionNumber,
          updated_at: new Date().toISOString(),
        })
        .eq("id", planId);

      if (updateError) {
        console.error("Error actualizando improvement_plan:", updateError);
        return NextResponse.json(
          { error: "No se pudo actualizar el plan de mejora." },
          { status: 500 }
        );
      }
    }
  } catch (e) {
    console.error("Error general al guardar plan:", e);
    return NextResponse.json(
      { error: "Ocurrió un error al guardar el plan de mejora." },
      { status: 500 }
    );
  }

  // -------------------------------------------------
  // 2) Pedir a Gemini feedback ESTRUCTURADO por secciones
  // -------------------------------------------------
  let sections: ReviewSection[] = [];

  try {
    const model = getGeminiModel();

    const prompt = `
Eres un docente experto de Ingeniería Industrial de la Plataforma Aceleradora de Productividad.
Vas a revisar un PLAN DE MEJORA elaborado con la plantilla PAP-PM-01 (métodos de trabajo).

Evalúa el texto del estudiante y genera retroalimentación de CALIDAD por secciones,
considerando: claridad del problema, coherencia entre causas, objetivos, resultados esperados,
propuesta de mejora, análisis beneficio/costo y plan de implementación.

Debes devolver EXCLUSIVAMENTE un JSON válido con este formato:

{
  "sections": [
    {
      "section": "resumen_ejecutivo",
      "feedback": "texto en español con observaciones y sugerencias concretas",
      "score": 0-100
    },
    {
      "section": "introduccion",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "antecedentes_empresa",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "descripcion_sistema_productivo",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "diagnostico",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "objetivos",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "propuesta_mejora",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "conclusiones_recomendaciones",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "bibliografia",
      "feedback": "...",
      "score": 0-100
    },
    {
      "section": "general",
      "feedback": "síntesis global del plan, principales fortalezas y debilidades",
      "score": 0-100
    }
  ]
}

Reglas importantes:
- Incluye SIEMPRE las 10 secciones indicadas arriba, aunque el texto esté incompleto.
- Si no encuentras contenido claro de una sección, indica que está ausente o muy débil.
- "score" es una nota global de 0 a 100 para esa sección (puedes dejar null si no es posible).
- NO añadas comentarios fuera del JSON.
- NO expliques el formato, solo devuelve el JSON.

Texto del plan del estudiante:

"""${text}"""
`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const raw = result.response.text();
    const jsonStr = extractJsonFromText(raw) ?? raw;

    const parsed = JSON.parse(jsonStr);

    if (
      parsed &&
      Array.isArray(parsed.sections)
    ) {
      sections = parsed.sections.map((s: any) => ({
        section: String(s.section ?? "general"),
        feedback: String(s.feedback ?? ""),
        score:
          typeof s.score === "number"
            ? s.score
            : s.score === null || s.score === undefined
            ? null
            : Number.isNaN(Number(s.score))
            ? null
            : Number(s.score),
      }));
    } else {
      throw new Error("El JSON no contiene un arreglo 'sections'.");
    }
  } catch (e) {
    console.error("Error generando o parseando feedback de Gemini:", e);

    // Fallback: si falla el JSON, generamos una sola sección "general"
    sections = [
      {
        section: "general",
        feedback:
          "No se pudo generar feedback estructurado automáticamente. Revisa la coherencia del problema, diagnóstico, objetivos, propuesta de mejora y conclusiones.",
        score: null,
      },
    ];
  }

  // -------------------------------------------------
  // 3) Guardar feedback en plan_reviews
  // -------------------------------------------------
  try {
    const rowsToInsert = sections
      .filter((s) => s.feedback && s.feedback.trim().length > 0)
      .map((s) => ({
        plan_id: planId,
        version_number: versionNumber,
        reviewer_type: "ai",
        reviewer_id: null,
        section: s.section,
        feedback: s.feedback,
        score: s.score ?? null,
      }));

    if (rowsToInsert.length) {
      const { error: insertError } = await supabase
        .from("plan_reviews")
        .insert(rowsToInsert);

      if (insertError) {
        console.error("Error guardando plan_reviews:", insertError);
      }
    }
  } catch (e) {
    console.error("Error general al guardar feedback en plan_reviews:", e);
  }


  // -------------------------------------------------
  // 3b) Guardar también en historial de mensajes (tabla messages)
  // -------------------------------------------------
  if (chatId) {
    try {
      const feedbackText = buildFeedbackTextForHistory(sections, versionNumber);

      await supabase.from("messages").insert([
        {
          chat_id: chatId,
          role: "user",
          content: `📎 Se subió el archivo "${
            fileName ?? title ?? "plan.pdf"}" para revisión.`,
        },
        {
          chat_id: chatId,
          role: "assistant",
          content: feedbackText,
        },
      ]);
    } catch (e) {
      console.error(
        "Error guardando mensajes de historial para plan_mejora:",
        e
      );
    }
  }

  // -------------------------------------------------
  // 4) Respuesta al frontend
  // -------------------------------------------------
  return NextResponse.json({
    ok: true,
    planId,
    version: versionNumber,
    sections,
    chatId, 
  });
}
