import assert from "node:assert/strict";

import { formatAdvisorReplyForChat } from "../chat/assistantFormat";
import { getAdvisorStageLabel } from "./advisorMessages";
import {
  askForMissingStage0Field,
  buildStage0AnonymityReply,
  buildStage0Clarification,
  buildStage0Confirmed,
  buildStage0ContextChange,
  buildStage0Opening,
  buildStage0ProgressMessage,
  buildStage0Reply,
  buildStage0RetryShort,
  buildStage0Review,
  buildStage0ReviewOpening,
  buildStage0ReviewReply,
  classifyStage0DecisionIntent,
  isStage0AwaitingReview,
  isStage0ReviewConfirmation,
  readStage0Message,
  STAGE0_REVIEW_REMINDER,
  stage0CorrectionLead,
  stage0CorrectionQuestion,
  stage0FieldNegated,
  stage0ReviewKey,
  detectEditingField,
  detectStage0Intent,
  extractStage0Deterministic,
  formatContextSummary,
  getNextStage0StepFromContext,
  groundStage0Extraction,
  hasMultipleStage0FieldSignals,
  hasStage0DataCue,
  hasStage0Extraction,
  hasStage0ProductSignal,
  isLongStage0Message,
  isStage0Question,
  isStage0StartRequest,
  lastAssistantIsStage0Prompt,
  mergeStage0Context,
  mergeStage0Extraction,
  readStage0Context,
  shouldAnswerWithoutLLM,
  stage0FieldMentioned,
  stage0QuestionFor,
  stage0Reminder,
  stage0StepForField,
  type Stage0ContextJson,
  type Stage0DecisionIntent,
} from "./stage0Context";

// Etapa 0: intención, extracción, lectura del contexto y textos (stage0Context.ts). La intención,
// los textos y la extracción se corrigieron en fix/advisor-e0-natural-opening.

