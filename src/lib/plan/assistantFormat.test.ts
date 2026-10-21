import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PersistMessageInput } from "../../app/chat/_lib/advisorApi";
import { appendAssistantMessage, type AppendAssistantDeps } from "../../app/chat/_lib/appendAssistantMessage";
import { MessageList } from "../../components/chat/MessageList";
import { advisorQuestion, advisorStageHeading } from "../chat/advisorVoice";
import { formatAdvisorReplyForChat, softenAssistantLeadInChat } from "../chat/assistantFormat";
import { signAssistantReceipt } from "../chat/assistantReceipt";
import { loadAssistantReceiptKey } from "../chat/assistantReceiptConfig";
import { decideMessageWrite, parsePersistMessageBody } from "../chat/messageWritePolicy";
import { readSignedAssistantReply } from "../chat/signedAssistantReply";
import type { Message } from "../types";
import { buildStage0Confirmed, buildStage0Opening, buildStage0Review, buildStage0ReviewOpening } from "./stage0Context";

// Formato de las respuestas del asesor E0-E10 (src/lib/chat/assistantFormat.ts), que se pinta y se
// guarda. Comprueba que:
//   - tablas, código, fórmulas, encabezados, citas, listas anidadas y números sueltos no cambian;
//   - siguen las conversiones útiles (lista en una línea, líneas en blanco, muletilla inicial);
//   - los textos fijos de E0-E10 quedan como hasta ahora y aplicarlo dos veces no cambia nada;
//   - lo que se ve en el navegador es lo que guarda /api/messages (recibo verificado);
//   - el formato no está en el camino de gates, estados, puntajes ni artefactos.

const f = formatAdvisorReplyForChat;

// El HTML del contenido de un mensaje, sin la lista ni la burbuja.
function render(content: string): string {
  return renderToStaticMarkup(
    createElement(MessageList, { messages: [{ id: "m1", role: "assistant", content, createdAt: "2026-10-21T10:00:00Z" }] })
  );
}
const count = (html: string, fragment: string) => html.split(fragment).length - 1;

const PARETO_TABLE =
  "| N.º | Causa raíz | Frecuencia | % | % acumulado |\n|:--|:--|--:|--:|--:|\n" +
  "| 1. | Falta de mantenimiento preventivo | 45 | 37,5 % | 37,5 % |\n" +
  "| 2. | Sin procedimiento estándar | 30 | 25,0 % | 62,5 % |\n" +
  "| 3. | Capacitación insuficiente | 20 | 16,7 % | 79,2 % |\n" +
  "| | **Total** | 120 | 100 % | |";

