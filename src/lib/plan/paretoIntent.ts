export type ParetoIntent =
  | "propose_criterion"
  | "ask_help"
  | "confirm"
  | "other";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function detectParetoIntent(message: string): ParetoIntent {
  const msg = normalize(message);

  if (
    msg.includes("no se") ||
    msg.includes("ayuda") ||
    msg.includes("que hago")
  ) {
    return "ask_help";
  }

  // Si menciona palabras típicas de criterios → asumir propuesta
  if (
    msg.includes("tiempo") ||
    msg.includes("costo") ||
    msg.includes("impacto") ||
    msg.includes("frecuencia") ||
    msg.includes("calidad") ||
    msg.includes("productividad")
  ) {
    return "propose_criterion";
  }

  if (msg.length < 5) return "other";

  return "propose_criterion"; // fallback inteligente
}