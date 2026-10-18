import assert from "node:assert/strict";

import { MAX_WHY_DEPTH, MIN_WHY_DEPTH } from "./rootCauseLimits";
import {
  HINT_REFORMULATE,
  decideWhyStep,
  evaluateWhyDeterministic,
  interpretLlmActionabilityResponse,
  type DeterministicVerdict,
  type LlmActionabilityVerdict,
} from "./whyQuality";

const closable: DeterministicVerdict = { closable: true };
const actionable: LlmActionabilityVerdict = {
  actionable: true,
  reason: "Se puede corregir con un procedimiento de revisión.",
};
const notActionable: LlmActionabilityVerdict = {
  actionable: false,
  reason: "Describe un síntoma; falta decir qué falla dentro de la empresa.",
};

function reasonOf(verdict: DeterministicVerdict) {
  return verdict.closable ? "closable" : verdict.reason;
}

function evaluate(why: string, subCauseText: string, previousWhys: string[] = []) {
  return reasonOf(evaluateWhyDeterministic({ why, subCauseText, previousWhys }));
}

{
  // Profundidad variable entre 3 y 5 (CLAUDE.md).
  assert.equal(MIN_WHY_DEPTH, 3);
  assert.equal(MAX_WHY_DEPTH, 5);
}

{
  // depth 1 y 2 nunca cierran, aunque el veredicto diga accionable.
  for (const depth of [1, 2]) {
    assert.deepEqual(
      decideWhyStep({ depth, deterministic: closable, llmVerdict: actionable }),
      { action: "ask_next" }
    );
    assert.deepEqual(decideWhyStep({ depth, deterministic: closable }), { action: "ask_next" });
  }
}

{
  // Antes del mínimo el determinista informa con su pista, aunque nunca cierre.
  const tautology = evaluateWhyDeterministic({
    why: "Hay demoras en el despacho",
    subCauseText: "Demoras en el despacho de pedidos",
    previousWhys: [],
  });
  assert.ok(!tautology.closable);
  assert.deepEqual(decideWhyStep({ depth: 2, deterministic: tautology }), {
    action: "ask_next",
    hint: tautology.hint,
  });

  // Con determinista closable, ask_next sin pista.
  assert.deepEqual(decideWhyStep({ depth: 2, deterministic: closable }), { action: "ask_next" });
}

{
  // depth 3 con determinista closable y sin veredicto -> se consulta la calidad.
  assert.deepEqual(decideWhyStep({ depth: 3, deterministic: closable }), {
    action: "consult_quality",
  });
}

{
  // depth 3 con tautología -> ask_next con su hint; no se gasta la llamada al LLM.
  const deterministic = evaluateWhyDeterministic({
    why: "Hay demoras en el despacho",
    subCauseText: "Demoras en el despacho de pedidos",
    previousWhys: [],
  });
  assert.equal(reasonOf(deterministic), "tautology");

  const decision = decideWhyStep({ depth: 3, deterministic });
  assert.equal(decision.action, "ask_next");
  assert.ok(decision.action === "ask_next" && Boolean(decision.hint));
}

{
  // Entre el mínimo y el tope manda el veredicto del LLM.
  assert.deepEqual(
    decideWhyStep({ depth: 4, deterministic: closable, llmVerdict: actionable }),
    { action: "close" }
  );
  assert.deepEqual(
    decideWhyStep({ depth: 3, deterministic: closable, llmVerdict: notActionable }),
    { action: "ask_next", hint: notActionable.reason }
  );

  // Fallo del LLM (null) antes del tope: se sigue preguntando, nunca se cierra.
  assert.deepEqual(decideWhyStep({ depth: 4, deterministic: closable, llmVerdict: null }), {
    action: "ask_next",
  });

  // El determinista bloqueado manda aunque el LLM diga accionable.
  const generic = evaluateWhyDeterministic({
    why: "Mala gestión",
    subCauseText: "Errores en el conteo de inventario",
    previousWhys: [],
  });
  assert.equal(
    decideWhyStep({ depth: 4, deterministic: generic, llmVerdict: actionable }).action,
    "ask_next"
  );
}