// Contenido estructurado: sale exactamente igual.
const UNCHANGED: Array<[string, string]> = [
  ["tabla Pareto", PARETO_TABLE],
  ["tabla con ítems en una celda", "| Categoría | Causas |\n|---|---|\n| Método | 1. Sin estándar 2. Sin registro |"],
  ["tabla con Versión 1 en una celda", "| Entrega | Nota | Estado |\n|---|--:|---|\n| **Versión 1**: 72 | 72 | Observada |\n| **Versión 2**: 85 | 85 | Aprobada |"],
  ["tabla sin barras al borde", "Causa | Frecuencia\n--- | ---:\nMantenimiento | 45\nCapacitación | 20"],
  ["encabezados de etapa", "### Etapa 4. Diagrama de Ishikawa\n\n#### Paso 2. Porqués\n\nSigamos con la rama **Método**."],
  ["lista anidada", "1. Medir tiempos\n   1. Cronometrar 10 ciclos\n   2. Registrar en Excel\n   - Usar la plantilla 2. del curso\n2. Analizar resultados"],
  ["código Excel", "Usa esto:\n\n```\n=SI(B2>0; C2/B2; 0)\n- B2: unidades producidas\n1. Copia la fórmula 2. Arrástrala\n¿Ves el resultado?\n```"],
  ["código Python", "```python\nfor i in range(3):\n\tprint(i)\n\n\n\nx = 1   \n```"],
  ["código con ~~~ sin cerrar", "Ejemplo:\n\n~~~\n- a\n1. b 2. c\n✅ listo"],
  ["código en línea", "Escribe `1. Medir 2. Analizar` tal cual y `=PROMEDIO(B2:B11)`."],
  ["fórmula en línea", "La productividad es $$P = \\frac{U}{HH}$$ y el promedio $$\\bar{x} = \\frac{12 + 15 + 18}{3} = 15. $$ por ciclo."],
  ["fórmula en bloque", "La productividad:\n\n$$\n\\begin{aligned}\nP &= \\frac{1200}{160} \\\\\n  &= 7,5 \\text{ u/HH}\n\\end{aligned}\n$$"],
  ["fórmula con \\[ \\]", "Variación:\n\n\\[\n\\Delta = \\frac{9 - 12}{12} \\times 100 = -25 \\%\n\\]"],
  ["variables con $", "Donde $x_{i}$ es cada observación y $n$ el número de ciclos."],
  [
    "números, fechas y decimales",
    "Tu informe obtuvo **78**/100. La nota mínima es 80. Revisa la sección 3. Metodología. Reducir 15 % hasta diciembre de 2026. Esto equivale a 7.5 horas o 7,5 u/HH, Bs. 200 y N.º 3.",
  ],
  ["número al empezar una línea", "La nota mínima es\n80. Revisa la sección."],
  ["cita con lista", "> **Ejemplo:** 1. Medir 2. Analizar\n> - con cronómetro"],
  ["salto forzado", "Responsable: jefe de planta  \nPlazo: 4 semanas"],
];

// Conversiones que se mantienen.
const CONVERTED: Array<[string, string, string]> = [
  [
    "lista en una línea",
    "Registré tu avance: 1. Capacitación del personal 2. Medición de tiempos",
    "Registré tu avance:\n\n1. Capacitación del personal\n\n2. Medición de tiempos",
  ],
  [
    "ítems desde el inicio de la línea",
    "1. Primera actividad 2. Segunda actividad 3. Tercera actividad",
    "1. Primera actividad\n\n2. Segunda actividad\n\n3. Tercera actividad",
  ],
  [
    "el mismo número dos veces",
    "Corrige: 1. Agrega el indicador del objetivo 2. 2. Vincula la iniciativa.",
    "Corrige:\n\n1. Agrega el indicador del objetivo 2.\n\n2. Vincula la iniciativa.",
  ],
  [
    "referencia dentro de un ítem",
    "1. Completa la Etapa 4. Diagrama de Ishikawa 2. Valida Pareto",
    "1. Completa la Etapa 4. Diagrama de Ishikawa\n\n2. Valida Pareto",
  ],
  [
    "viñetas, emojis y preguntas",
    "Datos que faltan:\n- Rubro\n- Producto\n✅ Listo el área\n¿Seguimos?",
    "Datos que faltan:\n\n- Rubro\n\n- Producto\n\n✅ Listo el área\n\n¿Seguimos?",
  ],
  [
    "lista numerada en líneas",
    "Tus causas raíz:\n1. Falta de mantenimiento\n2. Sin estándar",
    "Tus causas raíz:\n\n1. Falta de mantenimiento\n\n2. Sin estándar",
  ],
  ["Versión en la prosa", "**Versión 1**: aprobada con observaciones.", "**Versión 1**\naprobada con observaciones."],
  [
    "tabla seguida de texto",
    "| Causa | Frecuencia |\n|---|--:|\n| Mantenimiento | 45 |\nEsta causa concentra el 37,5 %.",
    "| Causa | Frecuencia |\n|---|--:|\n| Mantenimiento | 45 |\n\nEsta causa concentra el 37,5 %.",
  ],
  ["tabulaciones y espacios de la prosa", "Primero\tmide.   \n\n\n\nLuego analiza.", "Primero mide.\n\nLuego analiza."],
];

