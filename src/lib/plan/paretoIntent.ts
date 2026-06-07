export type ParetoIntent =
  | "propose_criterion"
  | "ask_help"
  | "ask_example"
  | "ask_meta"
  | "confirm"
  | "ambiguous"
  | "other";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, patterns: readonly string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

function isQuestion(text: string) {
  return text.includes("?") || text.includes("¿");
}

export function detectParetoIntent(message: string): ParetoIntent {
  const raw = String(message ?? "").trim();
  if (!raw) return "other";

  const msg = normalize(raw);

  if (
    [
      "ok",
      "okay",
      "dale",
      "listo",
      "de acuerdo",
      "si",
      "sí",
      "correcto",
    ].includes(msg)
  ) {
    return "confirm";
  }

  if (
    hasAny(msg, [
      "dame un ejemplo",
      "dame ejemplo",
      "un ejemplo",
      "ejemplo",
      "como seria un criterio",
      "como podria ser",
    ])
  ) {
    return "ask_example";
  }

  if (
    hasAny(msg, [
      "no se",
      "no estoy seguro",
      "no entiendo",
      "ayudame",
      "ayuda",
      "orientame",
      "dame ideas",
      "que criterio puedo usar",
      "que criterios puedo usar",
      "que criterio conviene",
      "que criterios convienen",
      "que hago",
      "que sigue",
      "como ponderar",
      "como peso",
      "como asigno peso",
      "explicame como ponderar",
      "que significa",
      "que es impacto",
      "para que sirve",
    ])
  ) {
    return "ask_help";
  }

  if (
    hasAny(msg, [
      "quiero cambiar algo anterior",
      "cambiar algo anterior",
      "volver atras",
      "volver a la etapa anterior",
      "estoy hablando del proceso",
      "sobre el proceso",
      "no estoy proponiendo",
      "no es un criterio",
    ])
  ) {
    return "ask_meta";
  }

  if (isQuestion(raw)) return "ask_help";

  const explicitProposal =
    /\b(un|una)\s+criterio\s+(puede\s+ser|podria\s+ser|seria|es)\b/.test(msg) ||
    /\b(el\s+)?(primer|segundo|tercer)\s+criterio\s+(seria|podria\s+ser|puede\s+ser|es)\b/.test(msg) ||
    /\b(quiero\s+usar|propongo|usaria|definiria)\b/.test(msg);

  const criterionKeywords = [
    "tiempo",
    "costo",
    "impacto",
    "frecuencia",
    "calidad",
    "productividad",
    "entrega",
    "implementacion",
    "controlabilidad",
  ];

  if (explicitProposal && hasAny(msg, criterionKeywords)) {
    return "propose_criterion";
  }

  const words = msg.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 4 && hasAny(msg, criterionKeywords)) {
    return "propose_criterion";
  }

  if (msg.length < 5) return "other";

  return "ambiguous";
}
