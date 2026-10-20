import assert from "node:assert/strict";

import {
  assessStage0Value,
  findCompanyNames,
  findInvalidStage0Fields,
  groundStage0Value,
  validateStage0Extraction,
  type Stage0ValueRejection,
} from "./stage0Values";
import { extractStage0Deterministic } from "./stage0Context";
import { readStudentMessage, type StudentMessageActs } from "./studentMessageActs";

// Lectura de actos del mensaje (studentMessageActs.ts, común a las etapas) y control de calidad de
// los datos de E0 (stage0Values.ts), el mismo en el navegador y en el servidor.

type ActName = keyof StudentMessageActs;
const actsOf = (text: string) =>
  Object.entries(readStudentMessage(text).acts)
    .filter(([, value]) => value)
    .map(([name, value]) => (value === true ? name : `${name}=${value}`))
    .sort();
const contentOf = (text: string) => readStudentMessage(text).content.replace(/[\s,¿?]+/g, " ").trim();

{
  // Qué hace el mensaje y qué queda como dato afirmado.
  const cases: Array<[string, string[], string]> = [
    ["Panadería", [], "Panadería"],
    ["Eso es confidencial", ["refusal"], ""],
    ["Prefiero no decirlo", ["refusal"], ""],
    ["No puedo decir el nombre, pero es una panadería", ["refusal"], "es una panadería"],
    ["Todavía no lo decido", ["deferral"], ""],
    ["Lo estoy pensando", ["deferral"], ""],
    ["Luego te digo", ["deferral"], ""],
    ["El que tú me recomiendes", ["delegation=advisor"], ""],
    ["Cualquiera", ["delegation=advisor"], ""],
    ["Pregúntale a mi supervisor", ["delegation=third_party"], ""],
    ["Muchos, depende de la temporada", ["vague"], ""],
    ["Ninguno en especial", ["vague"], ""],
    ["Donde hay más problemas", ["vague"], ""],
    ["Quiero cambiar de empresa", ["contextChange"], ""],
    ["No sé", ["uncertain"], ""],
    ["No sé, creo que es comercio", ["hedged", "uncertain"], "es comercio"],
    ["Sí, creo que almacén pero no estoy seguro todavía", ["agrees", "hedged", "uncertain"], "almacén"],
    ["No es una fábrica, es un restaurante", ["negation"], "es un restaurante"],
    ["Vendemos ropa pero no la fabricamos", ["negation"], "Vendemos ropa"],
    ["Leche, no yogur", ["negation"], "Leche"],
    ["Perdón, no era yogur sino queso", ["correction", "negation"], "queso"],
    ["Me equivoqué, el rubro es textil", ["correction"], "el rubro es textil"],
    ["No, mejor cambiemos el producto", ["correction", "disagrees"], "cambiemos el producto"],
    ["No está bien el producto", ["correction"], "el producto"],
    ["Ya te dije, yogur", [], "yogur"],
    ["Mi supervisor dice que somos del rubro metalmecánico", [], "somos del rubro metalmecánico"],
    ["No, déjalo así", ["cancel", "disagrees"], ""],
    // "no" que no niega: un adjetivo en plural y la duda con tilde.
    ["Bebidas no alcohólicas", [], "Bebidas no alcohólicas"],
    ["No se vende al por mayor", ["negation"], ""],
  ];
  for (const [text, acts, content] of cases) {
    assert.deepEqual(actsOf(text), [...acts].sort(), `actos: ${text}`);
    assert.equal(contentOf(text), content, `contenido: ${text}`);
  }
  // Lo negado se devuelve aparte, tal como se escribió.
  assert.deepEqual(readStudentMessage("Perdón, no era yogur sino queso").negated, ["no era yogur"]);
  // El contenido conserva las posiciones del mensaje.
  for (const text of ["No es una fábrica, es un restaurante", "Ya te dije, yogur"]) {
    assert.equal(readStudentMessage(text).content.length, text.normalize("NFC").length, text);
  }
  const _unused: ActName = "refusal";
  void _unused;
}

