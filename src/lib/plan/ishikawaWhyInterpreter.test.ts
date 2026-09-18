import assert from "node:assert/strict";

import {
  classifyWhyIntent,
  extractWhyAnswer,
  isCloseBranchConfirm,
  isProgressRequest,
  isStageAdvanceRequest,
  normalizeWhyText,
  type IshikawaWhyIntent,
} from "./ishikawaWhyInterpreter";

// Intención de un mensaje del estudiante en E4 (Tanda 3, Fase 1). El intérprete es permisivo:
// si el mensaje no pide ayuda, no navega ni pregunta por el proceso, es una respuesta al
// porqué, tenga o no una frase causal. Si sirve como causa lo decide whyQuality (ver
// ishikawaWhyIntake.test.ts). Datos ficticios.

function expectIntent(texts: readonly string[], intent: IshikawaWhyIntent) {
  for (const text of texts) assert.equal(classifyWhyIntent(text), intent, text);
}

// Respuestas sin frase causal ("falta", "no hay", "nadie", "porque"…): se aceptan.
expectIntent(
  [
    "El operario no conoce el procedimiento",
    "El encargado desconoce la configuración del sistema de caja",
    "La gerencia no asignó un responsable",
    "Los cajeros tardan en registrar cada venta",
    "mala gestión",
    "Tal vez falta capacitación",
    "Por que no hay supervisión en el turno noche",
  ],
  "answer_why"
);

// Frases que parecen ayuda, navegación, avance o cierre y son causas.
expectIntent(
  [
    "No se registra la temperatura del horno",
    "No se capacita al personal nuevo",
    "No se sigue el procedimiento de horneado",
    "No se explica el procedimiento a los nuevos",
    "Por ejemplo, no hay registro de mermas",
    "Pasamos mucho tiempo buscando herramientas",
    "No se actualiza el mapa de procesos",
    "Falta un resumen diario de ventas",
    "No vamos a poder reparar la máquina a tiempo",
    "Cerramos la caja sin cuadrar el efectivo",
    "No hay ayuda del supervisor en el cierre",
  ],
  "answer_why"
);

// Pedidos de ayuda.
expectIntent(
  [
    "ayuda",
    "Ayuda por favor",
    "necesito ayuda con esta rama",
    "no entiendo",
    "Ayúdame con esto",
    "no sé qué poner",
    "no se",
    "la verdad no sé",
    "explícame",
    "no estoy seguro",
    "¿cómo lo redacto?",
    "¿Qué significa causa raíz?",
  ],
  "ask_guidance"
);

// Pedidos de ejemplos.
expectIntent(["dame un ejemplo", "ejemplos", "¿me puedes dar un ejemplo?", "dame ideas"], "ask_example");

// Cambio de contexto: de etapa, de categoría o de rama.
expectIntent(
  [
    "pasemos a Pareto",
    "pasemos a la etapa 5",
    "cambiemos de rama",
    "dejemos esta rama",
    "otra causa",
    "sigamos",
    "vamos con Máquina",
    "quiero cambiar de categoría",
  ],
  "switch_context"
);

// Consultas del proceso y avance.
expectIntent(["muéstrame el avance", "¿qué me falta?", "en qué vamos", "ya te dije eso", "¿dónde íbamos?"], "meta_process");

// Confirmación de cierre.
expectIntent(["cerremos", "Sí, cerremos esta rama", "ok, cerrar"], "close_request");
assert.equal(isCloseBranchConfirm("Cerramos la caja sin cuadrar el efectivo"), false);

// Solo acusan recibo: no son una respuesta ni piden nada.
expectIntent(["ok", "gracias", "Sí", "listo, gracias", "", "   "], "unclear");

// Avance, mapa y "¿qué me falta?" sin confundirlos con causas.
for (const text of [
  "muéstrame el avance",
  "el mapa",
  "resumen por favor",
  "¿qué me falta?",
  "¿Por qué no puedo avanzar?",
  "cómo voy",
  "situación actual del Ishikawa",
]) {
  assert.equal(isProgressRequest(text), true, text);
}
for (const text of [
  "No se actualiza el mapa de procesos",
  "Falta un resumen diario de ventas",
  "No se conoce el estado actual del stock",
]) {
  assert.equal(isProgressRequest(text), false, text);
}

// Pasar de etapa.
for (const text of ["pasemos a Pareto", "¿Ya podemos pasar a la siguiente etapa?", "terminemos el Ishikawa", "Pareto"]) {
  assert.equal(isStageAdvanceRequest(text), true, text);
}
for (const text of ["No se hace un análisis de Pareto", "Pasamos mucho tiempo en la etapa de horneado"]) {
  assert.equal(isStageAdvanceRequest(text), false, text);
}

// Texto que se guarda: sin muletillas ni reservas, con mayúscula inicial.
assert.equal(extractWhyAnswer("tal vez falta capacitación"), "Falta capacitación");
assert.equal(extractWhyAnswer("no estoy seguro, pero creo que no hay supervisión"), "No hay supervisión");
assert.equal(
  extractWhyAnswer("Porque el operario no conoce el procedimiento"),
  "El operario no conoce el procedimiento"
);
assert.equal(extractWhyAnswer("ayuda"), null);
assert.equal(extractWhyAnswer("ok"), null);
assert.equal(normalizeWhyText("Sí, no hay registro"), "No hay registro");
assert.equal(normalizeWhyText("creo que tal vez falta control"), "Falta control");
// "Si" condicional (sin coma) no es una muletilla.
assert.equal(normalizeWhyText("Si no hay supervisión, se atrasan"), "Si no hay supervisión, se atrasan");

console.log("ishikawaWhyInterpreter tests passed");
