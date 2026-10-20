import assert from "node:assert/strict";

import { createStage0PromptTracker, type Stage0PromptTracker } from "../../app/chat/_lib/stage0Opening";
import { handleStage0Turn, type Stage0TurnDeps } from "../../app/chat/_lib/turns/stage0Turn";
import type { PlanContextStatus } from "../../app/chat/_lib/turns/types";
import {
  classifyStage0DecisionIntent,
  detectStage0Intent,
  getNextStage0StepFromContext,
  readStage0Context,
  stage0QuestionFor,
  type EditTarget,
  type Stage0ContextJson,
  type Stage0DecisionIntent,
} from "./stage0Context";
import { findInvalidStage0Fields } from "./stage0Values";

// Corpus de regresión de la Etapa 0: los 42 mensajes de la auditoría conversacional (respuestas
// directas, largas, ambiguas, negaciones, dudas, ayudas y correcciones) y los 7 escenarios con
// Gemini equivocado, por el turno real (stage0Turn.ts) con Gemini simulado y una base en memoria que
// imita /api/plans/context y /api/plans/context/confirm. Cada caso se corre con Gemini caído y con
// un Gemini que acierta: en los dos se exige lo mismo (o, si Gemini no responde a un mensaje largo,
// no guardar nada). Ningún turno confirma E0 solo. Después: revisión y confirmación, recarga y
// concurrencia entre pestañas. Sin red ni Supabase real.

const CHAT = "c0000000-0000-4000-8000-000000000001";

type Db = { status: "draft" | "confirmed"; contextJson: Stage0ContextJson };
type Gemini = (step: number, text: string) => Record<string, unknown> | null | "error";

function createDb(context: Stage0ContextJson = {}): Db {
  return { status: "draft", contextJson: { stage: "ETAPA_0", ...context } };
}

// Una pestaña del chat: su propio registro de preguntas y resúmenes vistos, la base compartida.
function createTab(db: Db, opts: { gemini?: Gemini; prompted?: boolean; tracker?: Stage0PromptTracker } = {}) {
  const tracker = opts.tracker ?? createStage0PromptTracker();
  if (opts.prompted !== false) tracker.markPrompted(CHAT);
  const log = {
    replies: [] as string[],
    saves: [] as Stage0ContextJson[],
    interpretCalls: 0,
    confirms: [] as Stage0ContextJson[],
    awaiting: [] as boolean[],
  };
  let editing: EditTarget = null;
  // Lo que la pestaña tiene en caché (puede quedar viejo si otra pestaña escribe).
  let cached: PlanContextStatus | null = null;

  const status = (): PlanContextStatus => ({
    ok: true,
    status: db.status,
    exists: true,
    chatId: CHAT,
    contextJson: { ...db.contextJson },
    contextText: null,
  });

  const deps = (): Stage0TurnDeps => ({
    chatId: () => CHAT,
    greetingName: "Ana",
    editingField: editing,
    setEditingField: (field) => {
      editing = field;
    },
    setStage0Draft: () => undefined,
    setAwaitingStage1Start: (value) => {
      log.awaiting.push(value);
    },
    tracker,
    appendAssistant: async (text) => {
      log.replies.push(text);
    },
    interpret: async (step, text) => {
      log.interpretCalls += 1;
      const out = opts.gemini ? opts.gemini(step, text) : "error";
      if (out === "error") return { ok: false, payload: null };
      return { ok: true, payload: out };
    },
    saveDraft: async (extracted) => {
      log.saves.push(extracted);
      const invalid = findInvalidStage0Fields(extracted as Record<string, unknown>);
      if (invalid.length) return { ok: false, payload: { code: "INVALID_CONTEXT_VALUE", message: "dato inválido" } };
      const incoming = Object.fromEntries(Object.entries(extracted).filter(([, value]) => value !== undefined));
      db.contextJson = { ...db.contextJson, ...incoming, stage: "ETAPA_0" };
      return { ok: true, payload: { chatId: CHAT } };
    },
    confirm: async (reviewed) => {
      log.confirms.push(reviewed);
      const merged = { ...db.contextJson, ...reviewed };
      if (getNextStage0StepFromContext(merged) !== 0 || findInvalidStage0Fields(merged).length) {
        return { ok: false, payload: { message: "Revisa el contexto antes de registrarlo." } };
      }
      db.contextJson = merged;
      db.status = "confirmed";
      return { ok: true, payload: { chatId: CHAT, contextJson: db.contextJson } };
    },
    refreshContext: async () => status(),
    cacheContext: (data) => {
      cached = data;
    },
  });

  const send = async (text: string) => {
    const before = log.replies.length;
    assert.equal(await handleStage0Turn(deps(), { text, ctx: cached ?? status() }), true, text);
    assert.equal(log.replies.length, before + 1, `una sola respuesta: ${text}`);
    return log.replies[log.replies.length - 1];
  };

  return { tracker, log, send, editing: () => editing };
}

