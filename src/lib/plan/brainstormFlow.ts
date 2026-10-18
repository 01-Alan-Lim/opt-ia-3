// src/lib/plan/brainstormFlow.ts

// Mínimo de causas para cerrar la Etapa 3. Es una regla del método, no un dato del
// estudiante: vive aquí y NUNCA se lee del estado. Antes salía de state.minIdeas, que
// viaja por el cliente, así que el mínimo se podía bajar desde el navegador.
export const MIN_BRAINSTORM_IDEAS = 10;

export type BrainstormStrategyType = "FO" | "DO" | "FA" | "DA";

export type BrainstormStep =
  | "choose_strategy"
  | "define_problem"
  | "generate_causes"
  | "review";

export type BrainstormIdea = {
  text: string;
};

export type BrainstormState = {
  step: BrainstormStep;
  strategy: {
    type: BrainstormStrategyType;
    rationale?: string;
  } | null;
  problem: {
    text: string;
  } | null;
  ideas: BrainstormIdea[];
  minIdeas: number;
};

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function asString(input: unknown): string {
  return String(input ?? "").trim();
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStrategyType(input: unknown): BrainstormStrategyType | null {
  const value = asString(input).toUpperCase();

  if (value === "FO" || value === "DO" || value === "FA" || value === "DA") {
    return value;
  }

  return null;
}

function dedupeIdeas(rawIdeas: unknown): BrainstormIdea[] {
  if (!Array.isArray(rawIdeas)) return [];

  const out: BrainstormIdea[] = [];
  const seen = new Set<string>();

  for (const item of rawIdeas) {
    const record = asRecord(item);
    const text = asString(record.text || item).slice(0, 400);

    if (!text) continue;

    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push({ text });
  }

  return out;
}

export function resolveBrainstormStep(
  state: Pick<BrainstormState, "strategy" | "problem" | "ideas">
): BrainstormStep {
  const strategyType = state.strategy?.type ?? null;
  const problemText = asString(state.problem?.text);
  const ideasCount = Array.isArray(state.ideas) ? state.ideas.length : 0;

  if (!strategyType) return "choose_strategy";
  if (!problemText) return "define_problem";
  if (ideasCount >= MIN_BRAINSTORM_IDEAS) return "review";
  return "generate_causes";
}

export function sanitizeBrainstormState(input: unknown): BrainstormState {
  const source = asRecord(input);
  const strategy = asRecord(source.strategy);
  const problem = asRecord(source.problem);

  const strategyType = normalizeStrategyType(strategy.type);
  const rationale = asString(strategy.rationale).slice(0, 500);

  const problemText =
    typeof source.problem === "string"
      ? asString(source.problem)
      : asString(problem.text);

  // minIdeas NO se lee de `source`: es autoridad del servidor (MIN_BRAINSTORM_IDEAS).
  const base: BrainstormState = {
    step: "choose_strategy",
    strategy: strategyType
      ? {
          type: strategyType,
          ...(rationale ? { rationale } : {}),
        }
      : null,
    problem: problemText
    ? {
        text: problemText.slice(0, 1200),
      }
    : null,
    ideas: dedupeIdeas(source.ideas),
    minIdeas: MIN_BRAINSTORM_IDEAS,
  };

  return {
    ...base,
    step: resolveBrainstormStep(base),
  };
}

export function mergeBrainstormState(
  baseRaw: unknown,
  incomingRaw: unknown
): BrainstormState {
  const base = sanitizeBrainstormState(baseRaw);
  const incoming = asRecord(incomingRaw);

  const merged = {
    strategy: Object.prototype.hasOwnProperty.call(incoming, "strategy")
      ? incoming.strategy
      : base.strategy,
    problem: Object.prototype.hasOwnProperty.call(incoming, "problem")
      ? incoming.problem
      : base.problem,
    ideas: Object.prototype.hasOwnProperty.call(incoming, "ideas")
      ? incoming.ideas
      : base.ideas,
    // minIdeas no se fusiona: sanitizeBrainstormState lo fija a MIN_BRAINSTORM_IDEAS.
    step: Object.prototype.hasOwnProperty.call(incoming, "step")
      ? incoming.step
      : base.step,
  };

  return sanitizeBrainstormState(merged);
}

export function isBrainstormReadyToClose(state: BrainstormState | null): boolean {
  if (!state) return false;
  return resolveBrainstormStep(state) === "review";
}