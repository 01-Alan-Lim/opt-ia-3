// src/app/chat/_lib/turns/stage0Turn.ts
//
// Turno del asesor para la Etapa 0 (Contexto del caso), movido desde handleStage0DraftFlowV2
// (page.tsx). handleSend lo llama mientras el contexto no está confirmado. Cómo se decide el turno:
//   1. Lectura fresca del contexto: otra pestaña pudo registrar un dato o confirmar E0.
//   2. La intención va primero. Lo que no es una respuesta (pedir empezar, saludar, "ok", preguntar,
//      pedir ayuda o un ejemplo, "no sé", rechazar dar el dato, aplazarlo, dejarlo en otro, quedarse
//      en lo vago o solo negar) se contesta sin guardar nada y sin Gemini. Qué hace el mensaje lo lee
//      studentMessageActs.ts; la extracción lee solo lo que el estudiante afirma (sin lo negado ni las
//      dudas), y cada valor pasa el control de calidad de stage0Values.ts.
//   3. Si Gemini interpretó el mensaje, manda su lectura, validada igual que la propia y apoyada en
//      palabras enteras del mensaje; la extracción determinista queda para cuando no se le consultó.
//      Si no respondió, lo determinista vale solo para mensajes cortos: un mensaje largo no se guarda
//      a medias y se pide resumirlo.
//   4. Sin datos, se usa el intent de Gemini (antes se ignoraba) con textos propios: su
//      clarificationQuestion volvía a hacer la pregunta que el estudiante ya tenía a la vista.
//   5. Pedir empezar o saludar recibe la apertura completa solo si el estudiante todavía no vio
//      ninguna pregunta de E0 en este chat (Stage0PromptTracker, compartido con la apertura).
//   6. La ayuda, los ejemplos y el "no sé" hablan del dato que nombra el mensaje ("¿qué significa
//      área de intervención?" mientras se pide el rubro) y retoman la pregunta en curso.
//   7. Con los tres datos E0 NO se confirma sola: se muestra el resumen y se pregunta si se registra.
//      Mientras el borrador tiene los tres datos, el turno atiende la revisión: un "sí" explícito
//      (isStage0ReviewConfirmation) llama a la confirmación del servidor con los datos revisados;
//      una corrección cambia el dato y vuelve a mostrar el resumen. Antes, el tercer dato confirmaba
//      E0 en el mismo turno, aunque fuera "Todavía no lo decido".

import {
  askForMissingStage0Field,
  buildStage0AnonymityReply,
  buildStage0Clarification,
  buildStage0Confirmed,
  buildStage0ContextChange,
  buildStage0ProgressMessage,
  buildStage0Reply,
  buildStage0RetryShort,
  buildStage0Review,
  buildStage0ReviewReply,
  classifyStage0DecisionIntent,
  detectEditingField,
  detectStage0Intent,
  extractStage0Deterministic,
  getNextStage0StepFromContext,
  hasMultipleStage0FieldSignals,
  hasStage0Extraction,
  hasStage0ProductSignal,
  isLongStage0Message,
  isStage0ReviewConfirmation,
  readStage0Context,
  readStage0Extraction,
  readStage0Message,
  shouldAnswerWithoutLLM,
  STAGE0_ANONYMITY_NOTE,
  stage0CorrectionLead,
  stage0CorrectionQuestion,
  stage0FieldMentioned,
  stage0FieldNegated,
  stage0QuestionFor,
  stage0ReviewKey,
  stage0StepForField,
  type EditTarget,
  type Stage0ContextJson,
  type Stage0DecisionIntent,
  type Stage0InterpretPayload,
  type Stage0Step,
} from "@/lib/plan/stage0Context";
import { findCompanyNames, validateStage0Extraction, type Stage0Rejected } from "@/lib/plan/stage0Values";
import type { StudentMessageReading } from "@/lib/plan/studentMessageActs";
import type { Stage0PromptTracker } from "../stage0Opening";
import type { PlanContextStatus } from "./types";

