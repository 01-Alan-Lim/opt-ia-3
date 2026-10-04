// src/lib/plan/stage0Context.ts
//
// Lógica pura de la Etapa 0 (Contexto del caso) del chat (src/app/chat/page.tsx): tipos,
// detección de intención, extracción determinista de sector/productos/área, lectura y fusión
// del contexto, paso siguiente y textos fijos. Sin estado, I/O ni LLM: el flujo, las llamadas a
// /api/plans/context y la interpretación con Gemini siguen en page.tsx. Se movió tal cual.

import type { Message } from "@/lib/types";

import {
  isConfirmIntent,
  isGreetingOrSmallTalk,
  isReadyIntent,
  normalizeText,
} from "./advisorClientIntent";

export type Stage0ContextJson = {
  stage?: string;
  sector?: string;
  products?: string[];
  process_focus?: string[];
};
export type Stage0InterpretPayload = {
  intent?: "GREETING" | "QUESTION" | "START" | "EDIT" | "CONFIRM" | "ANSWER";
  sector?: unknown;
  products?: unknown;
  process_focus?: unknown;
  confidence?: unknown;
  needsClarification?: unknown;
  clarificationQuestion?: unknown;
};
export type EditTarget = "sector" | "products" | "process_focus" | null;

type Stage0Intent = "GREETING" | "QUESTION" | "START" | "CONFIRM" | "EDIT" | "ANSWER";
type Stage0DecisionIntent =
  | "answer"
  | "help_request"
  | "example_request"
  | "unknown"
  | "correction"
  | "meta_process"
  | "context_change"
  | "off_topic"
  | "ambiguous";
type Stage0Field = "sector" | "products" | "process_focus";

export function buildAdvisorGreeting(displayName?: string | null) {
  const firstName =
    (displayName ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0] ?? "";

  const namePart = firstName ? `, ${firstName}` : "";

  return (
    `¡Hola${namePart}! 👋 Bienvenido al **Asesor de Plan de Mejora**.\n\n` +
    "Primero completaremos la **Etapa 0: Contexto del Caso**. " +
    "Solo te haré **3 preguntas rápidas** para entender tu caso y luego pasaremos a la siguiente etapa.\n\n" +
    "Responde con calma y en tus propias palabras. " +
    "Si algo no queda claro, te ayudaré a reformularlo antes de guardarlo.\n\n" +
    "Puedes escribir **empezar** o responder directamente con el **sector/rubro** de la empresa " +
    "(por ejemplo: alimentos, textil o servicios)."
  );
}

export function detectStage0Intent(text: string): Stage0Intent {
  const t = normalizeText(text).trim();
  if (!t) return "ANSWER";

  // saludo corto
  if (isGreetingOrSmallTalk(text)) return "GREETING";

  // pregunta / meta-pregunta
  const looksQuestion =
    t.endsWith("?") ||
    t.includes("cual era la primera pregunta") ||
    t.includes("cual es la primera pregunta") ||
    t.includes("que era la primera pregunta") ||
    t.includes("que preguntaste") ||
    t.includes("que debo responder") ||
    t.includes("no entiendo") ||
    t.includes("explicame");

  if (looksQuestion) return "QUESTION";

  // empezar / iniciar wizard
  const isStart =
    t === "empezar" ||
    t === "iniciar" ||
    t === "comenzar" ||
    t.includes("quiero empezar") ||
    t.includes("quiero iniciar") ||
    t.includes("iniciemos") ||
    t.includes("arranquemos");

  if (isStart) return "START";

  // confirmar avanzar (cuando ya se capturó todo y se pide confirmación)
  if (isReadyIntent(text) || isConfirmIntent(text)) return "CONFIRM";

  // editar/modificar datos guardados
  if (t.includes("cambiar") || t.includes("editar") || t.includes("modificar")) return "EDIT";

  return "ANSWER";
}