// Muletilla inicial: se quita solo ella; un nombre o un término se queda, y una variable no pasa a
// mayúscula.
const LEAD: Array<[string, string]> = [
  ["Entendido, Ana, registré tu avance.", "Ana, registré tu avance."],
  ["Perfecto, sigamos con **Método**.", "Sigamos con **Método**."],
  ["listo, Pareto quedó con 3 causas críticas.", "Pareto quedó con 3 causas críticas."],
  ["Ok, listo, sigamos.", "Sigamos."],
  ["ok, y luego medimos.", "Y luego medimos."],
  ["x_{i} es cada observación.", "x_{i} es cada observación."],
  ["Claro, x es la variable y P' la nueva productividad.", "x es la variable y P' la nueva productividad."],
  ["Listo,", "Listo,"],
  ["Perfecto 👍 Iniciamos la Etapa 3.", "Perfecto 👍 Iniciamos la Etapa 3."],
];

// Textos representativos de E1-E10 (los fijos del chat y de las rutas, y respuestas tipo de
// Gemini). Sin `expected`, el texto ya está en su forma final y no cambia. Todos dan lo mismo que el
// formato anterior.
const STAGES: Array<{ stage: string; text: string; expected?: string }> = [
  {
    stage: "E1 sin validar",
    text: "⚠️ Aún no está listo para validar.\n\nProblemas:\n- Falta el periodo\n- Falta el tipo\n\nRúbrica:\n- coherencia: 3\n- total: 7\n\nCorrige eso y me lo envías de nuevo 🙂",
    expected:
      "⚠️ Aún no está listo para validar.\n\nProblemas:\n\n- Falta el periodo\n\n- Falta el tipo\n\nRúbrica:\n\n- coherencia: 3\n\n- total: 7\n\nCorrige eso y me lo envías de nuevo 🙂",
  },
  {
    stage: "E1 validada",
    text: "✅ **Etapa 1 (Productividad) validada**.\n\nAhora pasamos a la **Etapa 2: Análisis FODA**.\n\nEmpezamos con **Fortalezas (internas)**.\n\nDime una fortaleza real del proceso o área que analizas.",
  },
  { stage: "E2", text: "Seguimos en **Fortalezas**. Ya llevas **2** punto(s) en este cuadrante." },
  {
    stage: "E3 inicio",
    text: "Perfecto 👍 Iniciamos la **Etapa 3: Lluvia de ideas (causas)**.\n\n✅ Primero debes elegir tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n👉 Escríbeme: por ejemplo **FO** y dime el motivo en 1–2 líneas.",
    expected:
      "Perfecto 👍 Iniciamos la **Etapa 3: Lluvia de ideas (causas)**.\n\n✅ Primero debes elegir tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n\n👉 Escríbeme: por ejemplo **FO** y dime el motivo en 1–2 líneas.",
  },
  { stage: "E3 cierre", text: "✅ Ya tenemos suficientes causas.\n\n¿Quieres **seguir agregando** más causas o **pasamos a la Etapa 4 (Ishikawa)**?" },
  {
    stage: "E4 ramas a medias",
    text: "Ramas sin terminar:\n1) Mano de obra → Falta de capacitación (2 porqués)\n2) Método → Sin estándar (3 porqués)\nPara retomar una, escribe **retomar 1** o el nombre de la subcausa.",
  },
  {
    stage: "E5 causas raíz",
    text: "Tus causas raíz:\n1. Falta de mantenimiento preventivo\n2. Sin procedimiento estándar\n\nEstamos listos para definir los criterios.",
    expected: "Tus causas raíz:\n\n1. Falta de mantenimiento preventivo\n\n2. Sin procedimiento estándar\n\nEstamos listos para definir los criterios.",
  },
  {
    stage: "E6",
    text: "Actualmente el sistema todavia registra tu avance en **Etapa 6: Objetivos**. Para pasar a **Etapa 7** falta completar: objetivo general, indicador.",
  },
  {
    stage: "E7 cierre",
    text: "Tu **Plan de Mejora** ya está lo bastante sólido para cerrar la etapa.\n\nSi estás de acuerdo, en este turno lo tomo como confirmación de cierre y pasamos a la **Etapa 8: Planificación**.",
  },
  { stage: "E8", text: "Todavía no conviene cerrar la **Etapa 8**.\n\nFalta definir responsables." },
  { stage: "E9", text: "Registré tu avance de la semana 3. ¿Qué actividad sigue?" },
  {
    stage: "E10 retroalimentación",
    text: "Valoración general: El documento es consistente.\n\nQué debes corregir para la siguiente versión: 1. Agrega el indicador 2. Vincula la iniciativa con la causa crítica 3. Ajusta el cronograma.",
    expected:
      "Valoración general: El documento es consistente.\n\nQué debes corregir para la siguiente versión:\n\n1. Agrega el indicador\n\n2. Vincula la iniciativa con la causa crítica\n\n3. Ajusta el cronograma.",
  },
  {
    stage: "transición",
    text: "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\nEstabas en la **Etapa 10 (Informe final)**.\n\n👉 Continúa subiendo, corrigiendo o validando tu informe final.",
  },
];