{
  // depth 5 (tope) con determinista closable: sin veredicto se consulta la calidad.
  assert.deepEqual(decideWhyStep({ depth: 5, deterministic: closable }), {
    action: "consult_quality",
  });
  assert.deepEqual(decideWhyStep({ depth: 5, deterministic: closable, llmVerdict: null }), {
    action: "reformulate",
    hint: HINT_REFORMULATE,
  });
  assert.deepEqual(
    decideWhyStep({ depth: 5, deterministic: closable, llmVerdict: notActionable }),
    { action: "reformulate", hint: notActionable.reason }
  );
  assert.deepEqual(
    decideWhyStep({ depth: 5, deterministic: closable, llmVerdict: actionable }),
    { action: "close" }
  );

  // Determinista bloqueado en el tope: reformulate con su pista, sin pasar por
  // consult_quality y aunque el LLM dijera accionable.
  const generic = evaluateWhyDeterministic({
    why: "Mala gestión",
    subCauseText: "Errores en el conteo de inventario",
    previousWhys: [],
  });
  assert.ok(!generic.closable);
  for (const llmVerdict of [undefined, actionable]) {
    assert.deepEqual(decideWhyStep({ depth: 5, deterministic: generic, llmVerdict }), {
      action: "reformulate",
      hint: generic.hint,
    });
  }

  // Más allá del tope rige la misma lógica.
  assert.deepEqual(decideWhyStep({ depth: 6, deterministic: closable }), {
    action: "consult_quality",
  });
  assert.deepEqual(decideWhyStep({ depth: 6, deterministic: closable, llmVerdict: null }), {
    action: "reformulate",
    hint: HINT_REFORMULATE,
  });
}

{
  // Regla dura: sin veredicto accionable explícito no hay "close" en ninguna profundidad.
  for (let depth = 1; depth <= 6; depth += 1) {
    for (const llmVerdict of [undefined, null, notActionable]) {
      assert.notEqual(decideWhyStep({ depth, deterministic: closable, llmVerdict }).action, "close");
    }
  }
}

{
  // Tautología contra la subcausa y contra un porqué anterior.
  assert.equal(evaluate("Hay demoras en el despacho", "Demoras en el despacho de pedidos"), "tautology");
  assert.equal(
    evaluate("Porque no se revisa el stock", "Pedidos aceptados sin mercadería disponible", [
      "No se revisa el stock antes de aceptar pedidos",
    ]),
    "tautology"
  );

  // Profundizar reutilizando palabras del porqué anterior no es tautología.
  assert.equal(
    evaluate(
      "No existe un procedimiento que asigne quién revisa el stock",
      "Pedidos aceptados sin mercadería disponible",
      ["No se revisa el stock antes de aceptar pedidos"]
    ),
    "closable"
  );
}

{
  // Generalidades sin objeto concreto.
  for (const why of ["Mala gestión", "Falta de organización", "Poco control", "Descuido", "No hay"]) {
    assert.equal(evaluate(why, "Errores en el conteo de inventario"), "too_generic");
  }

  // Con objeto concreto ya no es genérica.
  assert.equal(
    evaluate("Falta de control del stock de insumos en el almacén", "Errores en el conteo de inventario"),
    "closable"
  );
  assert.equal(
    evaluate("Falta de capacitación en el uso de la balanza", "Errores en el pesaje de lotes"),
    "closable"
  );
}

{
  // Solo externo: el agente está fuera de la empresa y no aparece ningún mecanismo interno.
  assert.equal(
    evaluate("El proveedor entrega tarde los insumos", "Paradas de línea por falta de insumos"),
    "external_only"
  );
  assert.equal(
    evaluate("Los clientes cambian sus pedidos a última hora", "Reprogramación constante de la producción"),
    "external_only"
  );

  // Con un mecanismo o actor interno ya no es "solo externo".
  assert.equal(
    evaluate("No se evalúa a los proveedores antes de comprarles", "Paradas de línea por falta de insumos"),
    "closable"
  );
  assert.equal(
    evaluate("El personal de ventas no confirma los pedidos con el cliente", "Pedidos despachados con errores"),
    "closable"
  );
}

{
  // Respuestas del LLM válidas.
  assert.deepEqual(
    interpretLlmActionabilityResponse('{"actionable": true, "reason": "Se puede estandarizar."}'),
    { actionable: true, reason: "Se puede estandarizar." }
  );
  assert.deepEqual(
    interpretLlmActionabilityResponse('```json\n{"actionable": false, "reason": "Es un síntoma."}\n```'),
    { actionable: false, reason: "Es un síntoma." }
  );
  assert.deepEqual(
    interpretLlmActionabilityResponse('Claro: {"actionable": false, "reason": "Falta objeto."}'),
    { actionable: false, reason: "Falta objeto." }
  );
  assert.deepEqual(interpretLlmActionabilityResponse({ actionable: true, reason: "Ok" }), {
    actionable: true,
    reason: "Ok",
  });

  // Inválidas o vacías -> null, sin lanzar.
  assert.equal(interpretLlmActionabilityResponse("esto no es JSON"), null);
  assert.equal(interpretLlmActionabilityResponse('{"actionable": "sí", "reason": "x"}'), null);
  assert.equal(interpretLlmActionabilityResponse('{"actionable": true}'), null);
  assert.equal(interpretLlmActionabilityResponse(""), null);
  assert.equal(interpretLlmActionabilityResponse(null), null);
  assert.equal(interpretLlmActionabilityResponse(undefined), null);
}

console.log("whyQuality tests passed");
