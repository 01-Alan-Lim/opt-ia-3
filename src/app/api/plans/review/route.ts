// src/app/api/plans/review/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { supabaseServer } from "@/lib/supabaseServer";
import { requireUser } from "@/lib/auth/supabase";
import { ok, fail } from "@/lib/api/response";
import { getGeminiModel } from "@/lib/geminiClient";
import { assertChatAccess } from "@/lib/auth/chatAccess";

export const runtime = "nodejs";

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
function buildFeedbackTextForHistory(sections: ReviewSection[], versionNumber: number): string {
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
 */
function extractJsonFromText(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

// ✅ Validación payload (técnico)
const ReviewBodySchema = z.object({
  text: z.string().trim().min(1, "Se requiere el texto del plan en el campo 'text'."),
  chatId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  title: z.string().min(1).max(120).optional(),
  fileName: z.string().min(1).max(200).optional(),
});

async function assertChatOwnership(chatId: string, userId: string) {
  const { data, error } = await supabaseServer
    .from("chats")
    .select("id, client_id, mode")
    .eq("id", chatId)
    .single();

  if (error || !data) throw new Error("CHAT_NOT_FOUND");
  if (data.client_id !== userId) throw new Error("FORBIDDEN_CHAT");

  return data;
}

async function assertPlanOwnership(planId: string, userId: string) {
  const { data, error } = await supabaseServer
    .from("improvement_plans")
    .select("id, user_id, current_version, chat_id")
    .eq("id", planId)
    .single();

  if (error || !data) throw new Error("PLAN_NOT_FOUND");
  if (data.user_id !== userId) throw new Error("FORBIDDEN_PLAN");

  return data;
}

/**
 * POST /api/plans/review
 *
 * Body esperado (ya NO incluye userId/email):
 * {
 *   text: string;
 *   chatId?: string;
 *   planId?: string;
 *   title?: string;
 *   fileName?: string;
 * }
 */
export async function POST(request: Request) {
  try {
    // ✅ 1) Auth server-side (user real desde token)
    const authed = await requireUser(request);

    // ✅ Gate server-side (misma fuente de verdad que /api/chat)
    const gate = await assertChatAccess(request);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    // ✅ Etapa 0 obligatoria: Contexto del Caso confirmado
    const { data: ctx, error: ctxErr } = await supabaseServer
      .from("plan_case_contexts")
      .select("status")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (ctxErr) {
      return NextResponse.json(fail("INTERNAL", "No se pudo validar el contexto del caso.", ctxErr), {
        status: 500,
      });
    }

    if (!ctx || ctx.status !== "confirmed") {
      return NextResponse.json(
        fail(
          "FORBIDDEN",
          "Antes de continuar debes completar y confirmar la Etapa 0 (Contexto del Caso)."
        ),
        { status: 403 }
      );
    }


    
    // ✅ 2) Parse JSON seguro
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(fail("BAD_REQUEST", "Body JSON inválido."), { status: 400 });
    }

    const parsed = ReviewBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const text = parsed.data.text;
    const incomingChatId = parsed.data.chatId;
    const incomingPlanId = parsed.data.planId;
    const title = parsed.data.title;
    const fileName = parsed.data.fileName;

    // ✅ 3) Crear o reutilizar chat para este plan (ownership)
    let chatId: string | null = incomingChatId ?? null;

    if (chatId) {
      // Si viene chatId, debe ser del usuario
      await assertChatOwnership(chatId, authed.userId);
    } else {
      // Crear chat nuevo (modo plan_mejora)
      try {
        const { data, error } = await supabaseServer
          .from("chats")
          .insert({
            client_id: authed.userId,
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

    // -------------------------------------------------
    // 4) Crear o actualizar improvement_plans (con ownership)
    // -------------------------------------------------
    let planId: string | null = incomingPlanId ?? null;
    let versionNumber = 1;

    try {
      if (!planId) {
        // 👉 Crear un nuevo plan
        const { data, error } = await supabaseServer
          .from("improvement_plans")
          .insert({
            user_id: authed.userId, // ✅ real
            email: authed.email ?? null, // ✅ real (si existe)
            chat_id: chatId,
            title: title ?? fileName ?? "Plan de mejora",
            full_text: text,
          })
          .select("id, current_version")
          .single();

        if (error || !data) {
          console.error("Error creando improvement_plan:", error);
          return NextResponse.json(fail("INTERNAL", "No se pudo crear el plan de mejora."), {
            status: 500,
          });
        }

        planId = data.id;
        versionNumber = data.current_version ?? 1;
      } else {
        // 👉 Plan existente: validar ownership y aumentar versión
        const existing = await assertPlanOwnership(planId, authed.userId);

        versionNumber = (existing.current_version ?? 1) + 1;

        const { error: updateError } = await supabaseServer
          .from("improvement_plans")
          .update({
            full_text: text,
            current_version: versionNumber,
            updated_at: new Date().toISOString(),
          })
          .eq("id", planId);

        if (updateError) {
          console.error("Error actualizando improvement_plan:", updateError);
          return NextResponse.json(fail("INTERNAL", "No se pudo actualizar el plan de mejora."), {
            status: 500,
          });
        }

        // Si el plan tenía chat_id y viene otro chatId, no lo cambiamos aquí
        // (evita inconsistencias). Mantenerlo simple por ahora.
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "INTERNAL";
      if (msg === "PLAN_NOT_FOUND") {
        return NextResponse.json(fail("NOT_FOUND", "No se encontró el plan de mejora especificado."), {
          status: 404,
        });
      }
      if (msg === "FORBIDDEN_PLAN") {
        return NextResponse.json(fail("FORBIDDEN", "No tienes acceso a este plan de mejora."), {
          status: 403,
        });
      }

      console.error("Error general al guardar plan:", e);
      return NextResponse.json(fail("INTERNAL", "Ocurrió un error al guardar el plan de mejora."), {
        status: 500,
      });
    }

    // -------------------------------------------------
    // 5) Pedir a Gemini feedback ESTRUCTURADO por secciones
    // (PROMPT INTACTO)
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

      const parsedJson = JSON.parse(jsonStr);

      if (parsedJson && Array.isArray(parsedJson.sections)) {
        sections = parsedJson.sections.map((s: any) => ({
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
    // 6) Guardar feedback en plan_reviews
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
        const { error: insertError } = await supabaseServer.from("plan_reviews").insert(rowsToInsert);

        if (insertError) {
          console.error("Error guardando plan_reviews:", insertError);
        }
      }
    } catch (e) {
      console.error("Error general al guardar feedback en plan_reviews:", e);
    }

    // -------------------------------------------------
    // 7) Guardar también en historial de mensajes (tabla messages)
    // -------------------------------------------------
    if (chatId) {
      try {
        // Seguridad extra: verificar ownership del chat antes de insertar
        await assertChatOwnership(chatId, authed.userId);

        const feedbackText = buildFeedbackTextForHistory(sections, versionNumber);

        await supabaseServer.from("messages").insert([
          {
            chat_id: chatId,
            role: "user",
            content: `📎 Se subió el archivo "${fileName ?? title ?? "plan.pdf"}" para revisión.`,
          },
          {
            chat_id: chatId,
            role: "assistant",
            content: feedbackText,
          },
        ]);
      } catch (e) {
        console.error("Error guardando mensajes de historial para plan_mejora:", e);
      }
    }

    // -------------------------------------------------
    // 8) Respuesta al frontend (consistente)
    // -------------------------------------------------
    return NextResponse.json(
      ok({
        planId,
        version: versionNumber,
        sections,
        chatId,
      }),
      { status: 200 }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido a correos autorizados."), {
        status: 403,
      });
    }
    if (msg === "CHAT_NOT_FOUND") {
      return NextResponse.json(fail("NOT_FOUND", "Chat no encontrado."), { status: 404 });
    }
    if (msg === "FORBIDDEN_CHAT") {
      return NextResponse.json(fail("FORBIDDEN", "No tienes acceso a este chat."), { status: 403 });
    }

    console.error("Error en /api/plans/review:", e);
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