const lower = (value: string) => value.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "");
// Lo guardado en el turno, sin claves vacías y sin importar mayúsculas ni tildes.
function savedOf(saves: Stage0ContextJson[]): Stage0ContextJson | null {
  if (!saves.length) return null;
  const out: Stage0ContextJson = {};
  for (const save of saves) {
    if (save.sector) out.sector = lower(save.sector);
    if (save.products?.length) out.products = save.products.map(lower);
    if (save.process_focus?.length) out.process_focus = save.process_focus.map(lower);
  }
  return out;
}
function folded(value: Stage0ContextJson | null) {
  if (!value) return null;
  return savedOf([value]);
}

const ALI: Stage0ContextJson = { sector: "Alimentos" };
const ALI_Y: Stage0ContextJson = { sector: "Alimentos", products: ["Yogur"] };

type Case = {
  id: number;
  ctx: Stage0ContextJson;
  text: string;
  intent: Stage0DecisionIntent;
  save: Stage0ContextJson | null;
  // Mensaje largo: si Gemini no responde, no se guarda nada (se pide resumirlo).
  needsGemini?: boolean;
  // Campo que queda en edición (correcciones sin el valor nuevo).
  editing?: EditTarget;
  reply?: RegExp;
};

const CASES: Case[] = [
  // ---- Paso 1: rubro ----
  { id: 1, ctx: {}, text: "Panadería", intent: "answer", save: { sector: "Panadería" } },
  { id: 2, ctx: {}, text: "Es una panadería", intent: "answer", save: { sector: "Panadería" } },
  { id: 3, ctx: {}, text: "Alimentos y bebidas", intent: "answer", save: { sector: "Alimentos y bebidas" } },
  { id: 4, ctx: {}, text: "Fabricamos yogur y queso", intent: "answer", save: { products: ["Yogur", "Queso"] } },
  { id: 5, ctx: {}, text: "Mi supervisor dice que somos del rubro metalmecánico", intent: "answer", save: { sector: "Metalmecánico" } },
  {
    id: 6,
    ctx: {},
    text: "La empresa donde hago mi práctica se dedica a la fabricación de muebles de melamina para oficinas y hogares",
    intent: "answer",
    save: { sector: "Muebles", products: ["Muebles de melamina"] },
    needsGemini: true,
  },
  {
    id: 7,
    ctx: {},
    text: "Es una empresa textil que fabrica poleras y quiero analizar producción",
    intent: "answer",
    save: { sector: "Textil", products: ["Poleras"], process_focus: ["Producción"] },
    needsGemini: true,
  },
  { id: 8, ctx: {}, text: "Es una empresa familiar", intent: "answer", save: null },
  { id: 9, ctx: {}, text: "Eso es confidencial", intent: "refusal", save: null, reply: /no necesito el nombre de la empresa ni información confidencial/i },
  { id: 10, ctx: {}, text: "Prefiero no decirlo", intent: "refusal", save: null, reply: /no necesito el nombre de la empresa/i },
  { id: 11, ctx: {}, text: "Pregúntale a mi supervisor", intent: "third_party", save: null, reply: /No puedo comunicarme con la persona que te supervisa/ },
  { id: 12, ctx: {}, text: "No sé", intent: "unknown", save: null },
  { id: 13, ctx: {}, text: "No sé, creo que es comercio", intent: "answer", save: { sector: "Comercio" }, reply: /provisional/ },
  { id: 14, ctx: {}, text: "¿Qué es un rubro?", intent: "help_request", save: null },
  { id: 15, ctx: {}, text: "Dame un ejemplo", intent: "example_request", save: null },
  { id: 16, ctx: {}, text: "¿Por qué necesitas saber eso?", intent: "meta_process", save: null },
  { id: 17, ctx: {}, text: "Hola", intent: "greeting", save: null },
  { id: 18, ctx: {}, text: "ok", intent: "confirm", save: null },
  { id: 19, ctx: {}, text: "No es una fábrica, es un restaurante", intent: "answer", save: { sector: "Restaurante" } },
  { id: 20, ctx: {}, text: "La empresa no es de alimentos, es de construcción", intent: "answer", save: { sector: "Construcción" } },
  { id: 21, ctx: {}, text: "No fabricamos nada, solo vendemos ropa", intent: "answer", save: { products: ["Ropa"] } },
  { id: 22, ctx: {}, text: "Vendemos ropa pero no la fabricamos", intent: "answer", save: { products: ["Ropa"] } },
  // ---- Paso 2: producto ----
  { id: 23, ctx: ALI, text: "Yogur, queso y mantequilla", intent: "answer", save: { products: ["Yogur", "Queso", "Mantequilla"] } },
  { id: 24, ctx: ALI, text: "El producto principal es el yogur bebible", intent: "answer", save: { products: ["Yogur bebible"] } },
  { id: 25, ctx: ALI, text: "No sé cuál es el producto principal", intent: "unknown", save: null },
  { id: 26, ctx: ALI, text: "Muchos, depende de la temporada", intent: "vague", save: null, reply: /quédate con lo que más se vende/ },
  { id: 27, ctx: ALI, text: "Ya te dije, yogur", intent: "answer", save: { products: ["Yogur"] } },
  { id: 28, ctx: ALI, text: "No es yogur, es leche", intent: "answer", save: { products: ["Leche"] } },
  { id: 29, ctx: ALI, text: "¿Puede ser el servicio de delivery?", intent: "answer", save: { products: ["Servicio de delivery"] }, reply: /provisional/ },
  { id: 30, ctx: ALI, text: "Ninguno en especial", intent: "vague", save: null },
  // ---- Paso 3: área ----
  { id: 31, ctx: ALI_Y, text: "Producción", intent: "answer", save: { process_focus: ["Producción"] }, reply: /¿Lo registro así\?/ },
  { id: 32, ctx: ALI_Y, text: "Quiero analizar el área de despacho", intent: "answer", save: { process_focus: ["Despacho"] } },
  { id: 33, ctx: ALI_Y, text: "En producción y también en almacén", intent: "answer", save: { process_focus: ["Producción", "Almacén"] } },
  { id: 34, ctx: ALI_Y, text: "Todavía no lo decido", intent: "deferral", save: null, reply: /Está bien tomarse un momento/ },
  { id: 35, ctx: ALI_Y, text: "Donde hay más problemas", intent: "vague", save: null },
  { id: 36, ctx: ALI_Y, text: "El que tú me recomiendes", intent: "delegation", save: null, reply: /Esa decisión es tuya/ },
  { id: 37, ctx: ALI_Y, text: "¿Qué significa área de intervención?", intent: "help_request", save: null },
  // ---- Correcciones ----
  { id: 38, ctx: ALI_Y, text: "Me equivoqué, el rubro es textil", intent: "correction", save: { sector: "Textil" }, reply: /^Actualicé el rubro: \*\*Textil\*\*\./ },
  { id: 39, ctx: ALI_Y, text: "Quiero cambiar el rubro a textil", intent: "correction", save: { sector: "Textil" } },
  { id: 40, ctx: ALI_Y, text: "No, mejor cambiemos el producto", intent: "correction", save: null, editing: "products" },
  { id: 41, ctx: ALI_Y, text: "Perdón, no era yogur sino queso", intent: "correction", save: { products: ["Queso"] } },
  { id: 42, ctx: ALI_Y, text: "Quiero cambiar de empresa", intent: "context_change", save: null, editing: "sector" },
];