// Lo que el turno lee de las respuestas de /api/plans/context y /api/plans/context/confirm.
type ContextApiPayload = {
  chatId?: string | null;
  contextText?: string | null;
  contextJson?: unknown;
  message?: string;
  code?: string;
};
type ContextApiResult = { ok: boolean; payload: ContextApiPayload | null };

export type Stage0TurnDeps = {
  chatId: () => string | null;
  // Nombre de pila del perfil (describeChatIdentity), para la apertura completa.
  greetingName: string | null;
  editingField: EditTarget;
  setEditingField: (field: EditTarget) => void;
  setStage0Draft: (draft: Stage0ContextJson) => void;
  setAwaitingStage1Start: (value: boolean) => void;
  tracker: Stage0PromptTracker;
  appendAssistant: (text: string) => Promise<void>;
  // POST /api/plans/context/interpret (Gemini).
  interpret: (step: Stage0Step, text: string, ctxJson: Record<string, unknown>) => Promise<{ ok: boolean; payload: unknown }>;
  // POST /api/plans/context (borrador): solo los campos de extracted; base completa el texto.
  saveDraft: (extracted: Stage0ContextJson, base: Stage0ContextJson) => Promise<ContextApiResult>;
  // POST /api/plans/context/confirm con los tres datos que el estudiante revisó.
  confirm: (reviewed: Stage0ContextJson) => Promise<ContextApiResult>;
  // GET /api/plans/context sin caché, y escritura del caché de page.tsx.
  refreshContext: () => Promise<PlanContextStatus>;
  cacheContext: (data: PlanContextStatus) => void;
};

// Intent de /api/plans/context/interpret cuando no trajo datos: el texto lo pone el asesor.
const LLM_INTENT_REPLY: Partial<Record<string, Stage0DecisionIntent>> = {
  START: "start",
  GREETING: "greeting",
  CONFIRM: "confirm",
  QUESTION: "help_request",
  DECLINE: "refusal",
};

type Stage0TurnState = {
  deps: Stage0TurnDeps;
  text: string;
  reading: StudentMessageReading;
  intent: Stage0DecisionIntent;
  ctx: PlanContextStatus;
  ctxJson: Record<string, unknown>;
  current: Stage0ContextJson;
  chatId: string | null;
  alreadyPrompted: boolean;
};