// Respuesta tipo de E10 con todo junto: tabla seguida de texto, lista en una línea y fórmula.
const E10_STRUCTURED =
  "Valoración general: El documento obtiene 72/100.\n\n" +
  "| Criterio | Puntaje |\n|---|--:|\n| Coherencia | 18 |\n| Método | 15 |\n" +
  "La coherencia baja por el objetivo 2.\n\n" +
  "Qué debes corregir para la siguiente versión: 1. Agrega el indicador 2. Vincula la iniciativa 3. Ajusta el cronograma.\n\n" +
  "$$\nP = \\frac{U}{HH}\n$$";

function runStructure() {
  for (const [name, text] of UNCHANGED) assert.equal(f(text), text, name);
  for (const [name, text, expected] of CONVERTED) assert.equal(f(text), expected, name);
  for (const [text, expected] of LEAD) assert.equal(softenAssistantLeadInChat(text), expected, text);

  // Lo que se pinta: la tabla conserva sus filas, la lista anidada su nivel y la fórmula su bloque.
  {
    const html = render(f(PARETO_TABLE));
    assert.equal(count(html, "<table"), 1);
    assert.equal(count(html, "<tr"), 5, "encabezado y cuatro filas");
    assert.equal(count(html, "<ol"), 0, "las celdas no pasan a lista");
  }
  {
    const html = render(f(UNCHANGED.find(([name]) => name === "lista anidada")![1]));
    assert.equal(count(html, "<ol"), 2, "lista y sublista");
  }
  {
    const formatted = f(E10_STRUCTURED);
    const html = render(formatted);
    assert.equal(count(html, "<tr"), 3, "el texto que sigue a la tabla no es otra fila");
    assert.equal(count(render(E10_STRUCTURED), "<tr"), 4, "sin el formato, GFM lo pega a la tabla");
    assert.equal(count(html, "<li"), 3);
    assert.equal(count(html, 'class="katex-display"'), 1);
    assert.ok(formatted.includes("72/100.") && formatted.includes("| Coherencia | 18 |"), "datos intactos");
  }
}

function runStages() {
  for (const { stage, text, expected } of STAGES) assert.equal(f(text), expected ?? text, stage);

  // E0: apertura, revisión y confirmación quedan tal cual.
  const complete = { sector: "Panadería", products: ["Pan"], process_focus: ["Producción"] };
  const e0 = [
    buildStage0Opening(1, {}, "Ana"),
    buildStage0Opening(2, { sector: "Alimentos" }, "Alan"),
    buildStage0ReviewOpening(complete, "Ana"),
    buildStage0Review(complete, "Gracias, registré el área o proceso: **Producción**."),
    buildStage0Confirmed(complete),
    `${advisorStageHeading("Etapa 0: Contexto del caso")}\n\n${advisorQuestion("¿A qué rubro pertenece la empresa?", "Por ejemplo, alimentos.")}`,
  ];
  for (const text of e0) assert.equal(f(text), text, text);
}

