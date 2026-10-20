import assert from "node:assert/strict";

import { createStage0PromptTracker, type Stage0PromptTracker } from "../../app/chat/_lib/stage0Opening";
import { handleStage0Turn, type Stage0TurnDeps } from "../../app/chat/_lib/turns/stage0Turn";
import type { PlanContextStatus } from "../../app/chat/_lib/turns/types";
import {
  buildStage0Confirmed,
  buildStage0Opening,
  buildStage0Review,
  getNextStage0StepFromContext,
  readStage0Context,
  stage0QuestionFor,
  stage0Reminder,
  type EditTarget,
  type Stage0ContextJson,
} from "./stage0Context";
import { findInvalidStage0Fields } from "./stage0Values";

// Turno de la Etapa 0 (src/app/chat/_lib/turns/stage0Turn.ts) conversación por conversación, con
// Gemini simulado (la ruta /api/plans/context/interpret es una función del caso) y una base en
// memoria que imita /api/plans/context (fusiona los campos que llegan) y /api/plans/context/confirm
// (exige los tres datos válidos). Sin red. Comprueba que nada que no sea una respuesta se guarda,
// que pedir empezar no repite la pregunta, que Gemini solo se consulta cuando hace falta y que E0
// se confirma solo cuando el estudiante aprueba el resumen. El corpus de la auditoría está en
// stage0Corpus.test.ts.

const CHAT = "c0000000-0000-4000-8000-000000000001";

type Interpret = (step: number, text: string) => Record<string, unknown> | null | "error";

function createCase(
  opts: { context?: Stage0ContextJson; prompted?: boolean; interpret?: Interpret; confirmRejects?: string } = {}
) {
  const db = { status: "draft" as "draft" | "confirmed", contextJson: { stage: "ETAPA_0", ...(opts.context ?? {}) } as Stage0ContextJson };
  const tracker: Stage0PromptTracker = createStage0PromptTracker();
  if (opts.prompted !== false) tracker.markPrompted(CHAT);

  const log = {
    replies: [] as string[],
    events: [] as string[],
    interpretCalls: [] as Array<{ step: number; text: string }>,
    saves: [] as Stage0ContextJson[],
    confirms: 0,
    reviewed: [] as Stage0ContextJson[],
    awaiting: [] as boolean[],
    cache: [] as PlanContextStatus[],
  };
  let editing: EditTarget = null;
  let draft: Stage0ContextJson = {};

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
    setStage0Draft: (value) => {
      draft = value;
    },
    setAwaitingStage1Start: (value) => {
      log.awaiting.push(value);
    },
    tracker,
    appendAssistant: async (text) => {
      log.events.push("reply");
      log.replies.push(text);
    },
    interpret: async (step, text) => {
      log.events.push("interpret");
      log.interpretCalls.push({ step, text });
      const out = opts.interpret ? opts.interpret(step, text) : null;
      if (out === "error") return { ok: false, payload: null };
      return { ok: true, payload: out };
    },
    saveDraft: async (extracted) => {
      log.events.push("save");
      log.saves.push(extracted);
      // Como POST /api/plans/context: fusiona con lo guardado los campos que llegan.
      const incoming = Object.fromEntries(Object.entries(extracted).filter(([, value]) => value !== undefined));
      db.contextJson = { ...db.contextJson, ...incoming, stage: "ETAPA_0" };
      return { ok: true, payload: { chatId: CHAT } };
    },
    confirm: async (reviewed) => {
      log.events.push("confirm");
      log.confirms++;
      log.reviewed.push(reviewed);
      if (opts.confirmRejects) return { ok: false, payload: { message: opts.confirmRejects } };
      // Como POST /api/plans/context/confirm: fusiona lo revisado, exige los tres datos y que sean
      // datos del caso.
      const merged = { ...db.contextJson, ...reviewed };
      if (getNextStage0StepFromContext(merged) !== 0) {
        return { ok: false, payload: { message: "Aún falta información mínima para confirmar el contexto (sector, producto/servicio, proceso/área)." } };
      }
      if (findInvalidStage0Fields(merged).length) return { ok: false, payload: { message: "Revisa el contexto." } };
      db.contextJson = merged;
      db.status = "confirmed";
      return { ok: true, payload: { chatId: CHAT, contextJson: db.contextJson } };
    },
    refreshContext: async () => {
      log.events.push("refresh");
      return status();
    },
    cacheContext: (data) => {
      log.cache.push(data);
    },
  });

  const send = async (text: string) => {
    const before = log.replies.length;
    assert.equal(await handleStage0Turn(deps(), { text, ctx: status() }), true, `turno atendido: ${text}`);
    assert.equal(log.replies.length, before + 1, `una sola respuesta: ${text}`);
    return log.replies[log.replies.length - 1];
  };

  return { db, log, tracker, send, getEditing: () => editing, getDraft: () => draft };
}