function splitProducts(text: string) {
  // Acepta: "ladrillos, tejas" o "ladrillos y tejas"
  // También limpia frases tipo: "los productos son Yogurt y refresco"
  const cleaned = text
    .trim()
    // quita prefijos comunes
    .replace(
      /^(?:mis|los|las)?\s*(?:productos?|servicios?)\s*(?:son|es|serian|:\s*)\s*/i,
      ""
    )
    // quita "son:" al inicio si quedó
    .replace(/^(?:son|es)\s*:\s*/i, "");

  const parts = cleaned
    .split(/,| y |;/i)
    .map((s) =>
      s
        .trim()
        .replace(/[.\s]+$/g, "") // quita puntos finales
        .replace(/^[\-\*\u2022]\s*/g, "") // quita viñetas al inicio
    )
    .filter(Boolean)
    .slice(0, 6);

  // Normaliza capitalización simple (Yogurt, Refresco)
  const normalized = parts.map((p) =>
    p
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );

  // Dedup
  return Array.from(new Set(normalized));
}

function splitProcesses(text: string) {
  const t = text.trim();
  if (!t) return [];
  return text
    .split(/,| y |;/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function cleanStage0Phrase(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*.,;:\s]+/, "")
    .replace(/[-*.,;:\s]+$/, "")
    .replace(/^(?:es|son|seria|serian)\s+/i, "")
    .replace(/^(?:un|una|el|la|los|las)\s+/i, "")
    .trim()
    .slice(0, 140);
}