export async function handleStage0Turn(
  deps: Stage0TurnDeps,
  turn: { text: string; ctx: PlanContextStatus }
): Promise<boolean> {
  const { appendAssistant, editingField, tracker } = deps;
  const { text } = turn;

  const fresh = await deps.refreshContext();
  const ctx = fresh.ok ? fresh : turn.ctx;
  const ctxJson = (ctx.contextJson ?? {}) as Record<string, unknown>;
  const current = readStage0Context(ctxJson);

  // Otra pestaña ya confirmó E0: se informa y se sigue con E1, sin volver a confirmar.
  if (ctx.status === "confirmed") {
    finishStage0(deps, ctx, ctxJson);
    await appendAssistant(buildStage0Confirmed(current, { already: true }));
    return true;
  }

  const reading = readStage0Message(text);
  const intent = classifyStage0DecisionIntent(text, detectStage0Intent(text), reading);

  // Todo camino de este turno responde con una pregunta o un recordatorio de E0.
  const chatId = deps.chatId();
  const alreadyPrompted = tracker.wasPrompted(chatId);
  tracker.markPrompted(chatId);

  const state: Stage0TurnState = { deps, text, reading, intent, ctx, ctxJson, current, chatId, alreadyPrompted };
  const nextStep = getNextStage0StepFromContext(current);

  // Desiste del cambio que había pedido ("déjalo así"): el dato queda como estaba.
  if (editingField && reading.acts.cancel) {
    deps.setEditingField(null);
    if (nextStep === 0) {
      tracker.markReviewShown(chatId, stage0ReviewKey(current));
      await appendAssistant(buildStage0Review(current, "Lo dejamos como estaba."));
    } else {
      await appendAssistant(`Lo dejamos como estaba.\n\n${askForMissingStage0Field(nextStep, current)}`);
    }
    return true;
  }

  // Los tres datos en borrador: falta que el estudiante los revise y confirme.
  if (nextStep === 0 && !editingField) {
    return handleStage0Review(state);
  }

  const step: Stage0Step = stage0StepForField(editingField) ?? (nextStep === 0 ? 3 : nextStep);
  const topic = stage0StepForField(stage0FieldMentioned(text)) ?? step;

  if (shouldAnswerWithoutLLM(intent)) {
    await appendAssistant(
      buildStage0Reply({
        intent,
        step,
        context: current,
        alreadyPrompted,
        greetingName: deps.greetingName,
        topic,
        editing: editingField !== null,
      })
    );
    return true;
  }

  if (intent === "context_change") {
    deps.setEditingField("sector");
    await appendAssistant(buildStage0ContextChange());
    return true;
  }

  const answer = await readStage0Answer(state, step, editingField);

  if (hasStage0Extraction(answer.values)) {
    // Cambiar un dato que ya estaba dice qué cambió ("Actualicé el rubro…"), no "registré".
    const target = answer.target;
    const hadValue = target === "sector" ? Boolean(current.sector) : Boolean(target && current[target]?.length);
    return saveStage0Answer(state, answer, (live) =>
      buildStage0ProgressMessage(answer.values, live, {
        tentative: answer.tentative,
        note: answer.note,
        corrected: target && hadValue ? target : undefined,
      })
    );
  }

  if (answer.unavailable) {
    await appendAssistant(buildStage0RetryShort(step));
    return true;
  }

  if (answer.companyName) {
    await appendAssistant(buildStage0AnonymityReply(step));
    return true;
  }

  if (intent === "correction") {
    const targetStep = stage0StepForField(answer.target);
    if (answer.target && targetStep) {
      deps.setEditingField(answer.target);
      await appendAssistant("Lo ajustamos sin reiniciar el contexto.\n\n" + askForMissingStage0Field(targetStep, current));
      return true;
    }

    await appendAssistant(
      "Podemos corregir el contexto. Dime si quieres cambiar el **rubro**, el **producto o servicio** o el **área o proceso**."
    );
    return true;
  }

  const llmIntent = answer.llmIntent ? LLM_INTENT_REPLY[answer.llmIntent] : undefined;
  if (llmIntent) {
    await appendAssistant(
      buildStage0Reply({ intent: llmIntent, step, context: current, alreadyPrompted, greetingName: deps.greetingName, topic })
    );
    return true;
  }

  await appendAssistant(buildStage0Clarification(step));
  return true;
}

// ---------------- Lectura de la respuesta ----------------

type Stage0Answer = {
  // Lo que se guarda (ya validado).
  values: Stage0ContextJson;
  // Campo que se corrige (el que se está editando, el que nombra la corrección o el negado).
  target: EditTarget;
  tentative: boolean;
  // Gemini no respondió y el mensaje era largo: no se guarda nada a medias.
  unavailable: boolean;
  // El mensaje nombraba a la empresa o una marca y no se registró.
  companyName: boolean;
  note?: string;
  llmIntent?: string;
};

function readRejected(value: unknown): Stage0Rejected[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Stage0Rejected =>
          Boolean(item) && typeof item === "object" && typeof (item as { reason?: unknown }).reason === "string"
      )
    : [];
}