const geminiOff: Interpret = () => {
  throw new Error("este turno no debe llamar a Gemini");
};

async function main() {
  // ---------------- 2. "Quiero comenzar… ¿Cómo empezamos?" ----------------
  {
    // Con la apertura ya a la vista: un recordatorio, sin repetir la pregunta ni la bienvenida.
    const c = createCase({ interpret: geminiOff });
    const reply = await c.send("Quiero comenzar mi Plan de Mejora para mis prácticas empresariales. ¿Cómo empezamos?");
    assert.equal(reply, `¡Ya estamos en marcha! ${stage0Reminder(1)}`);
    assert.ok(!reply.includes(stage0QuestionFor(1)));
    assert.deepEqual([c.log.saves, c.log.interpretCalls], [[], []]);
    // Repetirlo no trae la bienvenida otra vez.
    assert.equal(await c.send("¿Cómo empezamos?"), `¡Ya estamos en marcha! ${stage0Reminder(1)}`);
  }
  {
    // 4. Escribió antes de que llegara la apertura (no vio ninguna pregunta): la apertura es la respuesta.
    const c = createCase({ prompted: false, interpret: geminiOff });
    assert.equal(await c.send("Quiero comenzar, ¿cómo empezamos?"), buildStage0Opening(1, { stage: "ETAPA_0" }, "Ana"));
    assert.equal(c.tracker.wasPrompted(CHAT), true);
    // El siguiente pedido ya no la repite.
    assert.equal(await c.send("empecemos"), `¡Ya estamos en marcha! ${stage0Reminder(1)}`);
    assert.deepEqual(c.log.saves, []);
  }

  // ---------------- 6-8. Ayuda, ejemplo, "no sé", propósito, "ok": nada se guarda ni va a Gemini ----------------
  {
    const c = createCase({ interpret: geminiOff });
    const help = await c.send("¿Qué es un rubro?");
    assert.ok(help.startsWith("El **rubro** es el tipo de actividad"), help);
    const example = await c.send("Dame un ejemplo");
    assert.ok(example.startsWith("Algunas formas de describir la actividad"), example);
    const unknown = await c.send("No sé cuál es el rubro");
    assert.ok(unknown.startsWith("No te preocupes"), unknown);
    const purpose = await c.send("¿Por qué necesitas esa información?");
    assert.ok(purpose.startsWith("Te lo pregunto porque") && purpose.endsWith(stage0Reminder(1)), purpose);
    const ok = await c.send("ok");
    assert.ok(ok.startsWith("Todavía no podemos avanzar"), ok);
    // Antes cada uno de estos quedaba guardado como el sector ("Dame Un Ejemplo", "Ok", "?").
    assert.deepEqual(c.log.saves, []);
    assert.deepEqual(c.log.interpretCalls, []);
    assert.equal(c.db.contextJson.sector, undefined);
  }

  // ---------------- Respuesta real, continuidad y confirmación ----------------
  {
    const c = createCase({ interpret: geminiOff });
    const r1 = await c.send("Es una panadería");
    assert.equal(r1, `Gracias, registré el rubro: **Panadería**.\n\n${stage0QuestionFor(2)}`);
    // Lectura fresca al empezar (otra pestaña pudo cambiar algo); guardar va antes de responder.
    assert.deepEqual(c.log.events, ["refresh", "save", "refresh", "reply"]);
    assert.deepEqual(c.log.saves, [{ sector: "Panadería", products: undefined, process_focus: undefined }]);
    assert.equal(c.log.confirms, 0, "sin los tres datos no se confirma");
    assert.equal(c.log.cache.at(-1)?.status, "draft");

    // Una pregunta en medio no pierde lo registrado ni el hilo.
    const mid = await c.send("Dame un ejemplo");
    assert.ok(mid.includes("**Panadería**"), "los ejemplos usan el rubro registrado");
    assert.equal(c.db.contextJson.sector, "Panadería");

    const r2 = await c.send("Pan y pasteles");
    assert.equal(r2, `Gracias, registré el producto o servicio: **Pan, Pasteles**.\n\n${stage0QuestionFor(3)}`);
    assert.deepEqual(c.db.contextJson.products, ["Pan", "Pasteles"]);
    assert.equal(c.db.contextJson.sector, "Panadería", "se conserva lo anterior");

    // Con el tercer dato, el resumen para revisar: E0 no se confirma sola (antes sí).
    const r3 = await c.send("Producción");
    const complete = { stage: "ETAPA_0", sector: "Panadería", products: ["Pan", "Pasteles"], process_focus: ["Producción"] };
    assert.equal(r3, buildStage0Review(complete, "Gracias, registré el área o proceso: **Producción**."));
    assert.equal(c.log.confirms, 0, "sin el sí del estudiante no se confirma");
    assert.equal(c.db.status, "draft");
    assert.deepEqual(c.log.awaiting, []);

    // El estudiante aprueba el resumen: confirma el servidor, con los datos revisados.
    const r4 = await c.send("Sí, regístralo así");
    assert.equal(c.log.confirms, 1);
    assert.deepEqual(c.log.reviewed, [readStage0Context(complete)]);
    assert.equal(r4, buildStage0Confirmed(readStage0Context(complete)));
    assert.ok(r4.includes("**productividad**") && r4.includes("**ok**"), "E1 arranca como siempre");
    assert.equal(c.db.status, "confirmed");
    assert.deepEqual(c.log.awaiting, [true]);
    assert.equal(c.log.cache.at(-1)?.status, "confirmed");
    assert.deepEqual(c.log.interpretCalls, [], "respuestas cortas: sin Gemini");
  }

  // ---------------- 9. Varios datos en un mensaje (Gemini simulado) ----------------
  {
    const c = createCase({
      interpret: (step, text) => {
        assert.equal(step, 1);
        assert.ok(text.includes("textil"));
        return { intent: "ANSWER", sector: "textil", products: ["poleras"], process_focus: ["produccion"], confidence: 0.9, needsClarification: false };
      },
    });
    const reply = await c.send("Es una empresa textil que fabrica poleras y quiero analizar producción");
    assert.equal(c.log.interpretCalls.length, 1, "una sola llamada a Gemini");
    // Manda la lectura de Gemini: antes lo determinista guardaba "Quiero Analizar Producción" como producto.
    assert.deepEqual(c.log.saves, [{ sector: "textil", products: ["poleras"], process_focus: ["produccion"] }]);
    // Los tres datos en un mensaje: el resumen para revisar, sin confirmar (antes se confirmaba).
    assert.ok(reply.endsWith("**¿Lo registro así?**\nSi algo no es correcto, dime qué dato quieres cambiar."), reply);
    assert.equal(c.log.confirms, 0);
  }

  // ---------------- El intent de Gemini se usa; su pregunta no se repite ----------------
  {
    const repeated = "¿Podrías decirme el sector o rubro de la empresa donde harás tu plan de mejora?";
    const c = createCase({
      interpret: () => ({ intent: "START", confidence: 0.3, needsClarification: true, clarificationQuestion: repeated }),
    });
    const reply = await c.send("Buenas, soy estudiante de industrial y me toca hacer el plan en mi práctica");
    assert.equal(c.log.interpretCalls.length, 1);
    assert.equal(reply, `¡Ya estamos en marcha! ${stage0Reminder(1)}`);
    assert.ok(!reply.includes(repeated), "la pregunta de Gemini no se muestra");
    assert.deepEqual(c.log.saves, []);
  }
  {
    // QUESTION sin datos: la explicación del dato, no la pregunta de Gemini.
    const c = createCase({ interpret: () => ({ intent: "QUESTION", confidence: 0.4, needsClarification: true, clarificationQuestion: "¿Me dices el rubro?" }) });
    const reply = await c.send("La empresa es grande y tiene muchos trabajadores en planta");
    assert.ok(reply.startsWith("El **rubro** es el tipo de actividad"), reply);
    assert.deepEqual(c.log.saves, []);
  }
  {
    // Gemini no responde y no hay dato: se pide precisar, sin guardar.
    const c = createCase({ interpret: () => "error" });
    const reply = await c.send("La empresa queda en la zona sur y tiene dos turnos de trabajo");
    assert.ok(reply.startsWith("Gracias. Todavía no logro identificar a qué se dedica la empresa"), reply);
    assert.deepEqual(c.log.saves, []);
  }
  {
    // Gemini no responde y el mensaje largo sí traía datos: no se guarda nada a medias; se pide
    // resumirlo.
    const c = createCase({ interpret: () => "error" });
    const reply = await c.send("Es una empresa textil que fabrica poleras y quiero analizar producción");
    assert.ok(reply.startsWith("Para no registrar algo equivocado, prefiero que me lo digas en pocas palabras."), reply);
    assert.deepEqual(c.log.saves, []);
  }

  // ---------------- Corrección de un dato ----------------
  {
    const c = createCase({ context: { sector: "Alimentos", products: ["Yogur"] }, interpret: geminiOff });
    const ask = await c.send("quiero cambiar el rubro");
    assert.equal(c.getEditing(), "sector");
    assert.ok(ask.startsWith("Lo ajustamos sin reiniciar el contexto."), ask);
    await c.send("Lácteos");
    assert.deepEqual(c.log.saves, [{ sector: "Lácteos" }], "solo el campo que se corrige");
    assert.deepEqual(c.db.contextJson.products, ["Yogur"]);
    assert.equal(c.getEditing(), null);
  }

  // ---------------- 10. Gates: la confirmación la decide el servidor ----------------
  {
    // El estudiante aprueba el resumen, pero si el servidor lo rechaza no se avanza: se muestra su
    // mensaje y E1 no queda pendiente de arrancar.
    const c = createCase({
      context: { sector: "Alimentos", products: ["Yogur"] },
      interpret: geminiOff,
      confirmRejects: "Aún falta información mínima para confirmar el contexto.",
    });
    await c.send("Producción");
    assert.equal(c.log.confirms, 0);
    const reply = await c.send("sí");
    assert.equal(c.log.confirms, 1);
    assert.equal(reply, "Aún falta información mínima para confirmar el contexto.");
    assert.equal(c.db.status, "draft");
    assert.deepEqual(c.log.awaiting, []);
  }
  {
    const c = createCase({ context: { sector: "Alimentos" }, interpret: geminiOff });
    // Respuesta en el paso 2 sin los tres datos: nunca llama a confirmar.
    await c.send("Yogur");
    assert.equal(c.log.confirms, 0);
    assert.deepEqual(c.log.awaiting, []);
  }

  // ---------------- Extracción: los casos de la prueba real ----------------
  {
    // 1-5. Respuestas cortas en su paso: se guardan enteras, sin Gemini y sin pedazos de palabras
    // (antes "Mos Yogurt", "Mos Pan", "Área Es Producción", "Trabajamos En El Área De Inventarios").
    const answers: Array<[Stage0ContextJson, string, Stage0ContextJson]> = [
      [{ sector: "Alimentos" }, "Fabricamos yogurt y queso", { products: ["Yogurt", "Queso"] }],
      [{ sector: "Panadería" }, "Vendemos pan", { products: ["Pan"] }],
      [{ sector: "Alimentos", products: ["Yogur"] }, "El área es producción", { process_focus: ["Producción"] }],
      [{ sector: "Alimentos", products: ["Yogur"] }, "Trabajamos en el área de inventarios", { process_focus: ["Inventarios"] }],
      [{ sector: "Textil" }, "Producimos prendas de vestir", { products: ["Prendas de vestir"] }],
    ];
    for (const [context, text, saved] of answers) {
      const c = createCase({ context, interpret: geminiOff });
      const reply = await c.send(text);
      assert.deepEqual(c.log.saves, [{ sector: undefined, products: undefined, process_focus: undefined, ...saved }], text);
      const value = (saved.products ?? saved.process_focus ?? []).join(", ");
      assert.ok(reply.includes(value), `${text}: ${reply}`);
    }
  }
  {
    // 6. "No sé qué productos fabrican": nada se guarda ni va a Gemini; la ayuda usa el rubro registrado.
    const c = createCase({ context: { sector: "Panadería" }, interpret: geminiOff });
    const reply = await c.send("No sé qué productos fabrican");
    assert.ok(reply.startsWith("No hay problema. Como la empresa es del rubro **Panadería**"), reply);
    assert.deepEqual([c.log.saves, c.log.interpretCalls], [[], []]);
  }
  {
    // 7. "¿Qué significa área de intervención?" mientras se pide el rubro: responde esa pregunta,
    // retoma la del rubro y no guarda nada (antes explicaba el rubro).
    const c = createCase({ interpret: geminiOff });
    const reply = await c.send("¿Qué significa área de intervención?");
    assert.ok(reply.startsWith("El **área o proceso** (el área de intervención)"), reply);
    assert.ok(reply.endsWith(stage0Reminder(1)), reply);
    assert.deepEqual([c.log.saves, c.log.interpretCalls], [[], []]);
  }
  {
    // 8. Gemini lee la respuesta; un área que el estudiante no mencionó no se guarda. El rubro
    // deducido de la actividad sí.
    const c = createCase({
      interpret: () => ({
        intent: "ANSWER",
        sector: "alimentos",
        products: ["yogurt", "queso"],
        process_focus: ["producción"],
        confidence: 0.9,
        needsClarification: false,
      }),
    });
    await c.send("Fabricamos yogurt y queso");
    assert.equal(c.log.interpretCalls.length, 1);
    assert.deepEqual(c.log.saves, [{ sector: "alimentos", products: ["yogurt", "queso"], process_focus: undefined }]);
  }
  {
    // 8. Si Gemini no responde, un mensaje corto con los tres datos marcados se reparte bien, una
    // vez cada uno, y se muestra el resumen para revisar.
    const c = createCase({ interpret: () => "error" });
    const reply = await c.send("Rubro textil, producto: poleras, área: producción");
    assert.deepEqual(c.log.saves, [{ sector: "Textil", products: ["Poleras"], process_focus: ["Producción"] }]);
    assert.ok(reply.includes("- **Rubro:** Textil\n\n- **Producto o servicio:** Poleras\n\n- **Área o proceso:** Producción"), reply);
    assert.equal(c.log.confirms, 0);
  }
  {
    // Corrección con el valor nuevo en el mismo mensaje: solo ese campo, sin Gemini (antes "A Textil").
    const c = createCase({ context: { sector: "Alimentos", products: ["Yogur"] }, interpret: geminiOff });
    await c.send("quiero cambiar el rubro a textil");
    assert.deepEqual(c.log.saves, [{ sector: "Textil" }]);
  }

  console.log("stage0Turn tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
