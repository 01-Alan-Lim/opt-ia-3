// src/lib/plan/advisorClientIntent.ts
//
// Heurísticas de intención sobre el texto del estudiante que usa el chat (src/app/chat/page.tsx).
// Son puras: solo dependen de su argumento. Se movieron tal cual desde page.tsx; las ramas que
// parecen imposibles (p. ej. comparar con "sí" después de quitar las tildes) se conservan a
// propósito. No confundir con conversationIntent.ts, que es del servidor y tiene otra semántica.

function normalizeClosureText(text: string) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAcademicPayload(text: string) {
  const raw = String(text ?? "").trim();
  const normalized = normalizeClosureText(raw);
  if (!normalized) return false;

  const academicSignals = [
    "objetivo",
    "objetivos",
    "meta",
    "metas",
    "accion",
    "acciones",
    "plan",
    "cronograma",
    "kpi",
    "indicador",
    "indicadores",
    "causa",
    "causas",
    "criterio",
    "criterios",
    "peso",
    "pesos",
    "reducir",
    "mejorar",
    "incrementar",
    "disminuir",
    "optimizar",
    "estandarizar",
  ];

  if (academicSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  const colonIndex = raw.indexOf(":");
  if (colonIndex >= 0 && raw.slice(colonIndex + 1).trim().length >= 24) {
    return true;
  }

  if (/(^|\n|\s)(\d+[\).:-]\s+\S|[-*]\s+\S)/.test(raw)) {
    return true;
  }

  const separatorCount = (raw.match(/[,;]/g) ?? []).length;
  return raw.length >= 90 && separatorCount >= 2;
}

export function looksLikeAdvisorProgressStatusQuestion(text: string) {
  const normalized = normalizeClosureText(text);
  if (!normalized) return false;
  if (containsAcademicPayload(text)) return false;

  const hasStageSignal =
    normalized.includes("progreso") ||
    normalized.includes("barra") ||
    normalized.includes("etapa") ||
    normalized.includes("avance") ||
    normalized.includes("avanzo") ||
    normalized.includes("avanzar");

  if (!hasStageSignal) return false;

  return (
    normalized.includes("me aparece") ||
    normalized.includes("no aparece") ||
    normalized.includes("sigue en") ||
    normalized.includes("sigue la") ||
    normalized.includes("no cambio") ||
    normalized.includes("no avanzo") ||
    normalized.includes("no avance") ||
    normalized.includes("en que etapa") ||
    normalized.includes("que etapa") ||
    normalized.includes("por que no") ||
    normalized.includes("porque no") ||
    normalized.includes("por que dice") ||
    normalized.includes("ya pase") ||
    normalized.includes("ya pasamos")
  );
}

export function looksLikeStage6NextStepQuestion(text: string) {
  const normalized = normalizeClosureText(text);
  if (!normalized) return false;
  if (containsAcademicPayload(text)) return false;

  return (
    normalized.includes("que sigue") ||
    normalized.includes("como continuo") ||
    normalized.includes("como continuamos") ||
    normalized.includes("como seguimos") ||
    normalized.includes("ya esta bien") ||
    normalized.includes("esta bien asi") ||
    normalized.includes("asi esta bien") ||
    normalized.includes("pasamos") ||
    normalized.includes("pasemos") ||
    normalized.includes("siguiente etapa") ||
    normalized.includes("avancemos") ||
    normalized.includes("continuemos")
  );
}

export function wantsStage6ValidationNow(text: string) {
  const normalized = normalizeClosureText(text);

  return (
    looksLikeObjectivesClosureRequest(text) ||
    isShortAffirmativeReply(text) ||
    normalized.includes("validemos") ||
    normalized.includes("valida") ||
    normalized.includes("pasamos") ||
    normalized.includes("pasemos") ||
    normalized.includes("siguiente etapa") ||
    normalized.includes("avancemos")
  );
}