async function readStage0Answer(state: Stage0TurnState, step: Stage0Step, editingField: EditTarget): Promise<Stage0Answer> {
  const { deps, text, reading, intent, current, ctxJson } = state;
  const content = reading.content;

  // "No era yogur sino queso": lo negado dice qué dato se corrige.
  const negatedField = stage0FieldNegated(reading.negated, current);
  const target: EditTarget =
    editingField ?? (intent === "correction" ? (detectEditingField(content) ?? negatedField) : negatedField);
  const deterministic = extractStage0Deterministic(content, step, target);
  const long = isLongStage0Message(content);
  const companyNamed = findCompanyNames(text).length > 0;

  // Una corrección sin el dato nuevo ("quiero cambiar el rubro") se contesta sin Gemini: el valor
  // llega en el mensaje siguiente. Un mensaje que solo nombra a la empresa, tampoco.
  const correctionWithoutValue = intent === "correction" && !hasStage0Extraction(deterministic) && !long;
  const onlyCompanyName = companyNamed && !hasStage0Extraction(deterministic) && !long;

  const shouldAskLLM =
    !correctionWithoutValue &&
    !onlyCompanyName &&
    (hasMultipleStage0FieldSignals(content) ||
      !hasStage0Extraction(deterministic) ||
      long ||
      (!target && step === 1 && hasStage0ProductSignal(content) && !deterministic.sector));

  const interpreted = shouldAskLLM ? await deps.interpret(step, text, ctxJson) : { ok: true, payload: null };
  const result = interpreted.ok && interpreted.payload ? (interpreted.payload as Stage0InterpretPayload) : null;

  let values: Stage0ContextJson;
  let rejected: Stage0Rejected[] = [];
  let unavailable = false;
  if (result) {
    // La lectura de Gemini se valida igual que la propia, aunque ya venga validada del servidor.
    const checked = validateStage0Extraction(readStage0Extraction(result), text);
    values = checked.values;
    rejected = [...readRejected(result.rejected), ...checked.rejected];
  } else if (shouldAskLLM && long) {
    values = {};
    unavailable = hasStage0Extraction(deterministic);
  } else {
    values = deterministic;
  }

  if (target) values = { [target]: values[target] };

  // Una lista corregida por negación conserva lo que no se negó ("no era yogur sino queso" con
  // Yogur y Leche deja Queso y Leche).
  if (target && target === negatedField && target !== "sector") {
    const added = values[target];
    const kept = (current[target] ?? []).filter((item) => !stage0FieldNegated(reading.negated, { [target]: [item] }));
    if (added?.length) values = { [target]: dedupe([...added, ...kept]).slice(0, 3) };
  }

  const companyName = companyNamed || rejected.some((item) => item.reason === "company_name");
  return {
    values,
    target,
    unavailable,
    companyName,
    note: companyName ? STAGE0_ANONYMITY_NOTE : undefined,
    tentative:
      reading.acts.hedged ||
      reading.acts.uncertain ||
      /[?¿]/.test(text) ||
      (result?.needsClarification === true && hasStage0Extraction(values)),
    llmIntent: typeof result?.intent === "string" ? result.intent : undefined,
  };
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Guarda el borrador y responde con el dato siguiente o, con los tres, con el resumen para revisar.
async function saveStage0Answer(
  state: Stage0TurnState,
  answer: Stage0Answer,
  message: (live: Stage0ContextJson) => string
): Promise<boolean> {
  const { deps, ctx, current, chatId } = state;
  const saved = await deps.saveDraft(answer.values, current);

  if (!saved.ok) {
    await deps.appendAssistant(
      saved.payload?.code === "INVALID_CONTEXT_VALUE" && saved.payload.message
        ? saved.payload.message
        : "No pude guardar el contexto en este momento. Intenta otra vez."
    );
    return true;
  }

  const refreshed = await deps.refreshContext();
  const live = refreshed.ok
    ? readStage0Context((refreshed.contextJson ?? {}) as Record<string, unknown>)
    : readStage0Context({ ...current, ...answer.values });

  deps.setStage0Draft(live);
  deps.setEditingField(null);
  deps.cacheContext({
    ...ctx,
    exists: true,
    status: "draft",
    chatId: refreshed.ok ? refreshed.chatId : ((saved.payload?.chatId ?? ctx.chatId) as string | null),
    contextJson: live,
    contextText: refreshed.ok ? refreshed.contextText : ((saved.payload?.contextText ?? ctx.contextText) as string | null),
  });

  // Con los tres datos, el resumen que ve el estudiante es el que después confirma.
  if (getNextStage0StepFromContext(live) === 0) deps.tracker.markReviewShown(chatId, stage0ReviewKey(live));

  await deps.appendAssistant(message(live));
  return true;
}

// ---------------- Revisión y confirmación ----------------

async function handleStage0Review(state: Stage0TurnState): Promise<boolean> {
  const { deps, text, reading, intent, current, alreadyPrompted } = state;

  if (isStage0ReviewConfirmation(text)) return confirmStage0(state);

  if (intent === "context_change") {
    deps.setEditingField("sector");
    await deps.appendAssistant(buildStage0ContextChange());
    return true;
  }

  const mentioned = stage0FieldMentioned(reading.content);
  const corrects =
    intent === "correction" ||
    intent === "negated" ||
    reading.acts.disagrees ||
    reading.acts.negation ||
    (intent === "answer" && mentioned !== null);

  if (!corrects) {
    if (intent === "answer") {
      // Un valor sin decir de qué dato es ("Queso"): se pregunta cuál cambiar.
      await deps.appendAssistant(`No me queda claro qué dato quieres cambiar.\n\n${stage0CorrectionQuestion()}`);
      return true;
    }
    const topic = stage0StepForField(stage0FieldMentioned(text));
    await deps.appendAssistant(
      buildStage0ReviewReply({ intent, context: current, alreadyPrompted, greetingName: deps.greetingName, topic })
    );
    return true;
  }

  const target = detectEditingField(reading.content) ?? stage0FieldNegated(reading.negated, current);
  const targetStep = stage0StepForField(target);
  if (!target || !targetStep) {
    await deps.appendAssistant(`Lo ajustamos sin reiniciar el contexto.\n\n${stage0CorrectionQuestion()}`);
    return true;
  }

  const answer = await readStage0Answer({ ...state, intent: "correction" }, targetStep, target);
  if (hasStage0Extraction(answer.values)) {
    return saveStage0Answer(state, answer, (live) => {
      const notes = [answer.tentative ? "Lo anoto como provisional; revísalo con calma antes de registrarlo." : "", answer.note ?? ""];
      return buildStage0Review(live, [stage0CorrectionLead(target, live), ...notes].filter(Boolean).join(" "));
    });
  }
  if (answer.unavailable) {
    await deps.appendAssistant(buildStage0RetryShort(targetStep));
    return true;
  }
  if (answer.companyName) {
    await deps.appendAssistant(buildStage0AnonymityReply(targetStep));
    return true;
  }

  deps.setEditingField(target);
  await deps.appendAssistant(`Lo ajustamos sin reiniciar el contexto.\n\n${stage0QuestionFor(targetStep)}`);
  return true;
}

async function confirmStage0(state: Stage0TurnState): Promise<boolean> {
  const { deps, ctx, current, chatId } = state;

  // El contexto cambió desde que se mostró el resumen en esta pestaña (otra pestaña lo corrigió):
  // se muestra el actual y se vuelve a preguntar.
  const shown = deps.tracker.reviewShown(chatId);
  const key = stage0ReviewKey(current);
  if (shown && shown !== key) {
    deps.tracker.markReviewShown(chatId, key);
    await deps.appendAssistant(
      buildStage0Review(current, "El contexto cambió mientras lo revisabas (por ejemplo, desde otra pestaña).")
    );
    return true;
  }

  const confirmed = await deps.confirm(current);
  if (!confirmed.ok) {
    await deps.appendAssistant(
      confirmed.payload?.message || "Guardé el contexto, pero no pude registrarlo todavía. Intenta nuevamente."
    );
    return true;
  }

  const confirmedFresh = await deps.refreshContext();
  const finalJson = (
    confirmedFresh.ok ? confirmedFresh.contextJson : (confirmed.payload?.contextJson ?? current)
  ) as Record<string, unknown>;

  finishStage0(
    deps,
    {
      ...ctx,
      chatId: (confirmed.payload?.chatId ?? ctx.chatId) as string | null,
      contextText: (confirmed.payload?.contextText ?? ctx.contextText) as string | null,
    },
    finalJson
  );
  await deps.appendAssistant(buildStage0Confirmed(readStage0Context(finalJson)));
  return true;
}

// E0 confirmada: el caché de page.tsx y el arranque de E1 ("productividad" u "ok").
function finishStage0(deps: Stage0TurnDeps, ctx: PlanContextStatus, contextJson: Record<string, unknown>) {
  deps.cacheContext({ ...ctx, ok: true, exists: true, status: "confirmed", contextJson });
  deps.setStage0Draft(readStage0Context(contextJson));
  deps.setEditingField(null);
  deps.setAwaitingStage1Start(true);
}
