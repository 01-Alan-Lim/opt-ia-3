import assert from "node:assert/strict";

import { prepareRouteTestEnv } from "./assistantRouteHarness";
import { installRestStub, nextTimestamp, type RestStubState } from "./restStubHarness";
import {
  ACADEMIC_STYLE_GUIDE,
  ASSISTANT_RESPONSE_GUIDE,
  FORMULA_GUIDE,
  RESPONSE_FORMAT_GUIDE,
  RESPONSE_LENGTH_GUIDE,
} from "../chat/responseStyle";

// Pautas de respuesta del Asistente General (src/lib/chat/responseStyle.ts) y su uso en la ruta
// real /api/chat, con Supabase y Gemini simulados (sin red): las pautas llegan al prompt de la
// respuesta, no al del mini-agente SQL, y la respuesta se guarda y se devuelve tal cual.

function runGuide() {
  // Una sola guía, compuesta por sus secciones, y acotada: no es un prompt gigante.
  assert.equal(
    ASSISTANT_RESPONSE_GUIDE,
    [RESPONSE_LENGTH_GUIDE, RESPONSE_FORMAT_GUIDE, FORMULA_GUIDE, ACADEMIC_STYLE_GUIDE].join("\n\n")
  );
  assert.ok(ASSISTANT_RESPONSE_GUIDE.length < 3800, `${ASSISTANT_RESPONSE_GUIDE.length} caracteres`);
  assert.ok(ASSISTANT_RESPONSE_GUIDE.split("\n").length <= 30, "pocas líneas");

  // Extensión adaptativa, sin límite rígido.
  for (const rule of ["Pregunta puntual", "Explicación", "Procedimiento", "Comparación", "Cálculo", "Análisis"]) {
    assert.ok(RESPONSE_LENGTH_GUIDE.includes(rule), rule);
  }
  assert.ok(RESPONSE_LENGTH_GUIDE.includes("no hay un límite fijo de palabras"));
  assert.ok(/\*\*Datos\*\*, \*\*Fórmula\*\*, \*\*Procedimiento\*\* y \*\*Resultado\*\*/.test(RESPONSE_LENGTH_GUIDE));

  // Formato automático: sin saludos, relleno ni tablas innecesarias; ejemplos sin datos inventados.
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("el estudiante no necesita pedirlo"));
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("sin saludar ni presentarte"));
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("ni despedidas"));
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("nunca para un único elemento"));
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("no las presentes como datos reales"));
  assert.ok(RESPONSE_FORMAT_GUIDE.includes("Sin HTML ni imágenes"));

  // Fórmulas: LaTeX solo entre $$ y $$ (lo que pinta KaTeX) y solo cuando hacen falta; Excel
  // ejecutable y nunca en LaTeX; unidades y sentido del indicador.
  assert.ok(FORMULA_GUIDE.startsWith("Fórmulas y cálculos (solo cuando la pregunta pide un cálculo"));
  assert.ok(FORMULA_GUIDE.includes("en LaTeX entre $$ y $$"));
  assert.ok(FORMULA_GUIDE.includes("la productividad es $$P = \\frac{U}{HH}$$"), "ejemplo en línea, con LaTeX real");
  assert.ok(FORMULA_GUIDE.includes("Nunca un $ suelto"));
  assert.equal(
    ASSISTANT_RESPONSE_GUIDE.replace(/\$\$|\$us|un \$ suelto/g, "").includes("$"),
    false,
    "fuera de $$, la mención del $ suelto y $us, ningún $"
  );
  for (const command of ["\\frac{a}{b}", "x_{i}", "x^{2}", "\\sum_{i=1}^{n}", "\\text{...}", "\\%"]) {
    assert.ok(FORMULA_GUIDE.includes(command), command);
  }
  assert.ok(!/\\\(|\\\[/.test(ASSISTANT_RESPONSE_GUIDE), "sin \\( ni \\[: un solo estilo de delimitador");
  assert.ok(FORMULA_GUIDE.includes("Fórmula de Excel: nunca en LaTeX"));
  assert.ok(FORMULA_GUIDE.includes("Pasos de un cálculo: cada uno en su propia línea como fórmula destacada"));
  assert.ok(FORMULA_GUIDE.includes("Nunca una fórmula larga dentro de una oración"));
  assert.ok(FORMULA_GUIDE.includes('empiece con "="') && FORMULA_GUIDE.includes("=B2/C2"));
  assert.ok(FORMULA_GUIDE.includes("Indica qué contiene cada celda"));
  assert.ok(FORMULA_GUIDE.includes("punto y coma"));
  assert.ok(FORMULA_GUIDE.includes("mejora al subir") && FORMULA_GUIDE.includes("al bajar"));
  assert.ok(FORMULA_GUIDE.includes("unidades"));

  // Estilo y terminología del proyecto.
  assert.ok(ACADEMIC_STYLE_GUIDE.includes("Práctica Empresarial del estudiante (en singular)"));
  assert.ok(ACADEMIC_STYLE_GUIDE.includes("No supongas que el estudiante es empleado"));
  assert.ok(ACADEMIC_STYLE_GUIDE.includes("no infieras el género"));
}

const STUDENT = { id: "20000000-0000-4000-8000-000000000002", email: "ana@umsa.bo" };
const COHORT = "c0000000-0000-4000-8000-000000000001";
const PLANNER_REPLY = '{"useDb": false, "table": "method_engineering_experiences", "filters": [], "limit": 0, "reason": "conceptual"}';
const ANSWER = "La **productividad** relaciona lo producido con los recursos usados.\n\n| A | B |\n|---|---|\n| 1 | 2 |";

async function runRoute() {
  prepareRouteTestEnv({ ALLOWED_EMAIL_DOMAIN: "umsa.bo" });
  const route = await import("../../app/api/chat/route");

  const state: RestStubState = {
    user: STUDENT,
    tables: {
      profiles: [
        {
          user_id: STUDENT.id,
          role: "student",
          ru: "1234567",
          first_name: "Ana",
          last_name: "Prueba",
          semester: "8",
          cohort_id: COHORT,
          registration_status: "approved",
          access_starts_at: null,
          access_ends_at: null,
        },
      ],
      cohorts: [{ id: COHORT, is_active: true }],
      chats: [],
      messages: [],
    },
    defaults: {
      chats: () => ({ id: crypto.randomUUID(), created_at: nextTimestamp() }),
      messages: () => ({ id: crypto.randomUUID(), created_at: nextTimestamp() }),
    },
    // Sin material de la Biblioteca: el asistente responde con su conocimiento general.
    rpc: { academic_library_available: () => ({ data: false }) },
  };

  const prompts: string[] = [];
  const replies = [PLANNER_REPLY, ANSWER];
  const stub = installRestStub(state, async (req, url) => {
    if (url.host !== "generativelanguage.googleapis.com") return null;
    const body = (await req.json()) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    prompts.push((body.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.text ?? "").join(""));
    const text = replies.shift() ?? "";
    return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const res = await route.POST(
      new Request("https://opt-ia.test/api/chat", {
        method: "POST",
        headers: { authorization: "Bearer token-de-prueba", "content-type": "application/json" },
        body: JSON.stringify({ message: "¿Qué es la productividad?", chatId: null, mode: "general" }),
      })
    );
    const json = (await res.json()) as { ok: boolean; data?: { reply?: string; chatId?: string } };
    assert.equal(res.status, 200, JSON.stringify(json));

    // Dos llamadas a Gemini: el mini-agente SQL (su prompt sin cambios) y la respuesta.
    assert.equal(prompts.length, 2);
    const [planner, answer] = prompts;
    assert.ok(!planner.includes(RESPONSE_LENGTH_GUIDE), "el mini-agente SQL no recibe las pautas");
    assert.ok(planner.includes("Devuelve SIEMPRE un JSON"));

    // La respuesta recibe el rol, las reglas de contexto y privacidad de siempre y, después, las pautas.
    assert.ok(answer.includes("Eres OPT-IA, un asistente general"));
    const privacy = answer.indexOf("NO puedes revelar nombres reales de empresas");
    const guide = answer.indexOf(ASSISTANT_RESPONSE_GUIDE);
    assert.ok(privacy > 0, "reglas de privacidad");
    assert.ok(guide > privacy, "las pautas van después de las reglas existentes");
    assert.ok(answer.indexOf("Pregunta del usuario:\n¿Qué es la productividad?") > guide, "la pregunta al final");
    assert.equal(answer.split(RESPONSE_LENGTH_GUIDE).length - 1, 1, "las pautas, una sola vez");

    // Se guarda y se devuelve el texto de Gemini tal cual, sin reformatear.
    assert.equal(json.data?.reply, ANSWER);
    const saved = state.tables.messages.filter((m) => m.role === "assistant");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].content, ANSWER);
    assert.equal(state.tables.messages.find((m) => m.role === "user")?.content, "¿Qué es la productividad?");
  } finally {
    stub.restore();
  }
}

async function main() {
  runGuide();
  await runRoute();
  console.log("chatResponseStyle tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