// Gemini que acierta: devuelve lo esperado del caso (o nada, si el caso no guarda).
function oracle(c: Case): Gemini {
  return () =>
    c.save
      ? { intent: "ANSWER", ...c.save, confidence: 0.9, needsClarification: false }
      : { intent: "QUESTION", confidence: 0.3, needsClarification: true };
}

async function runCorpus() {
  let geminiTurns = 0;
  for (const c of CASES) {
    assert.equal(classifyStage0DecisionIntent(c.text, detectStage0Intent(c.text)), c.intent, `#${c.id} intención: ${c.text}`);

    for (const mode of ["sin Gemini", "Gemini acierta"] as const) {
      const db = createDb(c.ctx);
      const tab = createTab(db, { gemini: mode === "sin Gemini" ? () => "error" : oracle(c) });
      const reply = await tab.send(c.text);
      const label = `#${c.id} (${mode}) «${c.text}»`;

      const expected = mode === "sin Gemini" && c.needsGemini ? null : c.save;
      assert.deepEqual(savedOf(tab.log.saves), folded(expected), `${label}: guardado\n${reply}`);
      // Ningún mensaje confirma E0 por sí solo.
      assert.deepEqual(tab.log.confirms, [], `${label}: no confirma`);
      assert.equal(db.status, "draft", label);
      if (c.editing !== undefined) assert.equal(tab.editing(), c.editing, `${label}: campo en edición`);
      if (c.reply && expected === c.save) assert.ok(c.reply.test(reply), `${label}: respuesta\n${reply}`);
      if (mode === "sin Gemini" && c.needsGemini) {
        assert.ok(reply.startsWith("Para no registrar algo equivocado"), `${label}: pide resumirlo\n${reply}`);
      }
      if (mode === "Gemini acierta" && tab.log.interpretCalls) geminiTurns += 1;
    }
  }
  // Gemini solo para lo que las reglas no resuelven (mensajes largos, varios datos o el rubro a
  // deducir de la actividad).
  assert.ok(geminiTurns <= 8, `turnos con Gemini: ${geminiTurns}`);
}