function assistant(content: string) {
  return { id: "m", role: "assistant" as const, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

// Preguntas de un texto: cada "¿" abre una. Una pregunta principal por mensaje.
const questionsIn = (text: string) => (text.match(/¿/g) ?? []).length;

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
  // El "?" se mira en el texto original: normalizeText lo quita.
  assert.equal(detectStage0Intent("¿Cuál es tu nombre?"), "QUESTION");
  assert.equal(detectStage0Intent("¿Alimentos?"), "ANSWER", "respuesta dudosa, no pregunta");
  // Pedir empezar, también como pregunta y con "comenzar".
  assert.equal(detectStage0Intent("¿Cómo empezamos?"), "START");
  assert.equal(
    detectStage0Intent("Quiero comenzar mi Plan de Mejora para mis prácticas empresariales. ¿Cómo empezamos?"),
    "START"
  );
  assert.equal(detectStage0Intent("Empecemos"), "START");
  assert.equal(detectStage0Intent("¿Puedo cambiar el sector?"), "EDIT");
}

{
  // Señales.
  assert.equal(isStage0Question("¿Qué es un rubro?"), true);
  assert.equal(isStage0Question("que es un rubro"), true, "sin signos");
  assert.equal(isStage0Question("¿Alimentos?"), false);
  assert.equal(isStage0Question("Es una panadería"), false);
  assert.equal(isStage0StartRequest("Quiero comenzar"), true);
  assert.equal(isStage0StartRequest("Quiero empezar, la empresa fabrica muebles"), false, "trae un dato");
  assert.equal(isStage0StartRequest("La producción empieza a las 6"), false, "tercera persona");
  assert.equal(hasStage0DataCue("Es una panadería"), true);
  assert.equal(hasStage0DataCue("¿Qué es un rubro?"), false, "definición, no dato");
  assert.equal(hasStage0DataCue("Vendemos pan"), true);
  assert.equal(isLongStage0Message("Es una panadería"), false);
  assert.equal(isLongStage0Message("Quiero comenzar con el plan, la empresa es una panadería grande"), true);
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
  // La incertidumbre sin un valor es "unknown" (antes "no estoy seguro del sector" guardaba "Del Sector").
  assert.equal(classifyStage0DecisionIntent("tengo dudas", "ANSWER"), "unknown");
  assert.equal(classifyStage0DecisionIntent("no estoy seguro", "ANSWER"), "unknown");
}

{
  // Los casos de la prueba real y los pedidos: intención y que nada de lo que no es respuesta se
  // guarde (shouldAnswerWithoutLLM: se responde sin extraer y sin Gemini).
  const cases: Array<[string, Stage0DecisionIntent]> = [
    ["Quiero comenzar mi Plan de Mejora para mis prácticas empresariales. ¿Cómo empezamos?", "start"],
    ["Quiero comenzar", "start"],
    ["¿Cómo empezamos?", "start"],
    ["Empecemos", "start"],
    ["hola", "greeting"],
    ["ok", "confirm"],
    ["No sé cuál es el rubro", "unknown"],
    ["no estoy seguro del sector", "unknown"],
    ["No tengo claro el rubro", "unknown"],
    ["Dame un ejemplo", "example_request"],
    ["¿Me das opciones?", "example_request"],
    ["¿Por qué necesitas esa información?", "meta_process"],
    ["¿Para qué me preguntas eso?", "meta_process"],
    ["¿Qué es un sector?", "help_request"],
    ["que es un rubro", "help_request"],
    ["Necesito ayuda", "help_request"],
    ["Es una panadería", "answer"],
    ["Alimentos", "answer"],
    ["¿Alimentos?", "answer"],
    ["No sé, creo que alimentos", "answer"],
    ["Por ejemplo, vendemos pan y pasteles", "answer"],
    ["Como la empresa fabrica muebles, el rubro es manufactura", "answer"],
    ["Es una empresa textil que fabrica poleras y quiero analizar producción", "answer"],
    // Casos de la extracción: la duda con un verbo no es un dato; la pregunta no se guarda.
    ["No sé qué productos fabrican", "unknown"],
    ["No sé qué venden", "unknown"],
    ["no se que hacen", "unknown"],
    ["¿Qué significa área de intervención?", "help_request"],
    ["que producto pongo", "help_request"],
    ["Dame ejemplos de productos", "example_request"],
    ["Fabricamos yogurt y queso", "answer"],
    ["Vendemos pan", "answer"],
    ["El área es producción", "answer"],
    ["Trabajamos en el área de inventarios", "answer"],
    ["Producimos prendas de vestir", "answer"],
    ["No sé exactamente qué venden, creo que ropa", "answer"],
  ];
  for (const [text, expected] of cases) {
    const intent = classifyStage0DecisionIntent(text, detectStage0Intent(text));
    assert.equal(intent, expected, text);
    assert.equal(shouldAnswerWithoutLLM(intent), expected !== "answer", `${text}: ¿se responde sin guardar?`);
  }
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
  // Una respuesta dudosa se guarda sin los signos.
  assert.equal(extractStage0Deterministic("¿Alimentos?", 1).sector, "Alimentos");
  // Corrección: el turno pasa el paso del campo que se corrige.
  assert.deepEqual(extractStage0Deterministic("Textil", 1, "sector"), {
    sector: "Textil",
    products: undefined,
    process_focus: undefined,
  });
}

{
  // Extracción: palabras enteras, comparadas sin tildes ni mayúsculas, y el valor recortado del
  // texto original. Cada caso: [mensaje, paso, lo que se extrae].
  const cases: Array<[string, 1 | 2 | 3, Stage0ContextJson]> = [
    // Los errores de la prueba real: el verbo se reconoce entero (antes "Mos Yogurt") y "área" con tilde.
    ["Fabricamos yogurt y queso", 2, { products: ["Yogurt", "Queso"] }],
    ["Vendemos pan", 2, { products: ["Pan"] }],
    ["El área es producción", 3, { process_focus: ["Producción"] }],
    ["Trabajamos en el área de inventarios", 3, { process_focus: ["Inventarios"] }],
    ["Producimos prendas de vestir", 2, { products: ["Prendas de vestir"] }],
    // Otras conjugaciones, "se venden", "nos dedicamos a la venta de…".
    ["La empresa fabrica muebles de madera", 2, { products: ["Muebles de madera"] }],
    ["Elaboramos pan, tortas y galletas", 2, { products: ["Pan", "Tortas", "Galletas"] }],
    ["Se venden repuestos para autos", 2, { products: ["Repuestos para autos"] }],
    ["Ofrecemos servicios de mantenimiento", 2, { products: ["Servicios de mantenimiento"] }],
    ["Nos dedicamos a la venta de ropa", 2, { products: ["Ropa"] }],
    ["Hacemos muebles", 2, { products: ["Muebles"] }],
    ["Confeccionamos uniformes escolares", 2, { products: ["Uniformes escolares"] }],
    // El nombre del campo sin "es" ni ":" es parte del valor.
    ["Productos lácteos", 2, { products: ["Productos lácteos"] }],
    ["Servicios de transporte", 2, { products: ["Servicios de transporte"] }],
    // Mayúsculas y tildes: se compara sin ellas y se guarda lo escrito (todo en mayúsculas, en minúsculas).
    ["PRENDAS DE VESTIR", 2, { products: ["Prendas de vestir"] }],
    ["EL AREA ES PRODUCCION", 3, { process_focus: ["Produccion"] }],
    ["Me enfocaré en el almacén", 3, { process_focus: ["Almacén"] }],
    ["Trabajo en el departamento de calidad", 3, { process_focus: ["Calidad"] }],
    ["Mejorar la calidad", 3, { process_focus: ["Calidad"] }],
    ["El proceso de envasado", 3, { process_focus: ["Envasado"] }],
    // "Reclamos" termina como un verbo ("-amos") pero es un sustantivo.
    ["Reclamos", 3, { process_focus: ["Reclamos"] }],
    // Rellenos y frases con "es": el dato va después de la última cópula, o antes si después no hay dato.
    ["Lo que más vendemos es pan", 2, { products: ["Pan"] }],
    ["Mi producto estrella es el yogurt", 2, { products: ["Yogurt"] }],
    ["Productos de limpieza es lo principal", 2, { products: ["Productos de limpieza"] }],
    ["El área donde trabajo es producción", 3, { process_focus: ["Producción"] }],
    ["Mi área de intervención es producción", 3, { process_focus: ["Producción"] }],
    ["La producción es lo que quiero mejorar", 3, { process_focus: ["Producción"] }],
    ["El área de producción, específicamente el envasado", 3, { process_focus: ["Producción", "Envasado"] }],
    ["Trabajo en una empresa de alimentos", 1, { sector: "Alimentos" }],
    ["Hago mis prácticas en una panadería", 1, { sector: "Panadería" }],
    // Responder el área no toca los productos (antes "Logística y despacho" quedaba en los dos).
    ["Logística y despacho", 3, { process_focus: ["Logística", "Despacho"] }],
    ["Área de producción de yogurt", 3, { products: ["Yogurt"], process_focus: ["Producción"] }],
    // Rubro.
    ["La empresa es de alimentos", 1, { sector: "Alimentos" }],
    ["Se dedica a la construcción", 1, { sector: "Construcción" }],
    ["Estamos en el rubro de la construcción", 1, { sector: "Construcción" }],
    ["Alimentos y bebidas", 1, { sector: "Alimentos y bebidas" }],
    ["Servicios", 1, { sector: "Servicios" }],
    ["No sé, creo que alimentos", 1, { sector: "Alimentos" }],
    ["Es una fábrica de muebles", 1, { sector: "Fábrica de muebles" }],
    ["Es una panadería que vende pan", 1, { sector: "Panadería", products: ["Pan"] }],
    ["Panadería, vendemos pan y tortas", 1, { sector: "Panadería", products: ["Pan", "Tortas"] }],
    // Varios campos: cada valor a su campo, una sola vez.
    [
      "El sector es alimentos, el producto es yogurt y el área es producción",
      1,
      { sector: "Alimentos", products: ["Yogurt"], process_focus: ["Producción"] },
    ],
    [
      "Rubro textil, producto: poleras, área: producción",
      1,
      { sector: "Textil", products: ["Poleras"], process_focus: ["Producción"] },
    ],
    [
      "Es una empresa textil que fabrica poleras y quiero analizar producción",
      1,
      { sector: "Textil", products: ["Poleras"], process_focus: ["Producción"] },
    ],
    // Sin dato: la duda, el pedido, lo que describe a la empresa pero no su actividad, y una lista
    // sin marcas (la lee Gemini).
    ["No sé qué productos fabrican", 2, {}],
    ["quiero cambiar algo", 2, {}],
    ["Es una empresa familiar", 1, {}],
    ["La empresa tiene 50 trabajadores", 1, {}],
    ["Textil, poleras, producción", 1, {}],
  ];
  for (const [text, step, expected] of cases) {
    assert.deepEqual(
      extractStage0Deterministic(text, step),
      { sector: expected.sector, products: expected.products, process_focus: expected.process_focus },
      `${text} (paso ${step})`
    );
  }

  // Corrección: el campo que se corrige y su valor nuevo; sin valor nuevo, nada.
  assert.equal(extractStage0Deterministic("quiero cambiar el rubro a textil", 3, "sector").sector, "Textil");
  assert.deepEqual(extractStage0Deterministic("cambiar el área a calidad", 3, "process_focus").process_focus, ["Calidad"]);
  assert.equal(hasStage0Extraction(extractStage0Deterministic("quiero cambiar el rubro", 3, "sector")), false);

  // Nunca un pedazo de palabra: ningún valor empieza con la terminación de un verbo.
  for (const text of ["Fabricamos yogurt", "Vendemos pan", "Ofrecemos asesoría", "Se venden repuestos", "Producimos leche"]) {
    const products = extractStage0Deterministic(text, 2).products ?? [];
    assert.ok(products.length === 1 && !/^(?:mos|n|en|imos)\b/i.test(products[0]), `${text}: ${products.join(", ")}`);
  }
}

{
  // Señales para decidir si se consulta a Gemini: verbos conjugados y "área" con tilde cuentan; un
  // sustantivo ("producción", "fábrica") o el nombre de un campo sin valor no.
  assert.equal(hasStage0ProductSignal("Producimos prendas de vestir"), true);
  assert.equal(hasStage0ProductSignal("La producción es lo principal"), false);
  assert.equal(hasStage0ProductSignal("Es una fábrica de muebles"), false);
  assert.equal(hasStage0ProductSignal("¿Qué producto pongo?"), false);
  assert.equal(hasStage0DataCue("Dame ejemplos de productos"), false);
  assert.equal(hasMultipleStage0FieldSignals("Rubro textil, producto: poleras, área: producción"), true);
  assert.equal(hasMultipleStage0FieldSignals("Trabajamos en el área de inventarios"), false);
  assert.equal(hasMultipleStage0FieldSignals("Fabricamos yogurt y queso"), false);

  // El dato por el que pregunta o duda el mensaje.
  assert.equal(stage0FieldMentioned("¿Qué significa área de intervención?"), "process_focus");
  assert.equal(stage0FieldMentioned("No sé qué productos fabrican"), "products");
  assert.equal(stage0FieldMentioned("¿Qué es un RUBRO?"), "sector");
  assert.equal(stage0FieldMentioned("Dame un ejemplo"), null);

  // Gemini: un producto o un área sin ninguna palabra del mensaje no se guarda; el rubro sí puede
  // deducirse de la actividad.
  assert.deepEqual(
    groundStage0Extraction(
      { sector: "Alimentos", products: ["yogur", "queso"], process_focus: ["Producción"] },
      "Fabricamos yogurt y queso"
    ),
    { sector: "Alimentos", products: ["yogur", "queso"], process_focus: undefined }
  );
  // Por la raíz: "polera" por "poleras", "produccion" sin tilde.
  assert.deepEqual(
    groundStage0Extraction(
      { sector: "textil", products: ["polera"], process_focus: ["produccion"] },
      "Es una empresa textil que fabrica poleras y quiero analizar producción"
    ),
    { sector: "textil", products: ["polera"], process_focus: ["produccion"] }
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

  // La intención manda: antes una extracción determinista ("Dame Un Ejemplo") ganaba a la ayuda.
  assert.equal(shouldAnswerWithoutLLM("help_request"), true);
  assert.equal(shouldAnswerWithoutLLM("ambiguous"), true);
  assert.equal(shouldAnswerWithoutLLM("answer"), false);
  assert.equal(shouldAnswerWithoutLLM("correction"), false);
  assert.equal(shouldAnswerWithoutLLM("context_change"), false);
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
    `Ya tengo el producto o servicio: **Yogurt**.\n\n${stage0QuestionFor(1)}`
  );
  assert.equal(askForMissingStage0Field(1, {}), stage0QuestionFor(1));

  // Reconoce lo registrado y hace la pregunta del dato siguiente.
  assert.equal(
    buildStage0ProgressMessage({ sector: "Alimentos" }, { sector: "Alimentos" }),
    `Gracias, registré el rubro: **Alimentos**.\n\n${stage0QuestionFor(2)}`
  );
  // Con los tres datos, el resumen para revisar y la pregunta de si se registra; nunca "confirmado".
  const complete = { sector: "Panadería", products: ["Pan", "Pasteles"], process_focus: ["Producción"] };
  const review = buildStage0ProgressMessage({ process_focus: ["Producción"] }, complete);
  assert.equal(
    review,
    "Gracias, registré el área o proceso: **Producción**.\n\nAsí queda el contexto de tu caso:\n\n" +
      "- **Rubro:** Panadería\n\n- **Producto o servicio:** Pan, Pasteles\n\n- **Área o proceso:** Producción\n\n" +
      "**¿Lo registro así?**\nSi algo no es correcto, dime qué dato quieres cambiar."
  );
  assert.equal(review, buildStage0Review(complete, "Gracias, registré el área o proceso: **Producción**."));
  // Respuesta con duda: queda como provisional.
  assert.ok(
    buildStage0ProgressMessage({ products: ["Yogur"] }, { sector: "Alimentos", products: ["Yogur"] }, { tentative: true }).startsWith(
      "Gracias, registré el producto o servicio: **Yogur**. Lo dejo como provisional"
    )
  );
  assert.ok(buildStage0ProgressMessage({ process_focus: ["Almacén"] }, complete, { tentative: true }).includes("provisional"));
}

{
  // Revisión de E0 (el borrador con los tres datos espera el sí del estudiante).
  const complete = { sector: "Panadería", products: ["Pan"], process_focus: ["Producción"] };
  assert.equal(isStage0AwaitingReview(complete, "draft"), true);
  assert.equal(isStage0AwaitingReview(complete, "confirmed"), false);
  assert.equal(isStage0AwaitingReview({ sector: "Panadería" }, "draft"), false);

  // Solo un "sí" entero confirma; con "pero", "no", un dato o una pregunta, no.
  for (const yes of ["sí", "Sí, regístralo así", "ok", "Está bien", "todo correcto", "Correcto, sigamos", "sí por favor", "de acuerdo", "listo", "Así está bien, gracias"]) {
    assert.equal(isStage0ReviewConfirmation(yes), true, yes);
  }
  for (const no of [
    "no", "No está bien", "Sí, pero cambia el producto", "sí, el área es calidad", "¿Qué significa rubro?", "Queso",
    "creo que sí", "no sé", "Todavía no lo decido", "ok, pero el rubro es textil", "sí, mejor cambiemos el producto",
  ]) {
    assert.equal(isStage0ReviewConfirmation(no), false, no);
  }

  // Huella: igual sin importar mayúsculas ni tildes; distinta si cambia un dato.
  assert.equal(stage0ReviewKey(complete), stage0ReviewKey({ sector: "PANADERIA", products: ["pan"], process_focus: ["produccion"] }));
  assert.notEqual(stage0ReviewKey(complete), stage0ReviewKey({ ...complete, products: ["Pasteles"] }));

  // Textos de la revisión: una sola pregunta, Markdown del chat, terminología y sin "confirmado".
  const opening = buildStage0ReviewOpening(complete, "Ana");
  assert.ok(opening.startsWith(`¡Hola, Ana! 👋 Sigamos con el contexto de tu caso.\n\n### ${getAdvisorStageLabel(0)}`), opening);
  const texts = [
    buildStage0Review(complete, "Gracias, registré el área o proceso: **Producción**."),
    opening,
    stage0CorrectionQuestion(),
    buildStage0Confirmed(complete),
    buildStage0ContextChange(),
    buildStage0RetryShort(1),
    buildStage0AnonymityReply(2),
    ...(["help_request", "unknown", "deferral", "delegation", "third_party", "refusal", "vague", "off_topic", "answer"] as const).map(
      (intent) => buildStage0ReviewReply({ intent, context: complete, alreadyPrompted: true, topic: intent === "help_request" ? 3 : null })
    ),
  ];
  for (const text of texts) {
    assert.ok(questionsIn(text) <= 1, text);
    assert.equal(formatAdvisorReplyForChat(text), text);
    assert.ok(!/pr[aá]cticas|pasant[ií]a/i.test(text), text);
  }
  assert.ok(buildStage0Confirmed(complete).startsWith("Registré el contexto de tu caso: la Etapa 0 está completa."));
  assert.ok(buildStage0Confirmed(complete, { already: true }).startsWith("El contexto de tu caso ya estaba registrado"));
  assert.equal(stage0CorrectionLead("products", { ...complete, products: ["Queso"] }), "Actualicé el producto o servicio: **Queso**.");
  // La revisión no vuelve a preguntar: recuerda qué responder.
  assert.ok(buildStage0ReviewReply({ intent: "unknown", context: complete, alreadyPrompted: true }).endsWith(STAGE0_REVIEW_REMINDER));
  assert.equal(questionsIn(STAGE0_REVIEW_REMINDER), 0);
}

{
  // Actos del mensaje: rechazo, aplazamiento, delegación, vaguedad y negación no se guardan; con
  // un dato afirmado además, es una respuesta.
  const cases: Array<[string, Stage0DecisionIntent]> = [
    ["Eso es confidencial", "refusal"],
    ["Prefiero no decirlo", "refusal"],
    ["No puedo compartir esa información", "refusal"],
    ["Todavía no lo decido", "deferral"],
    ["Luego te digo", "deferral"],
    ["El que tú me recomiendes", "delegation"],
    ["Elige tú", "delegation"],
    ["¿Qué área me recomiendas?", "delegation"],
    ["Pregúntale a mi supervisor", "third_party"],
    ["Muchos, depende de la temporada", "vague"],
    ["Ninguno en especial", "vague"],
    ["Donde hay más problemas", "vague"],
    ["No es una fábrica", "negated"],
    ["Quiero cambiar de empresa", "context_change"],
    ["Me equivoqué, el rubro es textil", "correction"],
    ["No, mejor cambiemos el producto", "correction"],
    ["Perdón, no era yogur sino queso", "correction"],
    ["No puedo decir el nombre, pero es una panadería", "answer"],
    ["No es una fábrica, es un restaurante", "answer"],
    ["Ya te dije, yogur", "answer"],
    ["Mi supervisor dice que somos del rubro metalmecánico", "answer"],
    ["Sí, creo que almacén pero no estoy seguro todavía", "answer"],
  ];
  for (const [text, expected] of cases) {
    const intent = classifyStage0DecisionIntent(text, detectStage0Intent(text));
    assert.equal(intent, expected, text);
  }

  // La extracción lee lo que el estudiante afirma (sin lo negado, las dudas ni los rellenos).
  const read = (text: string, step: 1 | 2 | 3) => extractStage0Deterministic(readStage0Message(text).content, step);
  assert.equal(read("No es una fábrica, es un restaurante", 1).sector, "Restaurante");
  assert.equal(read("La empresa no es de alimentos, es de construcción", 1).sector, "Construcción");
  assert.equal(read("Mi supervisor dice que somos del rubro metalmecánico", 1).sector, "Metalmecánico");
  assert.deepEqual(read("Ya te dije, yogur", 2).products, ["Yogur"]);
  assert.deepEqual(read("Vendemos ropa pero no la fabricamos", 2).products, ["Ropa"]);
  assert.deepEqual(read("No es yogur, es leche", 2).products, ["Leche"]);
  assert.deepEqual(read("Sí, creo que almacén pero no estoy seguro todavía", 3).process_focus, ["Almacén"]);
  assert.equal(read("Me equivoqué, el rubro es textil", 3).process_focus, undefined, "«Equivoqué» no es un área");
  assert.equal(read("Me equivoqué, el rubro es textil", 3).sector, "Textil");
  // Sin la lectura de actos, el control de calidad igual descarta los tramos que no son datos.
  for (const [text, step] of [
    ["Eso es confidencial", 1], ["Prefiero no decirlo", 1], ["Todavía no lo decido", 3], ["El que tú me recomiendes", 3],
    ["Muchos, depende de la temporada", 2], ["Ninguno en especial", 2], ["No, mejor cambiemos el producto", 3],
  ] as const) {
    assert.equal(hasStage0Extraction(extractStage0Deterministic(text, step)), false, text);
  }

  // Lo negado dice qué dato se corrige si ya estaba registrado.
  assert.equal(stage0FieldNegated(["no era yogur"], { sector: "Alimentos", products: ["Yogur"] }), "products");
  assert.equal(stage0FieldNegated(["no es de alimentos"], { sector: "Alimentos" }), "sector");
  assert.equal(stage0FieldNegated(["no es una fábrica"], { sector: "Alimentos" }), null);
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
  // Apertura (estilo de advisorVoice.ts): saludo breve, la etapa con la etiqueta de la barra lateral,
  // los tres datos y para qué sirven, y una sola pregunta, destacada en su propio párrafo.
  const opening = buildStage0Opening(1, {}, "Alan");
  const paragraphs = opening.split("\n\n");
  assert.equal(paragraphs.length, 4, opening);
  assert.equal(
    paragraphs[0],
    "¡Hola, Alan! 👋 Vamos a desarrollar tu Plan de Mejora a partir de tu Práctica Empresarial. Yo te orientaré " +
      "durante el proceso y tú tomarás las decisiones."
  );
  assert.equal(paragraphs[1], `### ${getAdvisorStageLabel(0)}`);
  assert.ok(/rubro.*productos o servicios.*área o proceso/.test(paragraphs[2]), "los tres datos");
  assert.ok(paragraphs[2].includes("adaptar el diagnóstico a tu caso real"), "para qué sirven");
  assert.equal(paragraphs[3], stage0QuestionFor(1));
  assert.equal(
    stage0QuestionFor(1),
    "**¿A qué se dedica la empresa donde realizas tu Práctica Empresarial?**\nCuéntamelo brevemente, sin mencionar su nombre."
  );
  // Terminología (advisorVoice.ts): "Práctica Empresarial" en singular; sin "pasantía" ni plural.
  for (const text of [opening, stage0Reminder(1)]) {
    assert.ok(!/pr[aá]cticas|pasant[ií]a/i.test(text), text);
  }
  // No supone que el estudiante trabaja en la empresa.
  assert.ok(!/donde trabajas|trabajarás/.test(opening), opening);
  assert.equal(questionsIn(opening), 1);
  assert.equal(opening.split("A qué se dedica").length, 2, "la pregunta no se repite");
  assert.ok(opening.includes("sin mencionar su nombre"));
  assert.ok(!/Pregunta \d de 3/.test(opening));
  assert.ok(!opening.includes("Univ."), "el título va en la cabecera, no en el mensaje");
  // Más breve que la apertura anterior (unos 700 caracteres).
  assert.ok(opening.length < 600, `${opening.length} caracteres`);
  // El nombre de pila va tal cual: un nombre compuesto no se recorta; sin nombre, "¡Hola!".
  assert.ok(buildStage0Opening(1, {}, "María José").startsWith("¡Hola, María José! 👋"));
  assert.ok(buildStage0Opening(1, {}, null).startsWith("¡Hola! 👋"));
  assert.ok(buildStage0Opening(1, {}, "   ").startsWith("¡Hola! 👋"));

  // Retomar a mitad de E0: reconoce lo registrado y pregunta lo que falta.
  const resume2 = buildStage0Opening(2, { sector: "Alimentos" }, "Alan");
  assert.ok(resume2.startsWith("¡Hola, Alan! 👋 Sigamos con el contexto de tu caso.\n\n### Etapa 0"), resume2);
  assert.ok(resume2.includes("**Alimentos**") && resume2.endsWith(stage0QuestionFor(2)), resume2);
  const resume3 = buildStage0Opening(3, { sector: "Alimentos", products: ["Yogur"] }, null);
  assert.ok(resume3.includes("**Yogur**") && resume3.endsWith(stage0QuestionFor(3)), resume3);
  assert.equal(questionsIn(resume2), 1);
  assert.equal(questionsIn(resume3), 1);

  // Se pinta y se guarda tal cual: el formato del chat no la cambia (la aclaración sigue pegada a
  // su pregunta y no aparecen saltos nuevos).
  for (const text of [opening, resume2, resume3]) assert.equal(formatAdvisorReplyForChat(text), text);

  for (const step of [1, 2, 3] as const) {
    assert.equal(questionsIn(stage0QuestionFor(step)), 1);
    // El recordatorio retoma el dato sin volver a preguntarlo.
    assert.equal(questionsIn(stage0Reminder(step)), 0);
  }

  assert.equal(
    formatContextSummary({ sector: "Alimentos" }),
    "- **Sector:** Alimentos\n- **Producto(s):** (pendiente)\n- **Área:** (pendiente)"
  );
}

{
  // Respuestas sin datos (shouldAnswerWithoutLLM).
  const ctx = { sector: "Alimentos", products: ["Yogur"] };
  const reply = (intent: Stage0DecisionIntent, step: 1 | 2 | 3, alreadyPrompted: boolean, context = {}) =>
    buildStage0Reply({ intent, step, context, alreadyPrompted, greetingName: "Ana" });

  // Pedir empezar: la apertura si todavía no vio ninguna pregunta; si ya la vio, un recordatorio
  // distinto y sin otra pregunta.
  assert.equal(reply("start", 1, false), buildStage0Opening(1, {}, "Ana"));
  const startAgain = reply("start", 1, true);
  assert.notEqual(startAgain, buildStage0Opening(1, {}, "Ana"));
  assert.ok(startAgain.startsWith("¡Ya estamos en marcha!") && startAgain.includes(stage0Reminder(1)), startAgain);
  assert.equal(questionsIn(startAgain), 0);
  assert.equal(reply("greeting", 1, false), buildStage0Opening(1, {}, "Ana"));
  assert.equal(questionsIn(reply("greeting", 2, true, ctx)), 0);
  assert.equal(questionsIn(reply("confirm", 1, true)), 0);

  // Ayuda, ejemplo, "no sé" y propósito: ninguno hace más de una pregunta.
  for (const intent of ["help_request", "example_request", "unknown", "meta_process", "off_topic", "ambiguous"] as const) {
    for (const step of [1, 2, 3] as const) {
      const text = reply(intent, step, true, ctx);
      assert.ok(questionsIn(text) <= 1, `${intent} ${step}: ${text}`);
      assert.ok(!/nombre de la empresa\?/.test(text));
    }
  }
  // Los ejemplos usan lo que ya se sabe del caso.
  assert.ok(reply("example_request", 2, true, ctx).includes("**Alimentos**"));
  assert.ok(reply("example_request", 3, true, ctx).includes("**Yogur**"));
  assert.ok(reply("help_request", 1, true).includes("**rubro**"));
  assert.ok(reply("meta_process", 1, true).includes("Te lo pregunto porque"));
  // "No sé": orienta sin inventar el dato.
  assert.ok(reply("unknown", 1, true).includes("lo ubicamos juntos"));

  const clarification = buildStage0Clarification(2);
  assert.ok(clarification.startsWith("Gracias. Todavía no logro identificar el producto o servicio"));
  assert.equal(questionsIn(clarification), 0);

  // Ayuda sobre otro dato ("¿Qué significa área de intervención?" mientras se pide el rubro): lo
  // explica y retoma la pregunta en curso, sin pedir dos datos a la vez.
  const later = buildStage0Reply({ intent: "help_request", step: 1, context: {}, alreadyPrompted: true, topic: 3 });
  assert.ok(later.startsWith("El **área o proceso** (el área de intervención)"), later);
  assert.ok(later.endsWith(`Ese dato lo vemos más adelante. ${stage0Reminder(1)}`), later);
  assert.ok(!later.includes("dime cuál es"), "no pide el área mientras se pide el rubro");
  const earlier = buildStage0Reply({ intent: "help_request", step: 3, context: ctx, alreadyPrompted: true, topic: 1 });
  assert.ok(earlier.startsWith("El **rubro**") && earlier.endsWith(`\n\n${stage0Reminder(3)}`), earlier);
  const examplesLater = buildStage0Reply({ intent: "example_request", step: 1, context: {}, alreadyPrompted: true, topic: 2 });
  assert.ok(examplesLater.startsWith("Algunos ejemplos de cómo nombrar el producto"), examplesLater);
  assert.ok(examplesLater.endsWith(stage0Reminder(1)), examplesLater);
  // "No sé" orienta con lo que ya se sabe del caso.
  assert.ok(reply("unknown", 2, true, { sector: "Panadería" }).includes("del rubro **Panadería**"));
  assert.ok(reply("unknown", 3, true, ctx).includes("**Yogur**"));
  assert.equal(
    reply("unknown", 2, true),
    "No hay problema. Piensa en lo que la empresa entrega a sus clientes o en lo que ves a diario en tu práctica; con eso " +
      "basta, aunque no sea el nombre comercial exacto. Si tienes dudas, la persona que te supervisa en la empresa " +
      "puede confirmarlo."
  );
}

{
  // lastAssistantIsStage0Prompt (ya no la usa el chat; ver stage0Context.ts).
  assert.equal(lastAssistantIsStage0Prompt([]), false);
  assert.equal(lastAssistantIsStage0Prompt([assistant("Pregunta 1/3: ¿Cuál es el sector?")]), true);
}

console.log("stage0Context tests passed");
