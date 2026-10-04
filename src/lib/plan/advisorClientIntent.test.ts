import assert from "node:assert/strict";

import {
  isConfirmIntent,
  isGreetingOrSmallTalk,
  isHoursIntent,
  isProdQuestion,
  isReadyIntent,
  isShortAffirmativeReply,
  looksLikeAdvisorProgressStatusQuestion,
  looksLikeObjectivesClosureRequest,
  looksLikeProgressClosureRequest,
  looksLikeStage6NextStepQuestion,
  normalizeText,
  wantsAdvanceStage,
  wantsKeepAdding,
  wantsStage6ValidationNow,
} from "./advisorClientIntent";

// Caracterización: fija lo que hacen HOY las heurísticas que se movieron desde page.tsx, no lo
// que deberían hacer. Si un cambio rompe uno de estos casos, que sea a propósito.

{
  // normalizeText: minúsculas, sin tildes ni signos, espacios colapsados.
  assert.equal(normalizeText("¡Hola, MUNDO!  "), "hola mundo");
  assert.equal(normalizeText("Ñandú"), "nandu");
  assert.equal(normalizeText(""), "");
}

{
  // Afirmación corta. Las ramas con tilde ("sí", "está bien") no pueden coincidir después de
  // normalizar, pero la versión sin tilde sí: el resultado es el mismo.
  assert.equal(isShortAffirmativeReply("Sí"), true);
  assert.equal(isShortAffirmativeReply("OK."), true);
  assert.equal(isShortAffirmativeReply("Está bien"), true);
  assert.equal(isShortAffirmativeReply("no"), false);
  assert.equal(isShortAffirmativeReply("ok, pero tengo una duda"), false);
  assert.equal(isShortAffirmativeReply(""), false);
}

{
  // Avanzar de etapa (E4 -> E5).
  assert.equal(wantsAdvanceStage("Sí"), true);
  assert.equal(wantsAdvanceStage("pasemos a pareto"), true);
  assert.equal(wantsAdvanceStage("hablemos de la etapa 4"), true);
  assert.equal(wantsAdvanceStage("quiero ir a la etapa 6"), false);
  assert.equal(wantsAdvanceStage("no"), false);
  assert.equal(wantsAdvanceStage("tal vez"), false);
}

{
  // Seguir agregando causas. "mas" se busca como subcadena: "demasiado" cuenta.
  assert.equal(wantsKeepAdding("quiero agregar otra causa"), true);
  assert.equal(wantsKeepAdding("todavía"), true);
  assert.equal(wantsKeepAdding("es demasiado"), true);
  assert.equal(wantsKeepAdding("Los operarios no reciben capacitación sobre el uso de la máquina"), true);
  assert.equal(wantsKeepAdding("no"), false);
  assert.equal(wantsKeepAdding(""), false);
}

{
  // Registro de horas.
  assert.equal(isHoursIntent("Quiero registrar mis horas"), true);
  assert.equal(isHoursIntent("reporte de horas"), true);
  assert.equal(isHoursIntent("¿Cuántas horas tiene la etapa?"), false);
  assert.equal(isHoursIntent(""), false);
}

{
  // Saludo corto.
  assert.equal(isGreetingOrSmallTalk("¡Hola!"), true);
  assert.equal(isGreetingOrSmallTalk("Buenos días"), true);
  assert.equal(isGreetingOrSmallTalk("Hola, mi empresa fabrica muebles de madera"), false);
  assert.equal(isGreetingOrSmallTalk(""), false);
}

{
  // Pregunta en E1. normalizeText quita el "?", así que la rama endsWith("?") nunca se cumple:
  // una pregunta sin palabras clave da false.
  assert.equal(isProdQuestion("¿Cómo calculo la productividad?"), true);
  assert.equal(isProdQuestion("dame un ejemplo"), true);
  assert.equal(isProdQuestion("¿Qué es esto?"), false);
  assert.equal(isProdQuestion("500 unidades al mes"), false);
  assert.equal(isProdQuestion(""), false);
}

{
  // Listo / confirmar. "ok" es listo pero no confirmación.
  assert.equal(isReadyIntent("OK"), true);
  assert.equal(isReadyIntent("Sí"), true);
  assert.equal(isReadyIntent("continuemos por favor"), true);
  assert.equal(isReadyIntent("no"), false);
  assert.equal(isReadyIntent(""), false);

  assert.equal(isConfirmIntent("Sí, confirmo"), true);
  assert.equal(isConfirmIntent("de acuerdo"), true);
  assert.equal(isConfirmIntent("ok"), false);
  assert.equal(isConfirmIntent("no"), false);
}

{
  // Cierre de E6 y E9.
  assert.equal(looksLikeObjectivesClosureRequest("Ya terminé mis objetivos"), true);
  assert.equal(looksLikeObjectivesClosureRequest("Pasemos"), true);
  assert.equal(looksLikeObjectivesClosureRequest("tengo una duda"), false);
  assert.equal(looksLikeObjectivesClosureRequest(""), false);

  assert.equal(looksLikeProgressClosureRequest("¿Podemos pasar a la etapa 10?"), true);
  assert.equal(looksLikeProgressClosureRequest("sigamos"), true);
  assert.equal(looksLikeProgressClosureRequest(""), false);
}

{
  // E6: "qué sigue" y validar ya. Si el mensaje trae contenido académico, no es una pregunta
  // de siguiente paso.
  assert.equal(looksLikeStage6NextStepQuestion("¿Qué sigue?"), true);
  assert.equal(looksLikeStage6NextStepQuestion("Pasemos, mi objetivo es reducir mermas"), false);
  assert.equal(looksLikeStage6NextStepQuestion(""), false);

  assert.equal(wantsStage6ValidationNow("valida"), true);
  assert.equal(wantsStage6ValidationNow("Sí"), true);
  assert.equal(wantsStage6ValidationNow("tengo una pregunta"), false);
  assert.equal(wantsStage6ValidationNow(""), false);
}

{
  // "¿Por qué no avanzo?" sobre la barra de progreso.
  assert.equal(looksLikeAdvisorProgressStatusQuestion("¿Por qué la barra sigue en la etapa 5?"), true);
  assert.equal(looksLikeAdvisorProgressStatusQuestion("en qué etapa estoy"), true);
  assert.equal(looksLikeAdvisorProgressStatusQuestion("la etapa 5 es sobre pareto"), false);
  assert.equal(looksLikeAdvisorProgressStatusQuestion(""), false);
}

console.log("advisorClientIntent tests passed");
