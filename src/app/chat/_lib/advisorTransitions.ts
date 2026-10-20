// src/app/chat/_lib/advisorTransitions.ts
//
// Transiciones y restauración del Asesor de Plan de Mejora, movidas tal cual desde page.tsx:
// - piezas puras: cómo se lee la etapa siguiente que autoriza el servidor al validar
//   (next.toStage: solo 3-10; el cliente no la inventa), las causas críticas de Pareto, cuándo
//   conservar el estado local si /api/plans/active-stage falla, y asRecordOrNull;
// - el MODELO ISHIKAWA DEL CLIENTE/CHAT (IshikawaState y sus nodos), que NO es el modelo canónico
//   de src/lib/plan/ishikawaTree.ts: se movió tal cual desde page.tsx, sin unificarlo;
// - createAdvisorTransitions(deps): crea en cada render las funciones de transición E2-E10, la
//   restauración en un chat nuevo y la sincronización de la etapa activa. deps solo trae
//   referencias que ya existían en ChatPage (estado, setters, refs, wrappers de API, mensajes).
// E0->E1 y E1->E2 no están aquí: E0 se confirma en el turno de E0 (turns/stage0Turn.ts) y el
// arranque de E1 y el paso a E2 están en el turno de E1 (turns/productivityTurn.ts).

import { createMessage } from "@/lib/chat/assistantFormat";
import { promptProd } from "@/lib/plan/advisorMessages";
import {
  isAdvisorRuntimeStageValue,
  normalizeParetoStateClient,
  sanitizeFodaState,
  type AdvisorRuntimeStage,
  type FinalDocState,
  type FodaState,
  type ImprovementState,
  type ObjectivesState,
  type ParetoState,
  type PlanningState,
  type ProdStep,
  type ProductivityDraft,
  type ProgressState,
} from "@/lib/plan/advisorStates";
import { sanitizeBrainstormState, type BrainstormState } from "@/lib/plan/brainstormFlow";
import type { BranchClosure, PendingRootMatch, RootCauseEntry } from "@/lib/plan/ishikawaTree";
import { MAX_WHY_DEPTH, MIN_ROOT_CAUSES } from "@/lib/plan/rootCauseLimits";
import {
  buildStage0Opening,
  getNextStage0StepFromContext,
  readStage0Context,
} from "@/lib/plan/stage0Context";
import type { Message } from "@/lib/types";
import type { PersistMessageInput } from "./advisorApi";
import type * as AdvisorApi from "./advisorApi";

export function shouldPreserveAdvisorStateOnRefreshFailure(args: {
  currentStage: AdvisorRuntimeStage;
  status: number;
  errorCode?: string | null;
}) {
  if (args.currentStage == null || args.currentStage <= 0) return false;

  if (args.status >= 500) return true;
  if (args.errorCode === "AUTH_UPSTREAM_TIMEOUT") return true;

  return false;
}

export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type ValidationPayloadLike = {
  next?: { toStage?: number | null; hint?: string | null } | null;
  roots?: string[] | null;
  final?: {
    criticalRoots?: string[] | null;
    selectedRoots?: string[] | null;
  } | null;
};

export function readNextStageFromValidation(
  payload: ValidationPayloadLike | null | undefined
): 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null {
  const raw = payload?.next?.toStage;
  return raw === 3 ||
    raw === 4 ||
    raw === 5 ||
    raw === 6 ||
    raw === 7 ||
    raw === 8 ||
    raw === 9 ||
    raw === 10
    ? raw
    : null;
}