async function runGeminiMistakes() {
  // 7 escenarios en que Gemini se equivoca (los de la auditoría) y uno más con lo negado.
  type Mistake = { id: number; ctx: Stage0ContextJson; text: string; gemini: Gemini; save: Stage0ContextJson | null; check?: (reply: string) => void };
  const mistakes: Mistake[] = [
    {
      // Nombre propio sin dato: no se consulta a Gemini y se pide la actividad sin el nombre.
      id: 106,
      ctx: {},
      text: "Hago mi práctica en Industrias Sol",
      gemini: () => {
        throw new Error("un mensaje que solo nombra a la empresa no va a Gemini");
      },
      save: null,
      check: (reply) =>
        assert.ok(reply.startsWith("Por confidencialidad no registro nombres de empresas ni marcas, y tu mensaje parece incluir uno."), reply),
    },
    {
      // Gemini deduce un producto y un área que el estudiante no dijo: se guarda solo el rubro.
      id: 107,
      ctx: {},
      text: "Somos una panadería del barrio que atiende a los vecinos de la zona",
      gemini: () => ({ intent: "ANSWER", sector: "Alimentos", products: ["Pan"], process_focus: ["Atención al cliente"], confidence: 0.9, needsClarification: false }),
      save: { sector: "Alimentos" },
    },
    {
      // Respuesta corta: la resuelven las reglas; lo que deduciría Gemini no entra.
      id: 101,
      ctx: {},
      text: "Somos una panadería del barrio",
      gemini: () => ({ intent: "ANSWER", sector: "Alimentos", products: ["Pan"], process_focus: ["Producción"], confidence: 0.9, needsClarification: false }),
      save: { sector: "Panadería del barrio" },
    },
    {
      id: 102,
      ctx: {},
      text: "Hago mi práctica en una tienda",
      gemini: () => ({ intent: "ANSWER", sector: "Comercio minorista", products: ["Productos de consumo masivo"], confidence: 0.8, needsClarification: false }),
      save: { sector: "Tienda" },
    },
    {
      // Gemini devuelve el nombre de la empresa como rubro: se descarta; el producto dicho queda.
      id: 103,
      ctx: {},
      text: "Trabajo en ACME Lácteos, que hace lácteos",
      gemini: () => ({ intent: "ANSWER", sector: "ACME Lácteos", products: ["Lácteos"], confidence: 0.9, needsClarification: false }),
      save: { products: ["Lácteos"] },
      check: (reply) => {
        assert.ok(reply.includes(STAGE_ANONYMITY), reply);
        assert.ok(!reply.includes("ACME"), "el nombre no se repite");
      },
    },
    {
      // JSON inválido (la ruta responde un error): no se toma como una pregunta; se pide resumir.
      id: 104,
      ctx: ALI,
      text: "Hacemos yogur natural, de frutilla y también queso fresco para supermercados",
      gemini: () => "error",
      save: null,
      check: (reply) => assert.ok(reply.startsWith("Para no registrar algo equivocado"), reply),
    },
    {
      // Respuesta con duda: queda como provisional y en revisión; E0 no se confirma.
      id: 105,
      ctx: ALI_Y,
      text: "Sí, creo que almacén pero no estoy seguro todavía",
      gemini: () => ({ intent: "ANSWER", process_focus: ["Almacén"], confidence: 0.7, needsClarification: false }),
      save: { process_focus: ["Almacén"] },
      check: (reply) => {
        assert.ok(reply.includes("provisional"), reply);
        assert.ok(reply.includes("**¿Lo registro así?**"), reply);
      },
    },
    {
      // Gemini devuelve lo negado (mensaje largo, se le consulta): no se guarda.
      id: 108,
      ctx: {},
      text: "La empresa no es una fábrica de muebles, en realidad se dedica a preparar comida para eventos y ferias del barrio",
      gemini: () => ({ intent: "ANSWER", sector: "Fábrica de muebles", products: ["Muebles"], confidence: 0.9, needsClarification: false }),
      save: null,
      check: (reply) => assert.ok(reply.startsWith("Gracias. Todavía no logro identificar"), reply),
    },
  ];

  for (const m of mistakes) {
    const db = createDb(m.ctx);
    const tab = createTab(db, { gemini: m.gemini });
    const reply = await tab.send(m.text);
    assert.deepEqual(savedOf(tab.log.saves), folded(m.save), `#${m.id} «${m.text}»\n${reply}`);
    assert.deepEqual(tab.log.confirms, [], `#${m.id}: no confirma`);
    if (m.id === 107 || m.id === 103 || m.id === 108) assert.equal(tab.log.interpretCalls, 1, `#${m.id}: se consultó a Gemini`);
    m.check?.(reply);
  }

  {
    // Si el estudiante afirma el dato después de negar otro, lo afirmado vale y Gemini no hace falta.
    const db = createDb();
    const tab = createTab(db, {
      gemini: () => {
        throw new Error("no hace falta Gemini");
      },
    });
    await tab.send("La empresa no es una fábrica de muebles, en realidad es un restaurante");
    assert.deepEqual(savedOf(tab.log.saves), { sector: "restaurante" });
  }
  {
    // La actividad con el nombre al lado: se registra la actividad y se avisa que el nombre no.
    const db = createDb();
    const tab = createTab(db, { gemini: () => "error" });
    const reply = await tab.send("Es una panadería llamada San Juan");
    assert.deepEqual(savedOf(tab.log.saves), { sector: "panaderia" });
    assert.ok(reply.includes(STAGE_ANONYMITY) && !reply.includes("San Juan"), reply);
  }
}