{
  // Valores que sí son datos del caso.
  const good: Array<["sector" | "products" | "process_focus", string]> = [
    ["sector", "Panadería"], ["sector", "Alimentos y bebidas"], ["sector", "Metalmecánico"], ["sector", "Servicios"],
    ["sector", "Fábrica de muebles"], ["sector", "Comercio minorista"], ["sector", "Seguridad privada"], ["sector", "Servicios TI"],
    ["products", "Yogur bebible"], ["products", "Pan de molde"], ["products", "Servicio de mantenimiento de equipos"],
    ["products", "Bebidas no alcohólicas"], ["products", "Té verde"], ["products", "Préstamos"], ["products", "Ramos de flores"],
    ["products", "PRENDAS DE VESTIR"], ["process_focus", "Producción"], ["process_focus", "Atención al cliente"],
    ["process_focus", "Control de calidad ISO"], ["process_focus", "Reclamos"],
  ];
  for (const [field, value] of good) assert.equal(assessStage0Value(field, value), null, `${field}: ${value}`);

  // Valores que no lo son, con su motivo.
  const bad: Array<["sector" | "products" | "process_focus", string, Stage0ValueRejection]> = [
    ["sector", "Confidencial", "refusal"],
    ["sector", "No decirlo", "negation"],
    ["process_focus", "Todavía no lo decido", "negation"],
    ["process_focus", "Recomiendes", "dialogue"],
    ["process_focus", "Equivoqué", "dialogue"],
    ["products", "Te dije", "dialogue"],
    ["products", "Ninguno en especial", "negation"],
    ["products", "Depende de la temporada", "vague"],
    ["products", "Muchos", "vague"],
    ["sector", "Supervisor dice que somos", "dialogue"],
    ["process_focus", "Mejor cambiemos el producto", "dialogue"],
    ["process_focus", "Yogur sino queso", "clause"],
    ["products", "Ropa pero no", "negation"],
    ["process_focus", "Donde hay más problemas", "clause"],
    ["sector", "ACME Lácteos", "company_name"],
    ["sector", "Distribuidora Norte S.R.L.", "company_name"],
    ["products", "Hnos & Cía", "company_name"],
    ["sector", "Mi jefe", "dialogue"],
    ["sector", "El encargado", "person"],
    ["sector", "A", "empty"],
    ["products", "Productos", "empty"],
    ["sector", "Una empresa que tiene muchos trabajadores en planta de producción", "too_long"],
  ];
  for (const [field, value, reason] of bad) assert.equal(assessStage0Value(field, value), reason, `${field}: ${value}`);
}

{
  // Nombres de empresas o marcas en el mensaje del estudiante.
  const named = (text: string) => findCompanyNames(text).map(([s, e]) => text.slice(s, e));
  // ¿Algún tramo marcado cubre el nombre? (los tramos pueden solaparse: la sigla y el nombre entero).
  const covers = (text: string, name: string) => named(text).some((span) => span.includes(name));
  assert.deepEqual(named("Hago mi práctica en Industrias Sol"), ["Industrias Sol"]);
  assert.ok(covers("Trabajo en ACME Lácteos, que hace lácteos", "ACME Lácteos"));
  assert.ok(!named("Trabajo en ACME Lácteos, que hace lácteos").some((span) => span.includes("hace")));
  assert.deepEqual(named("La empresa se llama Panificadora, hace pan"), ["Panificadora"]);
  assert.ok(covers("Somos Distribuidora Norte SRL", "Distribuidora Norte SRL"));
  assert.ok(covers("Trabajo en Comercial Andina Ltda.", "Comercial Andina Ltda"));
  assert.ok(covers("Lácteos Andinos fabrica yogur", "Lácteos Andinos"));
  // Sin nombres: mayúscula al comienzo de la oración, un sustantivo con mayúscula suelto, todo en
  // mayúsculas, escritura en título y siglas del oficio.
  for (const text of [
    "Es una panadería", "Panadería. Vendemos pan", "Vendemos Yogur", "PRENDAS DE VESTIR", "Productos De Limpieza",
    "Vendemos Yogur Bebible Y Queso Fresco", "Trabajamos con normas ISO y BPM",
  ]) {
    assert.deepEqual(named(text), [], text);
  }
  // Con el mensaje, un valor que repite una palabra que solo aparece en el nombre no pasa; una que
  // también se dice fuera del nombre, sí.
  assert.equal(assessStage0Value("sector", "Industria", { source: "Hago mi práctica en Industrias Sol" }), "company_name");
  // "Una panadería llamada …": queda la actividad, sin el nombre.
  assert.equal(extractStage0Deterministic("Es una panadería llamada San Juan", 1).sector, "Panadería");
  assert.equal(extractStage0Deterministic("Es una panadería que se llama Delicias", 1).sector, "Panadería");
  assert.equal(assessStage0Value("products", "Lácteos", { source: "Trabajo en ACME Lácteos, que hace lácteos" }), null);
}