export function readCriticalRootsFromValidation(
  payload: ValidationPayloadLike | null | undefined
): string[] {
  const raw = payload?.final?.criticalRoots;
  if (!Array.isArray(raw)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const text = String(item ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }

  return out;
}

// -----------------------------
// Modelo Ishikawa del cliente/chat (no es el canónico de ishikawaTree.ts)
// -----------------------------

export type IshikawaSubCause = {
  id: string;
  text: string;
  whys?: string[];
  rejectedWhyAttempts?: number; // rechazos deterministas seguidos en esta subcausa
  reformulateWhy?: boolean; // el próximo porqué aceptado reemplaza al último
  whysReplace?: boolean; // solo en tránsito: la lista de porqués es autoritativa al guardar
  closure?: BranchClosure; // cierre revisado de la rama; solo lo escribe el servidor
};

export type IshikawaMainCause = {
  id: string;
  text: string;
  subCauses: IshikawaSubCause[];
};

export type IshikawaCategoryNode = {
  id: string;
  name: string;
  mainCauses: IshikawaMainCause[];
};

export type IshikawaState = {
  problem: { text: string } | string | null;
  categories: IshikawaCategoryNode[];
  minCategories: number;              // 4-5
  minMainCausesPerCategory: number;   // 2-3
  minSubCausesPerMain: number;        // 2-3
  maxWhyDepth: number;                // tope de porqués (MAX_WHY_DEPTH)
  minRootCandidates: number;
  cursor?: { categoryId?: string; mainCauseId?: string } | null;
  rootCauses?: RootCauseEntry[];                // registro de causas raíz (lo escribe el servidor)
  pendingRootMatch?: PendingRootMatch | null;   // pregunta abierta sobre una raíz repetida
};

// -----------------------------
// Dependencias de las transiciones: referencias que ya existían en ChatPage
// -----------------------------

export type Setter<T> = (value: T) => void;

// Resultado de saveFodaState que leen la restauración de E2, los turnos de E1/E2
// (src/app/chat/_lib/turns) y getFodaSaveErrorMessage.
export type FodaSaveResult = { ok: boolean; skipped?: boolean; reason?: string; status?: number; json?: unknown };

export type AdvisorTransitionDeps = {
  state: {
    activeAdvisorStage: AdvisorRuntimeStage;
    setActiveAdvisorStage: Setter<AdvisorRuntimeStage>;
    setFodaState: Setter<FodaState | null>;
    setBrainstormState: Setter<BrainstormState | null>;
    setBrainstormClosePending: Setter<boolean>;
    setIshikawaState: Setter<IshikawaState | null>;
    setIshikawaClosePending: Setter<boolean>;
    setParetoState: Setter<ParetoState | null>;
    setObjectivesState: Setter<ObjectivesState | null>;
    setImprovementState: Setter<ImprovementState | null>;
    setPlanningState: Setter<PlanningState | null>;
    setProgressState: Setter<ProgressState | null>;
    setFinalDocState: Setter<FinalDocState | null>;
    setProdStep: Setter<ProdStep>;
    setProdDraft: Setter<ProductivityDraft>;
    setStage0Draft: Setter<{ sector?: string; products?: string[]; process_focus?: string[] }>;
    restoredWizardRef: { current: string | null };
    isIshikawaReadyToClose: (st: IshikawaState | null) => boolean;
    syncResumeFlagsForAdvisorStage: (stage: AdvisorRuntimeStage) => void;
  };
  persistence: {
    getActiveAdvisorStage: () => ReturnType<typeof AdvisorApi.getActiveAdvisorStage>;
    getPlanContextStatusCached: (opts?: { force?: boolean }) => Promise<{ contextJson: Record<string, unknown> }>;
    saveFodaState: (state: FodaState, chatIdArg?: string | null) => Promise<FodaSaveResult>;
    saveBrainstormState: (state: BrainstormState, chatId?: string | null) => Promise<unknown>;
    saveIshikawaState: (state: IshikawaState, chatId?: string | null) => Promise<unknown>;
    saveParetoState: (state: ParetoState, chatId?: string | null) => Promise<unknown>;
    saveObjectivesState: (state: ObjectivesState, effectiveChatId?: string | null) => Promise<unknown>;
    saveImprovementState: (state: ImprovementState, effectiveChatId?: string | null) => Promise<unknown>;
    savePlanningState: (state: PlanningState, effectiveChatId?: string | null) => Promise<unknown>;
    saveProgressState: (state: ProgressState, effectiveChatId?: string | null) => Promise<unknown>;
    saveFinalDocState: (state: FinalDocState, effectiveChatId?: string | null) => Promise<unknown>;
    saveProductivityState: (state: { prodStep: number; prodDraft: ProductivityDraft }, currentChatId?: string | null) => Promise<unknown>;
    clearStageState: (stage: number, effectiveChatId?: string | null) => Promise<unknown>;
    getFodaSaveErrorMessage: (result: FodaSaveResult) => string;
  };
  chat: {
    appendAssistant: (content: unknown) => Promise<void>;
    persistMessageDB: (input: PersistMessageInput) => Promise<unknown>;
    setMessages: Setter<Message[]>;
    // Nombre de pila del perfil (describeChatIdentity) para la apertura de E0.
    greetingName: string | null;
  };
};

// Crea, para el render actual, las funciones que antes estaban declaradas dentro de ChatPage.
// Los cuerpos son los mismos: los nombres que leían del componente llegan por deps.
export function createAdvisorTransitions(deps: AdvisorTransitionDeps) {
  const {
    activeAdvisorStage,
    setActiveAdvisorStage,
    setFodaState,
    setBrainstormState,
    setBrainstormClosePending,
    setIshikawaState,
    setIshikawaClosePending,
    setParetoState,
    setObjectivesState,
    setImprovementState,
    setPlanningState,
    setProgressState,
    setFinalDocState,
    setProdStep,
    setProdDraft,
    setStage0Draft,
    restoredWizardRef,
    isIshikawaReadyToClose,
    syncResumeFlagsForAdvisorStage,
  } = deps.state;
  const {
    getActiveAdvisorStage,
    getPlanContextStatusCached,
    saveFodaState,
    saveBrainstormState,
    saveIshikawaState,
    saveParetoState,
    saveObjectivesState,
    saveImprovementState,
    savePlanningState,
    saveProgressState,
    saveFinalDocState,
    saveProductivityState,
    clearStageState,
    getFodaSaveErrorMessage,
  } = deps.persistence;
  const {
    appendAssistant,
    persistMessageDB,
    setMessages,
    greetingName,
  } = deps.chat;

  function clearAdvisorStageStatesLocal() {
    setFodaState(null);
    setBrainstormState(null);
    setIshikawaState(null);
    setIshikawaClosePending(false);
    setParetoState(null);
    setObjectivesState(null);
    setImprovementState(null);
    setPlanningState(null);
    setProgressState(null);
    setFinalDocState(null);
  }

  function applyResolvedAdvisorStage(
    stage: Exclude<AdvisorRuntimeStage, null>,
    stateJson: Record<string, unknown> | null
  ) {
    clearAdvisorStageStatesLocal();
    setActiveAdvisorStage(stage);
    syncResumeFlagsForAdvisorStage(stage);

    if (stage === 10 && stateJson) {
      setFinalDocState(stateJson as FinalDocState);
    } else if (stage === 9 && stateJson) {
      setProgressState(stateJson as ProgressState);
    } else if (stage === 8 && stateJson) {
      setPlanningState(stateJson as PlanningState);
    } else if (stage === 7 && stateJson) {
      setImprovementState(stateJson as ImprovementState);
    } else if (stage === 6 && stateJson) {
      setObjectivesState(stateJson as ObjectivesState);
    } else if (stage === 5 && stateJson) {
      const normalizedPareto = normalizeParetoStateClient(stateJson);
      if (normalizedPareto) {
        setParetoState(normalizedPareto);
      }
    } else if (stage === 4 && stateJson) {
      setIshikawaState(stateJson as IshikawaState);
    } else if (stage === 3 && stateJson) {
      setBrainstormState(stateJson as BrainstormState);
    } else if (stage === 2 && stateJson) {
      const normalizedFoda = sanitizeFodaState(stateJson);
      setFodaState(normalizedFoda);
    } else if (stage === 1 && stateJson) {
      const prodState = stateJson as {
        prodStep?: number;
        prodDraft?: ProductivityDraft;
      };

      const nextProdStep =
        typeof prodState.prodStep === "number"
          ? (prodState.prodStep as ProdStep)
          : 1;

      setProdStep(nextProdStep);
      setProdDraft(prodState.prodDraft ?? {});
    }

    return stage;
  }

  // isCurrent: quien pidió la etapa sigue vigente. Si ya no (cambió el chat o el modo mientras se
  // esperaba), la respuesta no toca la etapa ni los estados locales y devuelve null.
    async function refreshActiveAdvisorStage(isCurrent?: () => boolean) {
    const resolved = await getActiveAdvisorStage();
    if (isCurrent && !isCurrent()) return null;

    if (resolved.ok && resolved.payload?.found && isAdvisorRuntimeStageValue(resolved.payload.stage)) {
      return applyResolvedAdvisorStage(
        resolved.payload.stage,
        asRecordOrNull(resolved.payload.stateJson)
      );
    }

    const errorCode =
      resolved.error && typeof resolved.error.code === "string"
        ? resolved.error.code
        : null;

    if (
      shouldPreserveAdvisorStateOnRefreshFailure({
        currentStage: activeAdvisorStage,
        status: resolved.status,
        errorCode,
      })
    ) {
      console.warn("refreshActiveAdvisorStage: se preserva estado local por fallo temporal", {
        status: resolved.status,
        errorCode,
        currentStage: activeAdvisorStage,
      });

      return activeAdvisorStage;
    }

    clearAdvisorStageStatesLocal();
    setActiveAdvisorStage(0);
    return 0 as AdvisorRuntimeStage;
  }

  async function syncActiveAdvisorStageFromBackend() {
    const localStage = activeAdvisorStage;
    const resolved = await getActiveAdvisorStage();

    if (resolved.ok && resolved.payload?.found && isAdvisorRuntimeStageValue(resolved.payload.stage)) {
      const stateJson = asRecordOrNull(resolved.payload.stateJson);
      const stage = applyResolvedAdvisorStage(resolved.payload.stage, stateJson);

      return {
        ok: true as const,
        stage,
        stateJson,
        changed: stage !== localStage,
      };
    }

    const errorCode =
      resolved.error && typeof resolved.error.code === "string"
        ? resolved.error.code
        : null;

    return {
      ok: false as const,
      status: resolved.status,
      errorCode,
    };
  }

  // Copia el estado de la etapa activa al chat indicado. Ya no se usa al abrir chats: el plan tiene
  // un solo chat (src/lib/plan/planChat.ts) y copiarlo en cada chat nuevo fragmentaba los estados.
  // Queda para la recuperación de E6 en su mismo chat (turns/objectivesTurn.ts).
  async function restoreLatestAdvisorStageToNewChat(effectiveChatId: string) {
    const resolved = await getActiveAdvisorStage();

    if (!resolved.ok || !resolved.payload?.found) {
      return false;
    }

    const stage = resolved.payload.stage as AdvisorRuntimeStage;
    const stateJson = (resolved.payload.stateJson ?? null) as Record<string, unknown> | null;

    clearAdvisorStageStatesLocal();
    setActiveAdvisorStage(stage);
    syncResumeFlagsForAdvisorStage(stage);


    if (stage === 10 && stateJson) {
      const final10 = stateJson as FinalDocState;
      setFinalDocState(final10);
      await saveFinalDocState(final10, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en la **Etapa 10 (Informe final)**.\n\n" +
        "👉 Continúa subiendo, corrigiendo o validando tu informe final.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }


    if (stage === 9 && stateJson) {
      const progress9 = stateJson as ProgressState;
      setProgressState(progress9);
      await saveProgressState(progress9, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 9 (Reporte de avances)**.\n\n" +
        "👉 Continúa registrando avances, evidencias y resultados parciales o finales.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 8 && stateJson) {
      const planning8 = stateJson as PlanningState;
      setPlanningState(planning8);
      await savePlanningState(planning8, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 8 (Planificación / Cronograma)**.\n\n" +
        "👉 Continúa armando el cronograma, responsables, recursos y tiempos.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 7 && stateJson) {
      const improvement7 = stateJson as ImprovementState;
      setImprovementState(improvement7);
      await saveImprovementState(improvement7, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 7 (Plan de Mejora)**.\n\n" +
        "👉 Continúa estructurando la propuesta de mejora.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 6 && stateJson) {
      const objectives6 = stateJson as ObjectivesState;
      setObjectivesState(objectives6);
      await saveObjectivesState(objectives6, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 6 (Objetivos)**.\n\n" +
        "👉 Continúa trabajando el objetivo general y los objetivos específicos.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 5 && stateJson) {
      const pareto5 = normalizeParetoStateClient(stateJson);
      if (!pareto5) return false;

      setParetoState(pareto5);
      await saveParetoState(pareto5, effectiveChatId);

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 5 (Pareto)**.\n\n" +
        "👉 Continúa priorizando tus causas y, cuando corresponda, compárteme las causas críticas.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 4 && stateJson) {
      const ishikawa4 = stateJson as IshikawaState;
      setIshikawaState(ishikawa4);
      setIshikawaClosePending(isIshikawaReadyToClose(ishikawa4));
      await saveIshikawaState(ishikawa4, effectiveChatId);

      const problemText =
        typeof ishikawa4.problem === "string"
          ? ishikawa4.problem
          : typeof (ishikawa4.problem as { text?: unknown } | null)?.text === "string"
            ? String((ishikawa4.problem as { text?: string }).text)
            : null;

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 4 (Ishikawa)**.\n\n" +
        (problemText ? `- Problema principal: **${problemText}**\n\n` : "") +
        "👉 Continúa completando causas, subcausas y profundizando con los 5 porqués donde haga falta.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 3 && stateJson) {
      const brainstorm3 = stateJson as BrainstormState;
      const safeBrainstorm = sanitizeBrainstormState(brainstorm3);

      setBrainstormState(safeBrainstorm);
      await saveBrainstormState(safeBrainstorm, effectiveChatId);

      const nIdeas = Array.isArray((brainstorm3 as { ideas?: unknown[] }).ideas)
        ? (brainstorm3 as { ideas?: unknown[] }).ideas!.length
        : 0;

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 3 (Lluvia de ideas)**.\n\n" +
        `- Ideas registradas: **${nIdeas}**\n\n` +
        "👉 Continúa aportando ideas claras y concretas relacionadas con el problema.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 2) {
      if (stateJson) {
        const foda2 = sanitizeFodaState(stateJson);

        if (!foda2) {
          await appendAssistant(
            "No pude restaurar correctamente tu estado FODA anterior. Reiniciemos esta etapa desde un estado limpio."
          );

          const initial: FodaState = {
            currentQuadrant: "F",
            items: { F: [], D: [], O: [], A: [] },
            pendingEvidence: null,
          };

          setFodaState(initial);
          const saveInitial = await saveFodaState(initial, effectiveChatId);

          if (!saveInitial.ok) {
            await appendAssistant(getFodaSaveErrorMessage(saveInitial));
            return true;
          }

          return true;
        }

        setFodaState(foda2);

        const saveRestored = await saveFodaState(foda2, effectiveChatId);
        if (!saveRestored.ok) {
          await appendAssistant(getFodaSaveErrorMessage(saveRestored));
          return true;
        }

        const currentLabel =
          foda2.currentQuadrant === "F"
            ? "Fortalezas"
            : foda2.currentQuadrant === "D"
              ? "Debilidades"
              : foda2.currentQuadrant === "O"
                ? "Oportunidades"
                : "Amenazas";

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 2 (FODA)**.\n\n" +
          `- Cuadrante actual: **${currentLabel}**\n` +
          `- Fortalezas: **${foda2.items.F.length}**\n` +
          `- Debilidades: **${foda2.items.D.length}**\n` +
          `- Oportunidades: **${foda2.items.O.length}**\n` +
          `- Amenazas: **${foda2.items.A.length}**\n\n` +
          `👉 Continuemos exactamente desde **${currentLabel}**.`;

        setMessages([createMessage("advisor", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
        return true;
      }

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Tu **Contexto del Caso** ya está confirmado.\n\n" +
        "Ahora corresponde continuar con la **Etapa 2 (FODA)**.\n\n" +
        "👉 Empecemos por lo más fácil: dime una **fortaleza interna** de la empresa o del proceso analizado.";

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 1 && stateJson) {
      const prodState = stateJson as { prodStep?: number; prodDraft?: ProductivityDraft };
      const nextProdStep =
        typeof prodState.prodStep === "number" ? (prodState.prodStep as ProdStep) : 1;

      setActiveAdvisorStage(1);
      setProdDraft(prodState.prodDraft ?? {});
      setProdStep(nextProdStep);

      await saveProductivityState(
        {
          prodStep: nextProdStep,
          prodDraft: prodState.prodDraft ?? {},
        },
        effectiveChatId
      );

      const ctx = await getPlanContextStatusCached({ force: true });

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Estabas en **Etapa 1 (Productividad)**.\n\n" +
        promptProd(nextProdStep, ctx.contextJson ?? {}, prodState.prodDraft ?? {});

      // Evita que el efecto de restauración local vuelva a empujar el mismo prompt
      restoredWizardRef.current = effectiveChatId;

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    if (stage === 0) {
      const ctx = await getPlanContextStatusCached({ force: true });
      const next = getNextStage0StepFromContext(ctx.contextJson);
      const step = (next === 0 ? 1 : next) as 1 | 2 | 3;

      setStage0Draft({
        sector: typeof ctx.contextJson?.sector === "string" ? ctx.contextJson.sector : undefined,
        products: Array.isArray(ctx.contextJson?.products) ? ctx.contextJson.products : undefined,
        process_focus: Array.isArray(ctx.contextJson?.process_focus)
          ? ctx.contextJson.process_focus
          : undefined,
      });

      // Misma apertura que la entrada al asesor (stage0Opening.ts).
      const msg = buildStage0Opening(step, readStage0Context(asRecordOrNull(ctx.contextJson) ?? {}), greetingName);

      setMessages([createMessage("advisor", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "advisor", content: msg });
      return true;
    }

    return false;
  }

  async function applyBackendAdvisorAdvance(args: {
    fromStage: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    payload: ValidationPayloadLike | null | undefined;
    effectiveChatId: string;
    initialProblemText?: string | null;
  }) {
    const { fromStage, payload, effectiveChatId, initialProblemText } = args;
    const toStage = readNextStageFromValidation(payload);

    if (toStage === null) {
      return false;
    }

    if (fromStage === 2 && toStage === 3) {
      const initial: BrainstormState = {
        step: "choose_strategy",
        strategy: null,
        problem: null,
        ideas: [],
        minIdeas: 10,
      };

      clearAdvisorStageStatesLocal();
      setBrainstormState(initial);
      setActiveAdvisorStage(3);
      await saveBrainstormState(initial, effectiveChatId);

      await clearStageState(2, effectiveChatId);

      await appendAssistant(
        "✅ **Etapa 2 (FODA) validada**.\n\n" +
          "Ahora pasamos automáticamente a la **Etapa 3: Lluvia de ideas (causas)**.\n\n" +
          "✅ Primero elige tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
          "👉 Escribe por ejemplo: **FO** y dime por qué en 1–2 líneas."
      );

      return true;
    }

    if (fromStage === 3 && toStage === 4) {
      const initialIshikawa: IshikawaState = {
        problem: initialProblemText?.trim() ? { text: initialProblemText.trim() } : null,
        categories: [
          { id: "cat_hombre", name: "Hombre", mainCauses: [] },
          { id: "cat_maquina", name: "Máquina", mainCauses: [] },
          { id: "cat_metodo", name: "Método", mainCauses: [] },
          { id: "cat_material", name: "Material", mainCauses: [] },
          { id: "cat_medida", name: "Medición", mainCauses: [] },
          { id: "cat_entorno", name: "Entorno (Medio ambiente)", mainCauses: [] },
        ],
        minCategories: 3,
        minMainCausesPerCategory: 2,
        minSubCausesPerMain: 1,
        maxWhyDepth: MAX_WHY_DEPTH,
        minRootCandidates: MIN_ROOT_CAUSES,
        cursor: null,
      };

      clearAdvisorStageStatesLocal();
      setBrainstormClosePending(false);
      setIshikawaState(initialIshikawa);
      setActiveAdvisorStage(4);
      await saveIshikawaState(initialIshikawa, effectiveChatId);

      await clearStageState(3, effectiveChatId);

      await appendAssistant(
        "✅ Listo, cerramos la lluvia de ideas y pasamos a **Etapa 4 (Ishikawa)**.\n\n" +
          (initialProblemText?.trim()
            ? `🎯 **Problema (cabeza):** ${initialProblemText.trim()}\n\n` +
              "Respóndeme **OK** si así queda bien, o escríbelo en 1 línea si quieres ajustarlo.\n\n" +
              "Luego me dices **una causa** y la vamos bajando con **porqués** (causa → subcausa → raíz)."
            : "Escríbeme el **problema principal** en **1 línea** (la cabeza del Ishikawa).\n\n" +
              "Después me dices **una causa** y la vamos bajando con **porqués**.")
      );

      return true;
    }

    if (fromStage === 4 && toStage === 5) {
      const roots = Array.isArray(payload?.roots) ? payload.roots : [];

      // Pareto recibe todas las raíces de Ishikawa, sin recorte (CLAUDE.md).
      const initialPareto: ParetoState = {
        roots,
        selectedRoots: roots,
        criteria: [],
        criticalRoots: [],
        criticalEffectPercent: null,
        criticalJustification: null,
        step: "select_roots",
      };

      clearAdvisorStageStatesLocal();
      setIshikawaClosePending(false);
      setParetoState(initialPareto);
      setActiveAdvisorStage(5);
      await saveParetoState(initialPareto, effectiveChatId);

      await clearStageState(4, effectiveChatId);

      const list = roots.map((r, i) => `${i + 1}) ${r}`).join("\n");

      await appendAssistant(
        "✅ Listo, cerramos **Etapa 4 (Ishikawa)** y pasamos a **Etapa 5 (Pareto)**.\n\n" +
          `Estas son las **${roots.length} causas raíz** de tu Ishikawa; con todas ellas harás tu matriz de Pareto en Excel:\n\n` +
          list +
          "\n\n" +
          "👉 Revísalas y responde **OK** para definir los **3 criterios de priorización**."
      );

      return true;
    }

    if (fromStage === 5 && toStage === 6) {
      const criticalRoots = readCriticalRootsFromValidation(payload);

      const initialObjectives: ObjectivesState = {
        generalObjective: "",
        specificObjectives: [],
        linkedCriticalRoots: criticalRoots,
        step: "general",
      };

      clearAdvisorStageStatesLocal();
      setObjectivesState(initialObjectives);
      setActiveAdvisorStage(6);
      await saveObjectivesState(initialObjectives, effectiveChatId);

      await clearStageState(5, effectiveChatId);

      const rootsText =
        criticalRoots.length > 0
          ? `Estas son las causas críticas que quedaron priorizadas:\n- ${criticalRoots.join("\n- ")}\n\n`
          : "";

      await appendAssistant(
        "✅ **Etapa 5 (Pareto) finalizada**.\n\n" +
          "Ahora iniciamos la **Etapa 6: Objetivos del Plan de Mejora**.\n\n" +
          rootsText +
          "👉 Empecemos por el **objetivo general**.\n" +
          "Redáctalo en una sola oración indicando qué vas a mejorar al atacar esas causas críticas."
      );

      return true;
    }

    if (fromStage === 6 && toStage === 7) {
      const initialImprovement: ImprovementState = {
        stageIntroDone: true,
        step: "discover",
        focus: { chosenRoot: null, chosenObjective: null },
        initiatives: [],
        lastSummary: null,
      };

      clearAdvisorStageStatesLocal();
      setImprovementState(initialImprovement);
      setActiveAdvisorStage(7);
      await saveImprovementState(initialImprovement, effectiveChatId);

      await clearStageState(6, effectiveChatId);

      await appendAssistant(
        "✅ **Etapa 6 (Objetivos) finalizada**.\n\n" +
          "Ahora entramos a la **Etapa 7: Plan de Mejora**.\n" +
          "Cuéntame lo primero que se te viene a la mente como mejora (aunque no estés seguro). Si no tienes nada aún, lo construimos juntos."
      );

      return true;
    }

    if (fromStage === 7 && toStage === 8) {
      const initialPlanning: PlanningState = {
        stageIntroDone: false,
        step: "time_window",
        time: {
          studentWeeks: null,
          courseCutoffDate: null,
          effectiveWeeks: null,
          notes: null,
        },
        plan: {
          weekly: [],
          milestones: [],
          risks: [],
        },
        lastSummary: null,
      };

      clearAdvisorStageStatesLocal();
      setPlanningState(initialPlanning);
      setActiveAdvisorStage(8);
      await savePlanningState(initialPlanning, effectiveChatId);

      await clearStageState(7, effectiveChatId);

      await appendAssistant(
        "✅ **Etapa 7 (Plan de Mejora) finalizada**.\n\n" +
          "Ahora pasamos a la **Etapa 8 (Planificación)** para definir tiempos, secuencia y un cronograma realista."
      );

      return true;
    }

    if (fromStage === 8 && toStage === 9) {
      const initialProgress: ProgressState = {
        step: "report",
        reportText: null,
        progressPercent: null,
        measurementNote: null,
        summary: null,
        updatedAtLocal: null,
      };

      clearAdvisorStageStatesLocal();
      setProgressState(initialProgress);
      setActiveAdvisorStage(9);
      await saveProgressState(initialProgress, effectiveChatId);

      await clearStageState(8, effectiveChatId);

      const hint =
        typeof payload?.next?.hint === "string" && payload.next.hint.trim().length > 0
          ? `\n\n${payload.next.hint.trim()}`
          : "";

      await appendAssistant(
        "✅ **Etapa 8 (Planificación) finalizada**.\n\n" +
          "Con esto completaste el **Avance 2**.\n\n" +
          "Ahora iniciamos la **Etapa 9 (Reporte de avances)**.\n\n" +
          "En esta etapa ya no vamos a planificar nuevas actividades, sino a **reportar lo que realmente lograste ejecutar** respecto a tu cronograma.\n\n" +
          "Cuéntame brevemente:\n" +
          "1. Qué actividades sí lograste realizar\n" +
          "2. Qué quedó pendiente\n" +
          "3. Si hubo algún ajuste o desvío frente a lo planificado" +
          hint
      );

      return true;
    }

    if (fromStage === 9 && toStage === 10) {
      const initialFinalDoc: FinalDocState = {
        step: "await_upload",
        versionNumber: 1,
        lastFeedback: null,
        upload: {
          fileName: null,
          storagePath: null,
          extractedText: null,
          uploadedAt: null,
        },
      };

      clearAdvisorStageStatesLocal();
      setFinalDocState(initialFinalDoc);
      setActiveAdvisorStage(10);
      await saveFinalDocState(initialFinalDoc, effectiveChatId);

      await clearStageState(9, effectiveChatId);

      await appendAssistant(
        "✅ **Etapa 9 (Reporte de avances) finalizada.**\n\n" +
          "📄 **Etapa 10 (Documento final)**\n\n" +
          "En esta etapa podemos trabajar de forma conversacional. Si tienes dudas sobre tu plan final, puedes consultarme antes de subir el archivo.\n\n" +
          "Cuando quieras, sube tu Word o PDF con el botón de adjuntar. Haré una revisión crítica cruzando lo que presentes con tus etapas validadas y tu registro de horas.\n\n" +
          "✅ **Máximo 2 versiones**\n\n" +
          "1. **Versión 1**\n" +
          "   Te doy feedback claro y directo para corregir.\n\n" +
          "2. **Versión 2**\n" +
          "   Se toma como versión definitiva y luego se cierra el Asesor."
      );

      return true;
    }

    return false;
  }

  return {
    refreshActiveAdvisorStage,
    syncActiveAdvisorStageFromBackend,
    restoreLatestAdvisorStageToNewChat,
    applyBackendAdvisorAdvance,
  };
}
