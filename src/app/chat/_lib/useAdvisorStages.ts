// src/app/chat/_lib/useAdvisorStages.ts
//
// Estado del Asesor de Plan de Mejora (E0-E10) y sus effects de carga y autoguardado, movidos tal
// cual desde page.tsx. No decide reglas académicas ni transiciones: cada effect llama a los
// wrappers de page.tsx (que ya resuelven headers y chat activo) y aplica el resultado al estado.
// Los effects van en tres hooks porque page.tsx los llama en las mismas posiciones que tenían,
// intercalados con Ishikawa y con la persistencia del historial; así el orden no cambia.
// El estado de Ishikawa sigue en page.tsx; su tipo (modelo del chat, no unificado con
// ishikawaTree.ts) está en advisorTransitions.ts.

import { useEffect, useRef, useState } from "react";

import type { BrainstormState } from "@/lib/plan/brainstormFlow";
import { promptProd } from "@/lib/plan/advisorMessages";
import {
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
import type { EditTarget } from "@/lib/plan/stage0Context";

// Resultado mínimo que leen los effects de carga de E6-E10 (stage-state genérico).
type StageStateLoad = { ok: boolean; payload: { row?: { state_json?: unknown } | null } | null };

export function useAdvisorStageState() {
  // -----------------------------
  // Etapa 0 Wizard (plan_mejora)
  // -----------------------------
  const [stage0Draft, setStage0Draft] = useState<{
    sector?: string;
    products?: string[];
    process_focus?: string[];
  }>({});

  const [editingField, setEditingField] = useState<EditTarget>(null);

  const [activeAdvisorStage, setActiveAdvisorStage] = useState<AdvisorRuntimeStage>(null);

  const [fodaState, setFodaState] = useState<FodaState | null>(null);
  const [brainstormState, setBrainstormState] = useState<BrainstormState | null>(null);
  const [brainstormClosePending, setBrainstormClosePending] = useState(false);

  const [prodStep, setProdStep] = useState<ProdStep>(0);
  const [prodDraft, setProdDraft] = useState<ProductivityDraft>({});

  // Fuerza re-evaluación del effect del asesor cuando el usuario presiona "Nuevo chat"
  const [advisorRefreshNonce, setAdvisorRefreshNonce] = useState(0);

  const [paretoState, setParetoState] = useState<ParetoState | null>(null);

  const [objectivesState, setObjectivesState] = useState<ObjectivesState | null>(null);

  const [improvementState, setImprovementState] = useState<ImprovementState | null>(null);

  const [planningState, setPlanningState] = useState<PlanningState | null>(null);

  const [progressState, setProgressState] = useState<ProgressState | null>(null);
  const [finalDocState, setFinalDocState] = useState<FinalDocState | null>(null);

  const restoredWizardRef = useRef<string | null>(null);

  const saveWizardTimerRef = useRef<number | null>(null);
  const saveFodaTimerRef = useRef<number | null>(null);

  return {
    stage0Draft,
    setStage0Draft,
    editingField,
    setEditingField,
    activeAdvisorStage,
    setActiveAdvisorStage,
    fodaState,
    setFodaState,
    brainstormState,
    setBrainstormState,
    brainstormClosePending,
    setBrainstormClosePending,
    prodStep,
    setProdStep,
    prodDraft,
    setProdDraft,
    advisorRefreshNonce,
    setAdvisorRefreshNonce,
    paretoState,
    setParetoState,
    objectivesState,
    setObjectivesState,
    improvementState,
    setImprovementState,
    planningState,
    setPlanningState,
    progressState,
    setProgressState,
    finalDocState,
    setFinalDocState,
    restoredWizardRef,
    saveWizardTimerRef,
    saveFodaTimerRef,
  };
}

// Etapa activa y carga de E2/E3 (van antes de la carga de Ishikawa).
export function useAdvisorEarlyStageEffects({
  ready,
  authenticated,
  mode,
  advisorRefreshNonce,
  chatId,
  chatIdRef,
  refreshActiveAdvisorStage,
  setActiveAdvisorStage,
  getFodaState,
  setFodaState,
  getBrainstormState,
  setBrainstormState,
}: {
  ready: boolean;
  authenticated: boolean;
  mode: "general" | "plan_mejora";
  advisorRefreshNonce: number;
  chatId: string | null;
  chatIdRef: { current: string | null };
  refreshActiveAdvisorStage: () => Promise<unknown>;
  setActiveAdvisorStage: (value: AdvisorRuntimeStage) => void;
  getFodaState: (chatIdArg?: string | null) => Promise<{ ok: boolean; payload: { exists?: unknown; state?: unknown } | null }>;
  setFodaState: (value: FodaState | null) => void;
  getBrainstormState: (chatIdArg?: string | null) => Promise<{ ok: boolean; payload: { exists?: unknown; state?: unknown } | null }>;
  setBrainstormState: (value: BrainstormState | null) => void;
}) {
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;

    (async () => {
      const stage = await refreshActiveAdvisorStage();
      if (!active) return;

      if (stage == null) {
        setActiveAdvisorStage(0);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, advisorRefreshNonce, chatId]);



  // -----------------------------
  // 2.x Cargar estado FODA (Etapa 2)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;

    (async () => {
      const res = await getFodaState(chatIdRef.current ?? null);
      if (!active) return;
      if (!res.ok) return;

      if (res.payload?.exists && res.payload?.state) {
        const normalized = sanitizeFodaState(res.payload.state);
        setFodaState(normalized);
      } else {
        setFodaState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);

  // -----------------------------
  // 2.x Cargar estado Brainstorm (Etapa 3)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;

    (async () => {
      const res = await getBrainstormState(chatIdRef.current ?? null);
      if (!active) return;
      if (!res.ok) return;

      // res.payload = { ok, exists, state }
      if (res.payload?.exists && res.payload?.state) {
        setBrainstormState(res.payload.state as any);
      } else {
        setBrainstormState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);
}

// Carga de E6-E9, restauración del wizard de E1 y autoguardado de E1/E2 (entre la carga y el
// autoguardado de Ishikawa).
export function useAdvisorLateStageEffects({
  ready,
  authenticated,
  mode,
  chatId,
  chatIdRef,
  getObjectivesState,
  setObjectivesState,
  getImprovementState,
  setImprovementState,
  getPlanningState,
  setPlanningState,
  getProgressState,
  setProgressState,
  restoredWizardRef,
  getPlanContextStatusCached,
  getProductivityState,
  setProdDraft,
  setProdStep,
  pushAssistantOnce,
  saveWizardTimerRef,
  prodStep,
  prodDraft,
  saveProductivityState,
  saveFodaTimerRef,
  fodaState,
  saveFodaState,
}: {
  ready: boolean;
  authenticated: boolean;
  mode: "general" | "plan_mejora";
  chatId: string | null;
  chatIdRef: { current: string | null };
  getObjectivesState: (effectiveChatId?: string | null) => Promise<StageStateLoad>;
  setObjectivesState: (value: ObjectivesState | null) => void;
  getImprovementState: (effectiveChatId?: string | null) => Promise<StageStateLoad>;
  setImprovementState: (value: ImprovementState | null) => void;
  getPlanningState: (effectiveChatId?: string | null) => Promise<StageStateLoad>;
  setPlanningState: (value: PlanningState | null) => void;
  getProgressState: (effectiveChatId?: string | null) => Promise<StageStateLoad>;
  setProgressState: (value: ProgressState | null) => void;
  restoredWizardRef: { current: string | null };
  getPlanContextStatusCached: () => Promise<{ ok: boolean; status: "draft" | "confirmed"; contextJson: unknown }>;
  getProductivityState: (currentChatId?: string | null) => Promise<{ ok: boolean; payload: { state?: { prodStep?: unknown; prodDraft?: ProductivityDraft } | null } | null }>;
  setProdDraft: (value: ProductivityDraft) => void;
  setProdStep: (value: ProdStep) => void;
  pushAssistantOnce: (text: string) => void;
  saveWizardTimerRef: { current: number | null };
  prodStep: ProdStep;
  prodDraft: ProductivityDraft;
  saveProductivityState: (state: { prodStep: number; prodDraft: ProductivityDraft }, currentChatId?: string | null) => Promise<unknown>;
  saveFodaTimerRef: { current: number | null };
  fodaState: FodaState | null;
  saveFodaState: (state: FodaState) => Promise<{ ok: boolean }>;
}) {
    // 2.x Cargar estado Objectives (Etapa 6)
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const res = await getObjectivesState(chatId);
      if (!active) return;
      if (!res.ok) return;

      const row = res.payload?.row ?? null;
      const stateJson = row?.state_json ?? null;

      if (stateJson && typeof stateJson === "object") {
        setObjectivesState(stateJson as ObjectivesState);
      } else {
        setObjectivesState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);


  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const res = await getImprovementState(chatId);
      if (!active) return;
      if (!res.ok) return;

      const row = res.payload?.row ?? null;
      const stateJson = row?.state_json ?? null;

      if (stateJson && typeof stateJson === "object") {
        setImprovementState(stateJson as ImprovementState);
      } else {
        setImprovementState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);


  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const res = await getPlanningState(chatId);
      if (!active) return;
      if (!res.ok) return;

      const row = res.payload?.row ?? null;
      const stateJson = row?.state_json ?? null;

      if (stateJson && typeof stateJson === "object") {
        setPlanningState(stateJson as PlanningState);
      } else {
        setPlanningState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);



  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const res = await getProgressState(chatId);
      if (!active) return;
      if (!res.ok) return;

      const row = res.payload?.row ?? null;
      const stateJson = row?.state_json ?? null;

      if (stateJson && typeof stateJson === "object") {
        setProgressState(stateJson as ProgressState);
      } else {
        setProgressState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      // Evita re-restaurar en loop para el mismo chatId
      if (restoredWizardRef.current === chatId) return;

      const ctx = await getPlanContextStatusCached();
      if (!active) return;
      if (!ctx.ok) return;

      // Solo tiene sentido si Etapa 0 está confirmada
      if (ctx.status !== "confirmed") return;

      const st = await getProductivityState(chatId);
      if (!active) return;
      if (!st.ok) return;

      const state = st.payload?.state ?? null;
      const step = state?.prodStep;
      const draft = state?.prodDraft;

      if (typeof step === "number" && step > 0 && draft && typeof draft === "object") {
        setProdDraft(draft);
        setProdStep(step as any);

        // IMPORTANTE: si el chat está "vacío" o no tiene el último prompt, lo reconstruimos
        pushAssistantOnce(promptProd(step as any, ctx.contextJson, draft));

        restoredWizardRef.current = chatId;
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    // Solo persistimos cuando el wizard está activo
    if (prodStep <= 0) return;
    if (!chatIdRef.current) return;

    // debounce
    if (saveWizardTimerRef.current) {
      window.clearTimeout(saveWizardTimerRef.current);
    }

    saveWizardTimerRef.current = window.setTimeout(() => {
      saveProductivityState(
        { prodStep, prodDraft },
        chatIdRef.current
      ).catch(() => {
        // silencioso para no romper UX (pero si quieres luego lo logueamos)
      });
    }, 350);

    return () => {
      if (saveWizardTimerRef.current) window.clearTimeout(saveWizardTimerRef.current);
    };
  }, [ready, authenticated, mode, prodStep, prodDraft]);

  // -----------------------------
  // 2.x Guardar estado FODA (debounce)
  // -----------------------------
    useEffect(() => {
      if (!ready || !authenticated) return;
      if (mode !== "plan_mejora") return;
      if (!fodaState) return;

      if (saveFodaTimerRef.current) {
        window.clearTimeout(saveFodaTimerRef.current);
      }

      saveFodaTimerRef.current = window.setTimeout(() => {
        saveFodaState(fodaState)
          .then((result) => {
            if (!result.ok) {
              console.error("[FODA] autosave failed", result);
            }
          })
          .catch((error) => {
            console.error("[FODA] autosave crashed", error);
          });
      }, 400);

      return () => {
        if (saveFodaTimerRef.current) {
          window.clearTimeout(saveFodaTimerRef.current);
        }
      };
    }, [ready, authenticated, mode, fodaState]);
}

// Carga de E10 (va después de la persistencia del historial).
export function useAdvisorFinalDocEffect({
  ready,
  authenticated,
  mode,
  chatId,
  getFinalDocState,
  setFinalDocState,
}: {
  ready: boolean;
  authenticated: boolean;
  mode: "general" | "plan_mejora";
  chatId: string | null;
  getFinalDocState: (effectiveChatId?: string | null) => Promise<StageStateLoad>;
  setFinalDocState: (value: FinalDocState | null) => void;
}) {
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const res = await getFinalDocState(chatId);
      if (!active) return;
      if (!res.ok) return;

      const row = res.payload?.row ?? null;
      const stateJson = row?.state_json ?? null;

      if (stateJson && typeof stateJson === "object") {
        setFinalDocState(stateJson as FinalDocState);
      } else {
        setFinalDocState(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);
}
