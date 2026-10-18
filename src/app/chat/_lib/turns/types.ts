// src/app/chat/_lib/turns/types.ts
//
// Contrato de dependencias de los turnos del asesor (handlers de etapa extraídos de handleSend).
// Solo describe referencias que ya existían en ChatPage: estado del render, setters, refs,
// wrappers de API, mensajes y transiciones. No hay lógica aquí.

import type { BrainstormState } from "@/lib/plan/brainstormFlow";
import type {
  AdvisorRuntimeStage,
  FodaState,
  ImprovementState,
  ObjectivesState,
  ParetoState,
  PlanningState,
  ProdStep,
  ProductivityDraft,
  ProgressState,
} from "@/lib/plan/advisorStates";
import type { IshikawaTurnUi } from "@/lib/plan/ishikawaTree";
import type { SignedAssistantReply } from "@/lib/chat/signedAssistantReply";
import type { Message } from "@/lib/types";
import type * as AdvisorApi from "../advisorApi";
import type {
  FodaSaveResult,
  IshikawaState,
  Setter,
  createAdvisorTransitions,
} from "../advisorTransitions";

// Estado del contexto del caso tal como lo cachea ChatPage (movido tal cual desde page.tsx).
export type PlanContextStatus = {
  ok: boolean;
  status: "draft" | "confirmed";
  exists: boolean;
  chatId: string | null;
  contextJson: any;
  contextText: string | null;
  message?: string | null;
};

export type LastProductivityReport = { ok: boolean; payload: any | null };

type AdvisorTransitions = ReturnType<typeof createAdvisorTransitions>;

