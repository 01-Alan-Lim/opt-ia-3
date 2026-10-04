import assert from "node:assert/strict";

import {
  advisorResumeGreeting,
  askForMissingStage0Field,
  buildAdvisorGreeting,
  buildStage0ProgressMessage,
  buildStage0Welcome,
  classifyStage0DecisionIntent,
  detectEditingField,
  detectStage0Intent,
  extractStage0Deterministic,
  formatContextSummary,
  getNextStage0StepFromContext,
  hasMultipleStage0FieldSignals,
  hasStage0Extraction,
  hasStage0ProductSignal,
  lastAssistantIsStage0Prompt,
  mergeStage0Context,
  mergeStage0Extraction,
  promptForStep,
  readStage0Context,
  shouldAnswerWithoutLLM,
  stage0HelpMessage,
  stage0StepForField,
} from "./stage0Context";

// Caracterización de la Etapa 0 tal como quedó al moverla desde page.tsx: fija lo que hace HOY,
// incluidas las rarezas marcadas con "Hoy:", no lo que debería hacer.

function assistant(content: string) {
  return { id: "m", role: "assistant" as const, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

{
  // detectStage0Intent
  assert.equal(detectStage0Intent(""), "ANSWER");
  assert.equal(detectStage0Intent("¡Hola!"), "GREETING");
  assert.equal(detectStage0Intent("¿Qué debo responder?"), "QUESTION");
  assert.equal(detectStage0Intent("empezar"), "START");
  assert.equal(detectStage0Intent("Quiero empezar ya"), "START");
  assert.equal(detectStage0Intent("ok"), "CONFIRM");
  assert.equal(detectStage0Intent("Sí, confirmo"), "CONFIRM");
  assert.equal(detectStage0Intent("quiero cambiar el sector"), "EDIT");
  assert.equal(detectStage0Intent("hola, quiero cambiar el sector"), "EDIT");
  assert.equal(detectStage0Intent("Alimentos"), "ANSWER");
  // Hoy: normalizeText quita el "?", así que una pregunta sin frases clave es ANSWER.
  assert.equal(detectStage0Intent("¿Cuál es tu nombre?"), "ANSWER");
}

{
  // classifyStage0DecisionIntent
  assert.equal(classifyStage0DecisionIntent("", "ANSWER"), "ambiguous");
  assert.equal(classifyStage0DecisionIntent("quiero cambiar el producto", "EDIT"), "correction");
  assert.equal(classifyStage0DecisionIntent("no sé", "ANSWER"), "unknown");
  assert.equal(classifyStage0DecisionIntent("no sé, creo que alimentos", "ANSWER"), "answer");
  assert.equal(classifyStage0DecisionIntent("dame un ejemplo", "ANSWER"), "example_request");
  assert.equal(classifyStage0DecisionIntent("¿para qué sirve esto?", "QUESTION"), "meta_process");
  assert.equal(classifyStage0DecisionIntent("¿sector?", "QUESTION"), "ambiguous");
  assert.equal(classifyStage0DecisionIntent("no entiendo la pregunta", "QUESTION"), "help_request");
  assert.equal(classifyStage0DecisionIntent("vamos con pareto", "ANSWER"), "off_topic");
  assert.equal(classifyStage0DecisionIntent("quiero analizar otro caso", "ANSWER"), "context_change");
  assert.equal(classifyStage0DecisionIntent("Alimentos", "ANSWER"), "answer");
  // Hoy: "dudas" activa la señal de incertidumbre pero no se descuenta del resto, y "no estoy
  // seguro" no activa la señal; ninguno de los dos cuenta como "unknown".
  assert.equal(classifyStage0DecisionIntent("tengo dudas", "ANSWER"), "answer");
  assert.equal(classifyStage0DecisionIntent("no estoy seguro", "ANSWER"), "answer");
}

{
  // extractStage0Deterministic: un dato por mensaje.
  assert.deepEqual(extractStage0Deterministic("Alimentos", 1), {
    sector: "Alimentos",
    products: undefined,
    process_focus: undefined,
  });
  assert.deepEqual(extractStage0Deterministic("es una panadería", 1), {
    sector: "Panadería",
    products: undefined,
    process_focus: undefined,
  });
  assert.deepEqual(extractStage0Deterministic("Yogurt y queso", 2), {
    sector: undefined,
    products: ["Yogurt", "Queso"],
    process_focus: undefined,
  });
  assert.deepEqual(extractStage0Deterministic("Producción", 3), {
    sector: undefined,
    products: undefined,
    process_focus: ["Producción"],
  });
  assert.deepEqual(extractStage0Deterministic("no sé", 1), {
    sector: undefined,
    products: undefined,
    process_focus: undefined,
  });
  // Corrección: page.tsx pasa el paso del campo que se corrige.
  assert.deepEqual(extractStage0Deterministic("Textil", 1, "sector"), {
    sector: "Textil",
    products: undefined,
    process_focus: undefined,
  });
}

{
  // Hoy: el marcador de verbo no tiene límite de palabra. "Fabricamos" se corta en "fabrica" y
  // queda "mos" pegado al primer producto.
  assert.deepEqual(extractStage0Deterministic("Fabricamos yogurt y queso", 2), {
    sector: undefined,
    products: ["Mos Yogurt", "Queso"],
    process_focus: undefined,
  });
  // Hoy: con varios datos en un mensaje y "área" con tilde, el área corta en "sector" y el
  // producto se lleva el resto; el sector se descarta porque ya hay área.
  assert.deepEqual(
    extractStage0Deterministic("El sector es alimentos, el producto es yogurt y el área es producción", 1),
    { sector: undefined, products: ["Yogurt", "Área Es Producción"], process_focus: ["El"] }
  );
}

{
  // Señales usadas para decidir si se consulta al LLM.
  assert.equal(hasMultipleStage0FieldSignals("El sector es alimentos y el producto es yogurt"), true);
  assert.equal(hasMultipleStage0FieldSignals("Alimentos"), false);
  assert.equal(hasStage0ProductSignal("Vendemos pan"), true);
  assert.equal(hasStage0ProductSignal("Alimentos"), false);

  assert.equal(hasStage0Extraction({}), false);
  assert.equal(hasStage0Extraction({ products: [] }), false);
  assert.equal(hasStage0Extraction({ sector: "A" }), true);

  assert.equal(shouldAnswerWithoutLLM("help_request", {}), true);
  assert.equal(shouldAnswerWithoutLLM("help_request", { sector: "A" }), false);
  assert.equal(shouldAnswerWithoutLLM("answer", {}), false);
  assert.equal(shouldAnswerWithoutLLM("ambiguous", {}), false);
}

{
  // Lectura y fusión del contexto.
  assert.deepEqual(
    readStage0Context({
      sector: "  Alimentos ",
      products: "Yogurt",
      process_focus: ["Producción", "producción", "Calidad", "Ventas", "Logística"],
    }),
    { stage: "ETAPA_0", sector: "Alimentos", products: ["Yogurt"], process_focus: ["Producción", "Calidad", "Ventas"] }
  );
  assert.deepEqual(readStage0Context({}), {
    stage: "ETAPA_0",
    sector: undefined,
    products: undefined,
    process_focus: undefined,
  });
  assert.deepEqual(readStage0Context({ stage: "CONFIRMED", sector: "" }), {
    stage: "CONFIRMED",
    sector: undefined,
    products: undefined,
    process_focus: undefined,
  });

  // mergeStage0Context deja listas vacías; mergeStage0Extraction deja undefined.
  assert.deepEqual(mergeStage0Context({ sector: "Alimentos" }, { products: ["Yogurt"] }), {
    stage: "ETAPA_0",
    sector: "Alimentos",
    products: ["Yogurt"],
    process_focus: [],
  });
  assert.deepEqual(mergeStage0Extraction({ sector: "A", products: ["X"] }, { sector: "B" }), {
    stage: "ETAPA_0",
    sector: "B",
    products: ["X"],
    process_focus: undefined,
  });
}

{
  // Qué falta y qué se pregunta.
  assert.equal(getNextStage0StepFromContext({}), 1);
  assert.equal(getNextStage0StepFromContext(null), 1);
  assert.equal(getNextStage0StepFromContext({ sector: "  " }), 1);
  assert.equal(getNextStage0StepFromContext({ sector: "A" }), 2);
  assert.equal(getNextStage0StepFromContext({ sector: "A", products: "X" }), 2);
  assert.equal(getNextStage0StepFromContext({ sector: "A", products: ["X"] }), 3);
  assert.equal(getNextStage0StepFromContext({ sector: "A", products: ["X"], process_focus: ["P"] }), 0);

  assert.equal(
    askForMissingStage0Field(1, { products: ["Yogurt"] }),
    " Ya tengo como producto/servicio: **Yogurt**. Para completar el contexto, dime tambien el **rubro general** de la empresa."
  );
  // Hoy: sin productos el texto empieza con un espacio.
  assert.equal(askForMissingStage0Field(1, {}).startsWith(" Para completar"), true);

  assert.equal(
    buildStage0ProgressMessage({ sector: "Alimentos" }, { sector: "Alimentos" }),
    "Perfecto, ya registre sector: **Alimentos**.\n\nAhora dime que **productos o servicios** ofrece la empresa."
  );
  assert.equal(
    buildStage0ProgressMessage({}, { sector: "A", products: ["X"], process_focus: ["P"] }),
    "Perfecto, ya actualice el contexto.\n\nCon esto ya tenemos el contexto inicial del caso y puedo dejarlo confirmado."
  );
}

{
  // Corrección de un dato.
  assert.equal(detectEditingField("quiero cambiar el rubro"), "sector");
  assert.equal(detectEditingField("el producto está mal"), "products");
  assert.equal(detectEditingField("cambiar el área"), "process_focus");
  assert.equal(detectEditingField("cambiar el proceso de producción"), "process_focus");
  assert.equal(detectEditingField("cambiar todo"), null);

  assert.equal(stage0StepForField("sector"), 1);
  assert.equal(stage0StepForField("products"), 2);
  assert.equal(stage0StepForField("process_focus"), 3);
  assert.equal(stage0StepForField(null), null);
}

{
  // Textos fijos de E0.
  assert.equal(buildAdvisorGreeting("Ana María Pérez").startsWith("¡Hola, Ana! 👋"), true);
  assert.equal(buildAdvisorGreeting(null).startsWith("¡Hola! 👋"), true);
  assert.equal(buildAdvisorGreeting("   ").startsWith("¡Hola! 👋"), true);

  assert.equal(advisorResumeGreeting({ sector: "Alimentos" }, 2).includes("**Alimentos**"), true);
  assert.equal(advisorResumeGreeting({}, 2).includes("(pendiente)"), true);

  assert.equal(promptForStep(1).startsWith("🧩 **Pregunta 1 de 3**"), true);
  assert.equal(buildStage0Welcome(2).startsWith("👌 Retomemos"), true);
  assert.equal(buildStage0Welcome(2).endsWith(promptForStep(2)), true);
  assert.equal(stage0HelpMessage(3).includes("**area o proceso**"), true);

  assert.equal(
    formatContextSummary({ sector: "Alimentos" }),
    "- **Sector:** Alimentos\n- **Producto(s):** (pendiente)\n- **Área:** (pendiente)"
  );
}

{
  // lastAssistantIsStage0Prompt
  assert.equal(lastAssistantIsStage0Prompt([]), false);
  assert.equal(lastAssistantIsStage0Prompt([assistant("Pregunta 1/3: ¿Cuál es el sector?")]), true);
  // Hoy: no reconoce las preguntas que arma promptForStep ("Pregunta 1 de 3" y negritas).
  assert.equal(lastAssistantIsStage0Prompt([assistant(promptForStep(1))]), false);
  assert.equal(lastAssistantIsStage0Prompt([assistant(promptForStep(2))]), false);
  assert.equal(lastAssistantIsStage0Prompt([assistant(promptForStep(3))]), false);
}

console.log("stage0Context tests passed");
