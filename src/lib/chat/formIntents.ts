// src/lib/chat/formIntents.ts

export type FormIntent =
  | { kind: "FORM_INITIAL" }
  | { kind: "FORM_MONTHLY" }
  | { kind: "FORM_FINAL" }
  | { kind: "FORM_AMBIGUOUS" }
  | { kind: "NONE" };

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // quita tildes
    .replace(/\s+/g, " ")
    .trim();
}

export function detectFormIntent(inputRaw: string): FormIntent {
  const t = norm(inputRaw);

  // Caso genérico: "dame el formulario", "form", etc.
  const onlyGeneric =
    /^((dame|pasame|envia|enviame|quiero|necesito)\s+)?(el\s+)?(form|formulario)\s*(por favor)?$/.test(t) ||
    /^(form|formulario)$/.test(t);

  if (onlyGeneric) return { kind: "FORM_AMBIGUOUS" };

  // ✅ Respuestas cortas típicas después de la aclaración
  // (no asumimos contexto aquí; el contexto lo chequeamos en route.ts)
  const shortInitial =
    /^(el\s+)?(inicial|inicio|primero|1)$/.test(t) ||
    t === "inicial" ||
    t === "el inicial";

  if (shortInitial) return { kind: "FORM_INITIAL" };

  const shortMonthly =
    /^(el\s+)?(mensual|mes|este mes|seguimiento|productividad|2)$/.test(t) ||
    t === "mensual" ||
    t === "el mensual";

  if (shortMonthly) return { kind: "FORM_MONTHLY" };

  const shortFinal =
    /^(el\s+)?(final|ultimo|último|sistematizacion|sistematización|3)$/.test(t) ||
    t === "final" ||
    t === "el final";

  if (shortFinal) return { kind: "FORM_FINAL" };

  const wantsInitial =
    t.includes("formulario inicial") ||
    t.includes("form inicial") ||
    t.includes("formulario de inicio") ||
    t.includes("form de inicio") ||
    t.includes("encuesta inicial") ||
    t.includes("diagnostico inicial");

  if (wantsInitial) return { kind: "FORM_INITIAL" };

  const wantsMonthly =
    t.includes("formulario mensual") ||
    t.includes("form mensual") ||
    t.includes("formulario de este mes") ||
    t.includes("form de este mes") ||
    t.includes("productividad") ||
    t.includes("seguimiento") ||
    t.includes("formulario de productividad") ||
    t.includes("formulario de seguimiento");

  if (wantsMonthly) return { kind: "FORM_MONTHLY" };

  const wantsFinal =
    t.includes("formulario final") ||
    t.includes("form final") ||
    t.includes("sistematizacion") ||
    t.includes("formulario de sistematizacion") ||
    t.includes("encuesta final");

  if (wantsFinal) return { kind: "FORM_FINAL" };

  // Si menciona formulario pero no califica bien => ambiguo
  if (t.includes("formulario") || t.includes("form ")) {
    return { kind: "FORM_AMBIGUOUS" };
  }

  return { kind: "NONE" };
}