export type AdvisorTurnDeps = {
  state: {
    brainstormClosePending: boolean;
    brainstormState: BrainstormState | null;
    chatIdRef: { current: string | null };
    clientId: string;
    fodaState: FodaState | null;
    ishikawaClosePending: boolean;
    messagesRef: { current: Message[] };
    prodDraft: ProductivityDraft;
    prodStep: ProdStep;
    setActiveAdvisorStage: Setter<AdvisorRuntimeStage>;
    setBrainstormClosePending: Setter<boolean>;
    setBrainstormState: Setter<BrainstormState | null>;
    setFodaState: Setter<FodaState | null>;
    setImprovementState: Setter<ImprovementState | null>;
    setIshikawaClosePending: Setter<boolean>;
    setIshikawaState: Setter<IshikawaState | null>;
    setObjectivesState: Setter<ObjectivesState | null>;
    setParetoState: Setter<ParetoState | null>;
    setPlanningState: Setter<PlanningState | null>;
    setProdDraft: Setter<ProductivityDraft>;
    setProdStep: Setter<ProdStep>;
    setProgressState: Setter<ProgressState | null>;
  };
  api: {
    callBrainstormAssistant: (input: {
      studentMessage: string;
      brainstormState: BrainstormState;
      caseContext: unknown;
      stage1Summary: unknown;
      fodaSummary: unknown;
    }) => ReturnType<typeof AdvisorApi.callBrainstormAssistant>;
    callFodaAssistant: (input: {
      studentMessage: string;
      fodaState: FodaState;
      caseContext: unknown;
    }) => ReturnType<typeof AdvisorApi.callFodaAssistant>;
    callImprovementAssistant: (input: {
      studentMessage: string;
      improvementState: ImprovementState;
      caseContext: Record<string, unknown> | null;
      effectiveChatId?: string | null;
    }) => ReturnType<typeof AdvisorApi.callImprovementAssistant>;
    callIshikawaAssistant: (args: {
      studentMessage: string;
      chatId: string;
      ishikawaState: IshikawaState;
      caseContext: unknown;
      stage1Summary: unknown;
      brainstormState: unknown;
      recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{
      ok: boolean;
      assistantMessage: string;
      nextState: IshikawaState;
      ui: IshikawaTurnUi;
      signedReply: SignedAssistantReply | null;
    }>;
    callObjectivesAssistant: (input: {
      studentMessage: string;
      objectivesState: ObjectivesState;
      caseContext: Record<string, unknown> | null;
      effectiveChatId?: string | null;
    }) => ReturnType<typeof AdvisorApi.callObjectivesAssistant>;
    callParetoAssistant: (input: {
      studentMessage: string;
      paretoState: ParetoState;
      caseContext: Record<string, unknown> | null;
    }) => ReturnType<typeof AdvisorApi.callParetoAssistant>;
    callPlanningAssistant: (args: {
      studentMessage: string;
      planningState: PlanningState;
      caseContext: unknown;
      effectiveChatId?: string | null;
    }) => ReturnType<typeof AdvisorApi.callPlanningAssistant>;
    callProductivityAssistant: (input: {
      studentMessage: string;
      prodStep: number;
      prodDraft: ProductivityDraft;
      caseContext: unknown;
    }) => ReturnType<typeof AdvisorApi.callProductivityAssistant>;
    callProgressAssistant: (args: {
      studentMessage: string;
      progressState: ProgressState;
      effectiveChatId?: string | null;
    }) => ReturnType<typeof AdvisorApi.callProgressAssistant>;
    clearProductivityState: () => ReturnType<typeof AdvisorApi.clearProductivityState>;
    clearStageState: (stage: number, effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.clearStageState>;
    getBrainstormState: (chatIdArg?: string | null) => ReturnType<typeof AdvisorApi.getBrainstormState>;
    getFodaSaveErrorMessage: (result: FodaSaveResult) => string;
    getIshikawaState: (args?: { chatId?: string | null }) => ReturnType<typeof AdvisorApi.getIshikawaState>;
    saveBrainstormState: (state: BrainstormState, chatId?: string | null) => Promise<{ ok: boolean }>;
    saveFodaState: (state: FodaState, chatIdArg?: string | null) => Promise<FodaSaveResult>;
    saveImprovementState: (state: ImprovementState, effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.saveGenericStageState>;
    saveIshikawaState: (state: IshikawaState, chatId?: string | null) => Promise<{ ok: boolean }>;
    saveObjectivesState: (state: ObjectivesState, effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.saveGenericStageState>;
    saveParetoState: (state: ParetoState, chatId?: string | null) => Promise<{ ok: boolean }>;
    savePlanningState: (state: PlanningState, effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.saveGenericStageState>;
    saveProductivity: (payload: unknown, chatId?: string | null) => ReturnType<typeof AdvisorApi.saveProductivity>;
    saveProgressState: (state: ProgressState, effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.saveGenericStageState>;
    validateBrainstorm: () => ReturnType<typeof AdvisorApi.validateBrainstorm>;
    validateFoda: (chatIdArg?: string | null) => ReturnType<typeof AdvisorApi.validateFoda>;
    validateImprovement: (effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.validateImprovement>;
    validateIshikawa: () => ReturnType<typeof AdvisorApi.validateIshikawa>;
    validateObjectives: (effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.validateObjectives>;
    validatePareto: (effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.validatePareto>;
    validatePlanning: (effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.validatePlanning>;
    validateProductivity: (period: string) => ReturnType<typeof AdvisorApi.validateProductivity>;
    validateProgress: (effectiveChatId?: string | null) => ReturnType<typeof AdvisorApi.validateProgress>;
  };
  chat: {
    // reply: solo con la respuesta de una ruta assistant (su signedReply), nunca con textos locales.
    appendAssistant: (content: unknown, reply?: SignedAssistantReply | null) => Promise<void>;
    buildRecentMessagesForIshikawa: (maxMessages?: number) => { role: "user" | "assistant"; content: string }[];
  };
  flow: {
    applyBackendAdvisorAdvance: AdvisorTransitions["applyBackendAdvisorAdvance"];
    handleStage6NextStepQuestion: (args: {
      text: string;
      objectivesState: ObjectivesState;
      effectiveChatId: string;
      advisorChatId: string;
    }) => Promise<boolean>;
    isIshikawaReadyToClose: (st: IshikawaState | null) => boolean;
    restoreLatestAdvisorStageToNewChat: AdvisorTransitions["restoreLatestAdvisorStageToNewChat"];
    setAwaitingStage1Start: (cid: string, value: boolean) => void;
    shouldOfferIshikawaStageClose: (st: IshikawaState | null, ui: IshikawaTurnUi) => boolean;
  };
};