export function looksLikeObjectivesClosureRequest(text: string) {
  const normalized = normalizeClosureText(text);

  return (
    normalized.includes("ya termine mis objetivos") ||
    normalized.includes("ya termine los objetivos") ||
    normalized.includes("ya tengo mis objetivos completos") ||
    normalized.includes("ya tengo los objetivos completos") ||
    normalized.includes("mis objetivos ya estan listos") ||
    normalized.includes("los objetivos ya estan listos") ||
    normalized.includes("revisa mis objetivos") ||
    normalized.includes("revisa los objetivos") ||
    normalized.includes("puedes revisar mis objetivos") ||
    normalized.includes("puedes validar mis objetivos") ||
    normalized.includes("podemos validar objetivos") ||
    normalized.includes("valida mis objetivos") ||
    normalized.includes("valida los objetivos") ||
    normalized.includes("podemos cerrar objetivos") ||
    normalized.includes("cierra la etapa de objetivos") ||
    normalized.includes("cerramos la etapa 6") ||
    normalized.includes("finalizamos la etapa 6") ||
    normalized.includes("ya cerramos la etapa 6") ||
    normalized.includes("ya finalizamos la etapa 6") ||
    normalized.includes("etapa 6 completa") ||
    normalized.includes("la etapa 6 esta completa") ||
    normalized.includes("la etapa 6 ya esta lista") ||
    normalized.includes("pasemos a la etapa 7") ||
    normalized.includes("pasar a la etapa 7") ||
    normalized.includes("podemos pasar a la etapa 7") ||
    normalized.includes("pasemos a la siguiente etapa") ||
    normalized.includes("podemos pasar a la siguiente etapa") ||
    normalized.includes("sigamos con la etapa 7") ||
    normalized.includes("continuemos con la etapa 7") ||
    normalized === "ok avancemos" ||
    normalized === "avancemos" ||
    normalized === "sigamos" ||
    normalized === "continuemos" ||
    normalized === "pasemos"
  );
}

export function isShortAffirmativeReply(text: string) {
  const normalized = normalizeClosureText(text);

  return (
    normalized === "si" ||
    normalized === "sí" ||
    normalized === "ok" ||
    normalized === "okay" ||
    normalized === "okey" ||
    normalized === "confirmo" ||
    normalized === "si confirmo" ||
    normalized === "sí confirmo" ||
    normalized === "de acuerdo" ||
    normalized === "esta bien" ||
    normalized === "está bien" ||
    normalized === "correcto" ||
    normalized === "listo" ||
    normalized === "dale" ||
    normalized === "vamos" ||
    normalized === "continuemos" ||
    normalized === "sigamos" ||
    normalized === "ya esta" ||
    normalized === "ya quedó" ||
    normalized === "ya quedo" ||
    normalized === "avancemos" ||
    normalized === "pasemos" ||
    normalized === "pasemos nomas"
  );
}

export function looksLikeProgressClosureRequest(text: string) {
  const normalized = normalizeClosureText(text);

  return (
    normalized.includes("revisa mi reporte de avances") ||
    normalized.includes("revisa el reporte de avances") ||
    normalized.includes("puedes revisar mi reporte") ||
    normalized.includes("puedes validar mi reporte") ||
    normalized.includes("valida mi reporte de avances") ||
    normalized.includes("valida el reporte de avances") ||
    normalized.includes("mi reporte ya esta listo") ||
    normalized.includes("el reporte ya esta listo") ||
    normalized.includes("podemos cerrar la etapa 9") ||
    normalized.includes("cierra la etapa 9") ||
    normalized.includes("cerramos la etapa 9") ||
    normalized.includes("finalizamos la etapa 9") ||
    normalized.includes("ya cerramos la etapa 9") ||
    normalized.includes("ya finalizamos la etapa 9") ||
    normalized.includes("etapa 9 completa") ||
    normalized.includes("la etapa 9 esta completa") ||
    normalized.includes("la etapa 9 ya esta lista") ||
    normalized.includes("pasemos a la etapa 10") ||
    normalized.includes("pasar a la etapa 10") ||
    normalized.includes("podemos pasar a la etapa 10") ||
    normalized.includes("pasemos a la siguiente etapa") ||
    normalized.includes("podemos pasar a la otra etapa") ||
    normalized.includes("podemos pasar a la siguiente etapa") ||
    normalized.includes("sigamos con la etapa 10") ||
    normalized.includes("continuemos con la etapa 10") ||
    normalized === "ok avancemos" ||
    normalized === "avancemos" ||
    normalized === "sigamos" ||
    normalized === "continuemos" ||
    normalized === "pasemos"
  );
}

export function normalizeText(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // quita signos
    .replace(/\s+/g, " ")
    .trim();
}