{
  // Palabras enteras del mensaje: por la raíz o una letra de diferencia, nunca por el comienzo.
  assert.equal(groundStage0Value("Polera", "Fabricamos poleras"), true);
  assert.equal(groundStage0Value("yogur", "Hacemos yogurt"), true);
  assert.equal(groundStage0Value("Producción", "quiero analizar produccion"), true);
  assert.equal(groundStage0Value("Pan", "Somos una panadería"), false, "antes pasaba por el prefijo");
  assert.equal(groundStage0Value("Producción", "Producimos muebles"), false);
  assert.equal(groundStage0Value("Atención al cliente", "atiende a los vecinos"), false);
  assert.equal(groundStage0Value("Queso fresco artesanal", "vendemos queso fresco"), false, "cada palabra cuenta");
}

{
  // La lectura de Gemini, validada: deducciones, nombres y lo negado no pasan; el rubro sí se deduce.
  const check = (values: Record<string, unknown>, text: string) => validateStage0Extraction(values, text);
  assert.deepEqual(
    check({ sector: "Alimentos", products: ["Pan"], process_focus: ["Atención al cliente"] }, "Somos una panadería del barrio que atiende a los vecinos"),
    {
      values: { sector: "Alimentos", products: undefined, process_focus: undefined },
      rejected: [
        { field: "products", reason: "ungrounded" },
        { field: "process_focus", reason: "ungrounded" },
      ],
    }
  );
  assert.deepEqual(check({ sector: "ACME Lácteos", products: ["Lácteos"] }, "Trabajo en ACME Lácteos, que hace lácteos").values, {
    sector: undefined,
    products: ["Lácteos"],
    process_focus: undefined,
  });
  assert.deepEqual(check({ sector: "Fábrica", products: ["Muebles"] }, "No es una fábrica de muebles, es un restaurante"), {
    values: { sector: undefined, products: undefined, process_focus: undefined },
    rejected: [
      { field: "sector", reason: "negation" },
      { field: "products", reason: "ungrounded" },
    ],
  });
  assert.deepEqual(check({ sector: "Restaurante" }, "No es una fábrica, es un restaurante").values.sector, "Restaurante");
  assert.deepEqual(check({ products: ["Leche"] }, "No es yogur, es leche").values.products, ["Leche"]);
  assert.deepEqual(check({ products: ["Yogur"] }, "No es yogur, es leche").values.products, undefined);
}

{
  // Para el servidor: lo que llega en context_json. Un campo vacío es un dato pendiente.
  assert.deepEqual(findInvalidStage0Fields({ sector: "Panadería", products: ["Pan"], process_focus: ["Producción"] }), []);
  assert.deepEqual(findInvalidStage0Fields({ sector: "", products: [], process_focus: [] }), []);
  assert.deepEqual(findInvalidStage0Fields({ stage: "ETAPA_0" }), []);
  assert.deepEqual(findInvalidStage0Fields({ sector: "Confidencial" }), [{ field: "sector", reason: "refusal" }]);
  assert.deepEqual(findInvalidStage0Fields({ products: ["Pan", "Te dije"] }), [{ field: "products", reason: "dialogue" }]);
  assert.deepEqual(findInvalidStage0Fields({ process_focus: "Todavía no lo decido" }), [{ field: "process_focus", reason: "negation" }]);
  assert.deepEqual(findInvalidStage0Fields({ products: [3] }), [{ field: "products", reason: "empty" }]);
}

console.log("stage0Values tests passed");