const STAGE_ANONYMITY = "Por confidencialidad no registro nombres de empresas ni marcas.";
const COMPLETE: Stage0ContextJson = { sector: "Panadería", products: ["Pan", "Pasteles"], process_focus: ["Producción"] };

async function runReview() {
  {
    // Recorrido completo: borrador, resumen, "sí" y confirmación con los datos revisados.
    const db = createDb();
    const tab = createTab(db);
    await tab.send("Es una panadería");
    await tab.send("Pan y pasteles");
    const review = await tab.send("Producción");
    assert.ok(review.includes("**¿Lo registro así?**"), review);
    assert.equal(db.status, "draft");
    const done = await tab.send("Sí, está bien");
    assert.deepEqual(tab.log.confirms, [readStage0Context({ stage: "ETAPA_0", ...COMPLETE })]);
    assert.equal(db.status, "confirmed");
    assert.ok(done.startsWith("Registré el contexto de tu caso"), done);
    assert.deepEqual(tab.log.awaiting, [true]);
  }

  // En la revisión, nada que no sea un "sí" confirma.
  for (const text of [
    ...CASES.map((c) => c.text).filter((text) => text !== "ok"),
    "no", "No está bien", "Sí, pero cambia el producto", "creo que sí", "¿qué me falta?", "Queso", "tú decide",
  ]) {
    const db = createDb(COMPLETE);
    const tab = createTab(db, { gemini: () => "error" });
    await tab.send(text);
    assert.deepEqual(tab.log.confirms, [], `en revisión no confirma: ${text}`);
    assert.equal(db.status, "draft", text);
  }

  {
    // Corrección con el valor: cambia el dato, vuelve a mostrar el resumen y confirma lo nuevo.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    const updated = await tab.send("El producto es queso");
    assert.ok(updated.startsWith("Actualicé el producto o servicio: **Queso**."), updated);
    assert.ok(updated.includes("**¿Lo registro así?**"), updated);
    assert.deepEqual(db.contextJson.products, ["Queso"]);
    assert.equal(db.contextJson.sector, "Panadería", "los otros datos se conservan");
    await tab.send("correcto");
    assert.deepEqual(tab.log.confirms.map((c) => c.products), [["Queso"]]);
  }
  {
    // "No, mejor cambiemos el producto": pide el valor nuevo, lo guarda y vuelve al resumen.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    const ask = await tab.send("No, mejor cambiemos el producto");
    assert.ok(ask.endsWith(stage0QuestionFor(2)), ask);
    assert.equal(tab.editing(), "products");
    const review = await tab.send("Tortas");
    assert.ok(review.includes("- **Producto o servicio:** Tortas"), review);
    assert.ok(review.includes("**¿Lo registro así?**"), review);
    assert.deepEqual(tab.log.confirms, []);
  }
  {
    // Pidió cambiar un dato y desiste: queda como estaba, sin guardar; un "ok" mientras tanto no
    // dice que falte un dato.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    await tab.send("Quiero cambiar el producto");
    assert.equal(tab.editing(), "products");
    const okReply = await tab.send("ok");
    assert.ok(okReply.startsWith("Para actualizarlo necesito el dato nuevo."), okReply);
    const back = await tab.send("No, déjalo así");
    assert.ok(back.startsWith("Lo dejamos como estaba."), back);
    assert.ok(back.includes("**¿Lo registro así?**"), back);
    assert.equal(tab.editing(), null);
    assert.deepEqual(tab.log.saves, []);
    assert.deepEqual(db.contextJson.products, ["Pan", "Pasteles"]);
    assert.deepEqual(tab.log.confirms, []);
  }
  {
    // "No era pan sino tortas": reemplaza solo lo negado.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    await tab.send("Perdón, no era pan sino tortas");
    assert.deepEqual(db.contextJson.products, ["Tortas", "Pasteles"]);
  }
  {
    // Un valor suelto: no se sabe qué dato cambia; se pregunta.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    const reply = await tab.send("Queso");
    assert.ok(reply.startsWith("No me queda claro qué dato quieres cambiar."), reply);
    assert.deepEqual(tab.log.saves, []);
  }
  {
    // "Sí, pero el área es calidad": no confirma; cambia el área.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    await tab.send("Sí, pero el área es calidad");
    assert.deepEqual(db.contextJson.process_focus, ["Calidad"]);
    assert.deepEqual(tab.log.confirms, []);
  }
  {
    // Una pregunta en la revisión: se responde y se recuerda qué falta, sin confirmar.
    const db = createDb(COMPLETE);
    const tab = createTab(db);
    const reply = await tab.send("¿Qué significa área de intervención?");
    assert.ok(reply.startsWith("El **área o proceso**"), reply);
    assert.ok(reply.endsWith("responde «sí» para registrarlo así, o dime qué dato quieres cambiar."), reply);
  }
  {
    // Un valor viejo inválido en el borrador: el servidor no confirma y el estudiante lo corrige.
    const db = createDb({ ...COMPLETE, process_focus: ["Todavía no lo decido"] });
    const tab = createTab(db);
    const rejected = await tab.send("sí");
    assert.equal(rejected, "Revisa el contexto antes de registrarlo.");
    assert.equal(db.status, "draft");
    await tab.send("El área es producción");
    await tab.send("sí");
    assert.equal(db.status, "confirmed");
    assert.deepEqual(db.contextJson.process_focus, ["Producción"]);
  }
}