export function wantsAdvanceStage(input: string) {
  const t = normalizeText(input);

  // confirmaciones típicas (texto corto)
  if (["si", "sí", "ok", "okay", "dale", "listo", "vamos", "de acuerdo"].includes(t)) return true;

  // frases comunes de avanzar
  if (t.includes("pasemos") || t.includes("avancemos") || t.includes("continuemos") || t.includes("sigamos")) return true;

  // intención explícita: pasar / avanzar a etapa 5 / pareto
  if (
    t.includes("pasar a") ||
    t.includes("pasemos a") ||
    t.includes("ir a") ||
    t.includes("vamos a")
  ) {
    if (
      t.includes("etapa 5") ||
      t.includes("etapa cinco") ||
      t.includes("quinta etapa") ||
      t.includes("fase 5") ||
      t.includes("pareto") ||
      t.includes("5ta") ||
      t.includes("5a")
    ) {
      return true;
    }
  }

  // menciona etapa 4 o etapa 5 explícitamente
  if (t.includes("etapa 4") || t.includes("etapa cuatro") || t.includes("fase 4")) return true;
  if (t.includes("etapa 5") || t.includes("etapa cinco") || t.includes("fase 5") || t.includes("pareto")) return true;

  return false;
}

export function wantsKeepAdding(text: string) {
  const t = normalizeText(text).trim();

  // Si el usuario escribe una causa larga, eso cuenta como "seguir agregando"
  if (looksLikeNewCause(text)) return true;

  return (
    t.includes("seguir") ||
    t.includes("mas") ||            // más
    t.includes("otra") ||
    t.includes("agregar") ||
    t.includes("anadir") ||         // añadir (sin tilde)
    t.includes("añadir") ||
    t.includes("aun") ||            // aún
    t.includes("todavia") ||
    t.includes("todavía")
  );
}

function looksLikeNewCause(text: string) {
  const t = (text || "").trim();

  // Si es pregunta, normalmente es meta (no es una nueva causa)
  if (t.endsWith("?")) return false;

  // Muy corto suele ser confirmación ("ok", "sí", etc.)
  if (t.length < 18) return false;

  // Si es una frase relativamente larga, sin signos de pregunta, puede ser causa
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 6;
}

// ✅ SOLO UNA VEZ (y usa hasHorasPhrase)
export function isHoursIntent(text: string) {
  const t = normalizeText(text);

  const hasHora = t.includes("hora");

  const hasReg =
    t.includes("registr") ||
    t.includes("cargar") ||
    t.includes("llenar") ||
    t.includes("subir") ||
    t.includes("anotar");

  const hasHorasPhrase =
    t.includes("mis horas") ||
    t.includes("registro de horas") ||
    t.includes("reporte de horas");

  return (hasHora && hasReg) || hasHorasPhrase;
}

export function isGreetingOrSmallTalk(text: string) {
  const t = normalizeText(text).trim();

  const greetings = [
    "hola",
    "holaa",
    "buenas",
    "buenos dias",
    "buen dia",
    "buenas tardes",
    "buenas noches",
    "hey",
    "que tal",
    "como estas",
    "como esta",
    "saludos",
  ];

  // coincidencia exacta o que sea MUY corto tipo "hola!"
  if (greetings.includes(t)) return true;

  const startsWithGreeting =
    t.startsWith("hola") ||
    t.startsWith("buenas") ||
    t.startsWith("buenos dias") ||
    t.startsWith("buen dia") ||
    t.startsWith("buenas tardes") ||
    t.startsWith("buenas noches") ||
    t.startsWith("hey") ||
    t.startsWith("saludos");

  if (startsWithGreeting && t.length <= 25) return true;

  return false;
}

export function isProdQuestion(text: string) {
  const t = normalizeText(text);
  return (
    t.endsWith("?") ||
    t.includes("no entiendo") ||
    t.includes("explicame") ||
    t.includes("como") ||
    t.includes("por que") ||
    t.includes("que significa") ||
    t.includes("ejemplo")
  );
}

export function isReadyIntent(text: string) {
  const t = normalizeText(text).trim();
  return (
    t === "ok" ||
    t === "okay" ||
    t === "listo" ||
    t === "dale" ||
    t === "si" ||
    t === "sí" ||
    t.includes("empecemos") ||
    t.includes("iniciemos") ||
    t.includes("continuemos")
  );
}

export function isConfirmIntent(text: string) {
  const t = normalizeText(text).trim();
  return (
    t === "si" ||
    t === "sí" ||
    t.includes("confirmo") ||
    t.includes("confirmar") ||
    t.includes("de acuerdo") ||
    t.includes("ok confirmo")
  );
}