function toDisplayStage0Value(text: string) {
  return cleanStage0Phrase(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function hasStage0Extraction(value: Stage0ContextJson) {
  return Boolean(
    value.sector ||
      value.products?.length ||
      value.process_focus?.length
  );
}

export function mergeStage0Extraction(
  base: Stage0ContextJson,
  add: Stage0ContextJson
): Stage0ContextJson {
  return {
    stage: base.stage ?? add.stage ?? "ETAPA_0",
    sector: add.sector ?? base.sector,
    products: add.products ?? base.products,
    process_focus: add.process_focus ?? base.process_focus,
  };
}

function isStage0Unknown(text: string) {
  const t = normalizeText(text);

  const uncertaintySignal =
    /\b(no\s+se|nose|no\s+conozco|no\s+tengo|sin\s+idea|ni\s+idea)\b/.test(t) ||
    /\b(duda|dudas|dudoso|insegur|confundid|perdid)\w*\b/.test(t);

  if (!uncertaintySignal) return false;

  const remainder = t
    .replace(/\b(no\s+se|nose|no\s+conozco|no\s+tengo|sin\s+idea|ni\s+idea)\b/g, " ")
    .replace(/\b(no\s+estoy\s+segur\w*|no\s+tengo\s+claro|no\s+me\s+queda\s+claro)\b/g, " ")
    .replace(/\b(quizas|quiza|tal\s+vez|creo\s+que|podria\s+ser|puede\s+ser|supongo\s+que)\b/g, " ")
    .replace(/[.,;:!?-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return remainder.length === 0;
}

function stripStage0UncertaintyPrefix(text: string) {
  return text
    .replace(
      /^(?:no\s+s[eé]|nose|no\s+conozco|no\s+tengo\s+claro|no\s+estoy\s+segur\w*|sin\s+idea|ni\s+idea)\s*(?:,|;|pero|aunque)?\s*/i,
      ""
    )
    .replace(/^(?:quiz[aá]s|quiz[aá]|tal\s+vez|creo\s+que|podr[ií]a\s+ser|puede\s+ser|supongo\s+que)\s*/i, "")
    .trim();
}

function trimStage0OtherFieldSignals(text: string, field: Stage0Field) {
  const patterns: Record<Stage0Field, RegExp> = {
    sector: /\b(?:productos?|servicios?|area|proceso|enfoque)\b/i,
    products: /\b(?:sector|rubro|giro|area|proceso|enfoque)\b/i,
    process_focus: /\b(?:sector|rubro|giro|productos?|servicios?)\b/i,
  };

  const match = text.search(patterns[field]);
  return match > 0 ? text.slice(0, match).trim() : text;
}

export function hasMultipleStage0FieldSignals(text: string) {
  const t = normalizeText(text);
  const signals = [
    /\b(sector|rubro|giro)\b/.test(t),
    /\b(producto|productos|servicio|servicios|ofrece|ofrecen|vende|venden|fabrica|fabrican|produce|producen|elabora|elaboran|prepara|preparan|comercializa|comercializan)\b/.test(t),
    /\b(area|proceso|enfoque|enfocar|trabajar\s+en|analizar|mejorar|optimizar|revisar)\b/.test(t),
  ].filter(Boolean).length;

  return signals >= 2;
}

export function shouldAnswerWithoutLLM(intent: Stage0DecisionIntent, deterministic: Stage0ContextJson) {
  if (hasStage0Extraction(deterministic)) return false;
  return (
    intent === "unknown" ||
    intent === "help_request" ||
    intent === "example_request" ||
    intent === "meta_process" ||
    intent === "off_topic"
  );
}

function hasStage0ListSignal(text: string) {
  return /[,;\n]/.test(text) || /\s+y\s+/i.test(text);
}

export function hasStage0ProductSignal(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("producto") ||
    t.includes("servicio de") ||
    t.includes("servicios de") ||
    t.includes("ofrece") ||
    t.includes("ofrecen") ||
    t.includes("vende") ||
    t.includes("venden") ||
    t.includes("fabrica") ||
    t.includes("fabrican") ||
    t.includes("produce") ||
    t.includes("producen") ||
    t.includes("elabora") ||
    t.includes("elaboran") ||
    t.includes("prepara") ||
    t.includes("preparan") ||
    t.includes("comercializa") ||
    t.includes("comercializan")
  );
}

function hasStage0ProcessSignal(text: string) {
  const t = normalizeText(text);
  return (
    t.includes("area") ||
    t.includes("proceso") ||
    t.includes("enfoque") ||
    t.includes("enfocar") ||
    t.includes("trabajar en") ||
    t.includes("analizar") ||
    t.includes("mejorar") ||
    t.includes("optimizar") ||
    t.includes("revisar")
  );
}

function isShortStage0Answer(text: string) {
  const t = normalizeText(text);
  if (!t || t.endsWith("?")) return false;
  if (isStage0Unknown(text)) return false;
  if (hasStage0ListSignal(text)) return false;
  if (hasStage0ProductSignal(text)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;

  const verbSignals = [
    "ofrece",
    "vende",
    "fabrica",
    "produce",
    "elabora",
    "prepara",
    "quiero",
    "necesito",
    "puedo",
    "podemos",
    "tiene",
    "hace",
  ];

  return !verbSignals.some((signal) => t.includes(signal));
}

function stripStage0FieldPrefix(text: string) {
  return cleanStage0Phrase(stripStage0UncertaintyPrefix(text))
    .replace(/^(?:sector|rubro|giro)\s*(?:es|:|de)?\s*/i, "")
    .replace(/^(?:productos?|servicios?)\s*(?:son|es|:|de)?\s*/i, "")
    .replace(/^(?:area|proceso)\s*(?:es|:|de)?\s*/i, "")
    .replace(/^quiero\s+(?:analizar|enfocarme\s+en|trabajar\s+en)\s+/i, "")
    .trim();
}

function extractStage0Products(text: string, step: 1 | 2 | 3, forceField?: Stage0Field | null) {
  const shouldReadProducts =
    forceField === "products" ||
    step === 2 ||
    hasStage0ProductSignal(text) ||
    hasStage0ListSignal(text);

  if (!shouldReadProducts || isStage0Unknown(text)) return undefined;

  let source = text.trim();
  const marker = source.match(
    /(?:productos?|servicios?|ofrece|ofrecen|vende|venden|fabrica|fabrican|produce|producen|elabora|elaboran|prepara|preparan|comercializa|comercializan)\s*(?:son|es|:|de|que)?\s*(.+)$/i
  );

  if (marker?.[1]) {
    source = marker[1];
  }

  source = trimStage0OtherFieldSignals(source, "products");

  const products = splitProducts(stripStage0FieldPrefix(source))
    .map(toDisplayStage0Value)
    .filter(Boolean);

  return products.length ? products : undefined;
}

function extractStage0Process(text: string, step: 1 | 2 | 3, forceField?: Stage0Field | null) {
  const shouldReadProcess =
    forceField === "process_focus" ||
    step === 3 ||
    hasStage0ProcessSignal(text);

  if (!shouldReadProcess || isStage0Unknown(text)) return undefined;

  let source = text.trim();
  const marker = source.match(
    /(?:area|proceso|enfoque|enfocarme\s+en|trabajar\s+en|analizar)\s*(?:es|:|de|el|la)?\s*(.+)$/i
  );

  if (marker?.[1]) {
    source = marker[1];
  }

  source = trimStage0OtherFieldSignals(source, "process_focus");

  const processes = splitProcesses(stripStage0FieldPrefix(source))
    .map(toDisplayStage0Value)
    .filter(Boolean);

  return processes.length ? processes : undefined;
}

function extractStage0Sector(text: string, step: 1 | 2 | 3, forceField?: Stage0Field | null) {
  if (isStage0Unknown(text)) return undefined;
  if (forceField && forceField !== "sector") return undefined;

  const trimmed = text.trim();
  const explicit = trimmed.match(/(?:sector|rubro|giro)\s*(?:es|:|de)?\s*(.+)$/i);
  if (explicit?.[1]) {
    const source = trimStage0OtherFieldSignals(explicit[1], "sector");
    const value = toDisplayStage0Value(stripStage0FieldPrefix(source));
    return value || undefined;
  }

  const businessKind = trimmed.match(/^(?:es\s+)?(?:un|una)\s+(.+)$/i);
  if ((forceField === "sector" || step === 1) && businessKind?.[1]) {
    const source = trimStage0OtherFieldSignals(businessKind[1], "sector");
    const value = toDisplayStage0Value(stripStage0FieldPrefix(source));
    return value || undefined;
  }

  const beforeBusinessVerb = trimmed.match(/^(.+?)\s+es\s+(?:un|una)\s+.+$/i);
  if ((forceField === "sector" || step === 1) && beforeBusinessVerb?.[1]) {
    const source = trimStage0OtherFieldSignals(beforeBusinessVerb[1], "sector");
    const value = toDisplayStage0Value(stripStage0FieldPrefix(source));
    return value || undefined;
  }

  if ((forceField === "sector" || step === 1) && isShortStage0Answer(trimmed)) {
    if (hasStage0ProcessSignal(trimmed)) return undefined;
    const source = trimStage0OtherFieldSignals(trimmed, "sector");
    const value = toDisplayStage0Value(stripStage0FieldPrefix(source));
    return value || undefined;
  }

  return undefined;
}

export function extractStage0Deterministic(
  text: string,
  step: 1 | 2 | 3,
  forceField?: Stage0Field | null
): Stage0ContextJson {
  const process_focus = extractStage0Process(text, step, forceField);
  const products = extractStage0Products(text, step, forceField);
  const sector =
    process_focus && !forceField
      ? undefined
      : extractStage0Sector(text, step, forceField);

  return {
    sector,
    products,
    process_focus,
  };
}

export function classifyStage0DecisionIntent(text: string, localIntent: Stage0Intent): Stage0DecisionIntent {
  const t = normalizeText(text);

  if (!t) return "ambiguous";
  if (localIntent === "EDIT") return "correction";
  if (isStage0Unknown(text)) return "unknown";
  if (t.includes("ejemplo") || t.includes("opcion") || t.includes("opciones")) {
    return "example_request";
  }
  if (
    t.includes("que sigue") ||
    t.includes("como seguimos") ||
    t.includes("en que etapa") ||
    t.includes("por que preguntas") ||
    t.includes("para que sirve")
  ) {
    return "meta_process";
  }
  if (t.split(/\s+/).filter(Boolean).length <= 1 && /[?¿]/.test(text)) {
    return "ambiguous";
  }
  if (
    localIntent === "QUESTION" ||
    t.includes("ayuda") ||
    t.includes("no entiendo") ||
    t.includes("explicame") ||
    t.includes("que significa")
  ) {
    return "help_request";
  }
  if (
    t.includes("balanceo de linea") ||
    t.includes("pareto") ||
    t.includes("ishikawa") ||
    t.includes("foda")
  ) {
    return "off_topic";
  }
  if (t.includes("cambiar empresa") || t.includes("otro caso")) return "context_change";

  return "answer";
}

export function promptForStep(step: 1 | 2 | 3) {
  if (step === 1) {
    return (
      "🧩 **Pregunta 1 de 3**\n\n" +
      "¿Cuál es el **sector o rubro** de la empresa?\n" +
      "Ejemplos: **alimentos, textil, servicios, metalmecánica, logística**."
    );
  }

  if (step === 2) {
    return (
      "🧩 **Pregunta 2 de 3**\n\n" +
      "¿Cuál es el **producto o servicio principal** con el que trabajarás?\n" +
      "Puedes escribir **1 a 3** si corresponde."
    );
  }

  return (
    "🧩 **Pregunta 3 de 3**\n\n" +
    "¿En qué **área o proceso principal** trabajarás?\n\n" +
    "Puedes elegir una opción típica o escribirla con tus palabras:\n" +
    "- Producción\n" +
    "- Inventarios / Almacén\n" +
    "- Logística / Despacho\n" +
    "- Ventas / Atención al cliente\n" +
    "- Calidad\n" +
    "- Mantenimiento\n" +
    "- Administración / Costos"
  );
}

export function buildStage0Welcome(step: 1 | 2 | 3) {
  if (step === 1) {
    return (
      "¡Perfecto! 👌 Empecemos con la **Etapa 0: Contexto del Caso**.\n\n" +
      "Te haré solo **3 preguntas rápidas**. " +
      "Con eso dejaré tu caso registrado correctamente y luego seguimos con la siguiente etapa.\n\n" +
      promptForStep(1)
    );
  }

  return (
    "👌 Retomemos la **Etapa 0** desde donde quedamos.\n\n" +
    promptForStep(step)
  );
}

export function stage0HelpMessage(step: 1 | 2 | 3) {
  if (step === 1) {
    return (
      "Para ubicar el caso, dime el **rubro general** de la empresa.\n\n" +
      "Ejemplos:\n" +
      "- alimentos\n" +
      "- textil\n" +
      "- servicios\n" +
      "- metalmecanica"
    );
  }

  if (step === 2) {
    return (
      "Ahora necesito saber que **producto o servicio** ofrece la empresa.\n\n" +
      "Ejemplos:\n" +
      "- yogurt\n" +
      "- pan\n" +
      "- confeccion de uniformes\n" +
      "- servicio de mantenimiento"
    );
  }

  return (
    "Para cerrar el contexto, dime el **area o proceso** donde enfocaras el analisis.\n\n" +
    "Ejemplos:\n" +
    "- Produccion\n" +
    "- Calidad\n" +
    "- Logistica\n" +
    "- Inventarios"
  );
}

export function formatContextSummary(ctxJson: any) {
  const sector = String(ctxJson?.sector ?? "").trim() || "(pendiente)";
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
  const focus = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus.filter(Boolean) : [];

  return (
    `- **Sector:** ${sector}\n` +
    `- **Producto(s):** ${products.length ? products.join(", ") : "(pendiente)"}\n` +
    `- **Área:** ${focus.length ? focus.join(", ") : "(pendiente)"}`
  );
}

function readStage0StringList(value: unknown): string[] | undefined {
  const source =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const text = String(item ?? "").replace(/\s+/g, " ").trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out.length > 0 ? out.slice(0, 3) : undefined;
}

export function readStage0Context(value: Record<string, unknown>): Stage0ContextJson {
  const sector =
    typeof value.sector === "string" && value.sector.trim()
      ? value.sector.trim()
      : undefined;

  return {
    stage: typeof value.stage === "string" ? value.stage : "ETAPA_0",
    sector,
    products: readStage0StringList(value.products),
    process_focus: readStage0StringList(value.process_focus),
  };
}

export function readStage0Extraction(payload: Stage0InterpretPayload): Stage0ContextJson {
  const sector =
    typeof payload.sector === "string" && payload.sector.trim()
      ? payload.sector.trim()
      : undefined;

  return {
    sector,
    products: readStage0StringList(payload.products),
    process_focus: readStage0StringList(payload.process_focus),
  };
}

export function mergeStage0Context(
  current: Stage0ContextJson,
  patch: Stage0ContextJson
): Stage0ContextJson {
  return {
    stage: current.stage ?? "ETAPA_0",
    sector: patch.sector ?? current.sector,
    products: patch.products ?? current.products ?? [],
    process_focus: patch.process_focus ?? current.process_focus ?? [],
  };
}

export function askForMissingStage0Field(step: 1 | 2 | 3, ctxJson: Stage0ContextJson) {
  if (step === 1) {
    const products = ctxJson.products?.length ? ` Ya tengo como producto/servicio: **${ctxJson.products.join(", ")}**.` : "";
    return `${products} Para completar el contexto, dime tambien el **rubro general** de la empresa.`;
  }

  if (step === 2) {
    return "Ahora dime que **productos o servicios** ofrece la empresa.";
  }

  return "Solo me falta el **area o proceso foco** donde trabajaras.";
}

export function buildStage0ProgressMessage(
  captured: Stage0ContextJson,
  nextContext: Stage0ContextJson
) {
  const lines: string[] = [];

  if (captured.sector) {
    lines.push(`sector: **${captured.sector}**`);
  }

  if (captured.products?.length) {
    lines.push(`producto/servicio: **${captured.products.join(", ")}**`);
  }

  if (captured.process_focus?.length) {
    lines.push(`area/proceso foco: **${captured.process_focus.join(", ")}**`);
  }

  const nextStep = getNextStage0StepFromContext(nextContext);
  const intro = lines.length
    ? `Perfecto, ya registre ${lines.join("; ")}.`
    : "Perfecto, ya actualice el contexto.";

  if (nextStep === 0) {
    return (
      `${intro}\n\n` +
      "Con esto ya tenemos el contexto inicial del caso y puedo dejarlo confirmado."
    );
  }

  return `${intro}\n\n${askForMissingStage0Field(nextStep, nextContext)}`;
}

export function detectEditingField(text: string): EditTarget {
  const t = normalizeText(text);

  if (t.includes("sector") || t.includes("rubro")) return "sector";
  if (t.includes("producto") || t.includes("productos") || t.includes("servicio")) return "products";
  if (t.includes("area") || t.includes("proceso")) return "process_focus";

  // Si dice "los 3" o "todo"
  if (t.includes("los 3") || t.includes("todo") || t.includes("los tres")) return null;

  return null;
}

export function stage0StepForField(field: EditTarget): 1 | 2 | 3 | null {
  if (field === "sector") return 1;
  if (field === "products") return 2;
  if (field === "process_focus") return 3;
  return null;
}

export function advisorResumeGreeting(ctxJson: any, step: 1 | 2 | 3) {
  const sector = String(ctxJson?.sector ?? "").trim();
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];

  if (step === 1) {
    return (
      "¡Hola! 👋 ¿Qué tal? Para empezar necesito 3 datos rápidos.\n" +
      "Vamos con el primero"
    );
  }

  if (step === 2) {
    return (
      "¡Perfecto! ✅ Ya tengo tu **sector/rubro**: " +
      (sector ? `**${sector}**` : "(pendiente)") +
      ".\n\nAhora sigamos con el **producto o servicio principal**"
    );
  }

  // step === 3
  return (
    "¡Genial! ✅ Ya tengo:\n" +
    `- Sector: **${sector || "(pendiente)"}**\n` +
    `- Producto(s): **${products.length ? products.join(", ") : "(pendiente)"}**\n\n` +
    "Solo me falta el **área principal** donde trabajarás"
  );
}

export function getNextStage0StepFromContext(ctxJson: any): 1 | 2 | 3 | 0 {
  const sector = String(ctxJson?.sector ?? "").trim();
  const products = Array.isArray(ctxJson?.products) ? ctxJson.products : [];
  const process = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus : [];

  if (!sector) return 1;
  if (!products.length) return 2;
  if (!process.length) return 3;
  return 0; // listo (mínimo completo)
}

export function lastAssistantIsStage0Prompt(msgs: Message[]) {
  const last = [...msgs].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return (
    last.includes("1/3") ||
    last.includes("2/3") ||
    last.includes("3/3") ||
    last.includes("¿Cuál es el producto") ||
    last.includes("¿Cuál es el sector") ||
    last.includes("¿En qué área")
  );
}