async function runReloadAndConcurrency() {
  {
    // Recarga: la pestaña nueva no sabe qué resumen se mostró; el borrador con los tres datos sigue
    // esperando el sí y confirma lo guardado.
    const db = createDb();
    const before = createTab(db);
    await before.send("Panadería");
    await before.send("Pan y pasteles");
    await before.send("Producción");
    const reloaded = createTab(db);
    assert.equal(reloaded.tracker.reviewShown(CHAT), null);
    await reloaded.send("sí");
    assert.equal(db.status, "confirmed");
  }
  {
    // Dos pestañas: B cambia el producto mientras A revisa. El "sí" de A no confirma datos que A no
    // vio: muestra el resumen actual y pregunta otra vez.
    const db = createDb({ sector: "Panadería", products: ["Pan"] });
    const a = createTab(db);
    const b = createTab(db);
    await a.send("Producción");
    await b.send("El producto es tortas");
    const again = await a.send("sí");
    assert.ok(again.startsWith("El contexto cambió mientras lo revisabas"), again);
    assert.ok(again.includes("- **Producto o servicio:** Tortas"), again);
    assert.equal(a.log.confirms.length, 0);
    await a.send("sí");
    assert.deepEqual(a.log.confirms.map((c) => c.products), [["Tortas"]]);
    assert.equal(db.status, "confirmed");
  }
  {
    // A confirma; B, con el borrador en caché, responde "sí": no se confirma dos veces.
    const db = createDb(COMPLETE);
    const a = createTab(db);
    const b = createTab(db);
    await b.send("¿Qué significa rubro?");
    await a.send("sí");
    const late = await b.send("sí");
    assert.ok(late.startsWith("El contexto de tu caso ya estaba registrado"), late);
    assert.deepEqual(b.log.confirms, []);
    assert.deepEqual(b.log.awaiting, [true]);
  }
  {
    // A tiene un caché viejo (paso 2) y B ya registró el producto: el turno de A lee el contexto
    // actual, responde el paso 3 y no pisa el producto.
    const db = createDb({ sector: "Panadería" });
    const a = createTab(db);
    const b = createTab(db);
    await a.send("¿Qué es un rubro?");
    await b.send("Pan");
    await a.send("Producción");
    assert.deepEqual(db.contextJson.products, ["Pan"]);
    assert.deepEqual(db.contextJson.process_focus, ["Producción"]);
    assert.deepEqual(a.log.saves, [{ process_focus: ["Producción"], products: undefined, sector: undefined }]);
  }
}

async function main() {
  await runCorpus();
  await runGeminiMistakes();
  await runReview();
  await runReloadAndConcurrency();
  console.log("stage0Corpus tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