function runIdempotence() {
  const inputs = [
    ...UNCHANGED.map(([, text]) => text),
    ...CONVERTED.map(([, text]) => text),
    ...LEAD.map(([text]) => text),
    ...STAGES.map(({ text }) => text),
    E10_STRUCTURED,
  ];
  for (const text of inputs) {
    const once = f(text);
    assert.equal(f(once), once, text);
  }
}

// Lo que se ve es lo que se guarda: el navegador da formato al pintar y el servidor calcula el
// texto guardado desde el original firmado.
async function runPersistence() {
  const USER = "11111111-1111-4111-8111-111111111111";
  const CHAT = "33333333-3333-4333-8333-333333333333";
  const keyStatus = loadAssistantReceiptKey({
    ASSISTANT_RECEIPT_SECRET: Buffer.from("opt-ia: clave de prueba del formato del asesor").toString("base64"),
  });
  assert.ok(keyStatus.ok);

  const harness = () => {
    const shown: Message[] = [];
    const persisted: PersistMessageInput[] = [];
    const deps: AppendAssistantDeps = {
      modeRef: { current: "plan_mejora" },
      chatIdRef: { current: CHAT },
      setMessages: (update) => shown.splice(0, shown.length, ...update([...shown])),
      persistMessageDB: async (input) => {
        persisted.push(input);
        return { ok: true };
      },
    };
    return { deps, shown, persisted };
  };

  for (const raw of [E10_STRUCTURED, PARETO_TABLE, UNCHANGED[6][1], "Entendido, Ana, registré tu avance: 1. Medir 2. Analizar"]) {
    // Respuesta de una ruta, con recibo.
    const receipt = signAssistantReceipt(keyStatus.key, { userId: USER, chatId: CHAT, content: raw });
    const signed = harness();
    await appendAssistantMessage(signed.deps, raw, readSignedAssistantReply(true, { assistantMessage: raw, assistantReceipt: receipt }, CHAT));
    assert.equal(signed.shown[0].role, "assistant");
    assert.equal(signed.shown[0].content, f(raw));
    const body = parsePersistMessageBody(signed.persisted[0]);
    assert.ok(body.ok);
    const decision = decideMessageWrite({
      userId: USER,
      body: body.body,
      chat: { ownerId: USER, mode: "plan_mejora" },
      gate: { ok: true },
      receiptKey: () => keyStatus,
    });
    assert.ok(decision.ok, "el recibo verifica");
    assert.equal(decision.row.content, signed.shown[0].content, "el servidor guarda lo que se ve");

    // Texto local del asesor: se guarda lo que se ve.
    const local = harness();
    await appendAssistantMessage(local.deps, raw);
    const saved = local.persisted[0];
    assert.ok(saved.role === "advisor" && saved.content === local.shown[0].content);
  }
}

// El formato no entra en gates, estados, puntajes ni artefactos: fuera de las pruebas solo lo usan
// appendAssistantMessage, page.tsx y la política de /api/messages (createMessage, del mismo
// módulo, no cuenta).
function runScope() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(path.join(process.cwd(), "src"));
  const users = files
    .filter((file) => {
      const names = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/assistantFormat["']/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
      return /\b(?:formatAdvisorReplyForChat|formatAssistantMessageForReadability|softenAssistantLeadInChat)\b/.test(names);
    })
    .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(users, [
    "src/app/chat/_lib/appendAssistantMessage.ts",
    "src/app/chat/page.tsx",
    "src/lib/chat/messageWritePolicy.ts",
  ]);
}

async function main() {
  runStructure();
  runStages();
  runIdempotence();
  await runPersistence();
  runScope();
}

main()
  .then(() => console.log("assistantFormat tests passed"))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
