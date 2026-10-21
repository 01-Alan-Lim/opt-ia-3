// src/app/chat/page.tsx
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { HoursInlinePanel } from "@/components/chat/HoursInlinePanel";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
// Estilos y fuentes de las fórmulas que pinta MessageList (KaTeX). Se importan aquí y no en
// MessageList para que las pruebas puedan cargar ese componente en Node.
import "katex/dist/katex.min.css";
import { MessageInput } from "@/components/chat/MessageInput";
import { PersistFailureNotice } from "@/components/chat/PersistFailureNotice";
import { ChatAccessDenied, ChatGateLoading } from "@/components/chat/ChatGateScreen";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ModeSelector } from "@/components/chat/ModeSelector";
import * as advisorApi from "./_lib/advisorApi";
import type { PersistMessageInput, PersistMessageResult } from "./_lib/advisorApi";
import { describePersistFailures, withClientMessageId } from "./_lib/persistFailures";
import { usePersistFailures } from "./_lib/usePersistFailures";
import { appendAssistantMessage } from "./_lib/appendAssistantMessage";
import { useAccessGate } from "./_lib/useAccessGate";
import { useChatSession } from "./_lib/useChatSession";
import {
  useAdvisorEarlyStageEffects,
  useAdvisorFinalDocEffect,
  useAdvisorLateStageEffects,
  useAdvisorStageState,
} from "./_lib/useAdvisorStages";
import {
  createAdvisorTransitions,
  type IshikawaState,
} from "./_lib/advisorTransitions";
import { handleProgressTurn } from "./_lib/turns/progressTurn";
import { handlePlanningTurn } from "./_lib/turns/planningTurn";
import { handleImprovementTurn } from "./_lib/turns/improvementTurn";
import { handleObjectivesTurn } from "./_lib/turns/objectivesTurn";
import { handleParetoTurn } from "./_lib/turns/paretoTurn";
import { handleIshikawaTurn } from "./_lib/turns/ishikawaTurn";
import { handleBrainstormStartTurn, handleBrainstormTurn } from "./_lib/turns/brainstormTurn";
import { handleFodaCloseTurn, handleFodaTurn } from "./_lib/turns/fodaTurn";
import { handleProductivityStartTurn, handleProductivityWizardTurn } from "./_lib/turns/productivityTurn";
import type { AdvisorTurnDeps, LastProductivityReport, PlanContextStatus } from "./_lib/turns/types";
import { useChatHistory, useChatHistoryPersistence } from "./_lib/useChatHistory";
import { Message } from "@/lib/types";
import { BrainstormState } from "@/lib/plan/brainstormFlow";
import {
  NO_TURN_UI,
  parseIshikawaTurnUi,
  type IshikawaTurnUi,
} from "@/lib/plan/ishikawaTree";
import { evaluateIshikawaReadiness } from "@/lib/plan/ishikawaReadiness";
import {
  isGreetingOrSmallTalk,
  isHoursIntent,
  looksLikeAdvisorProgressStatusQuestion,
  wantsStage6ValidationNow,
} from "@/lib/plan/advisorClientIntent";
import {
  type Stage0ContextJson,
  formatContextSummary,
  getNextStage0StepFromContext,
} from "@/lib/plan/stage0Context";
import { handleStage0Turn } from "./_lib/turns/stage0Turn";
import { createStage0PromptTracker, openStage0 } from "./_lib/stage0Opening";
import { PLAN_CONTINUES_NOTICE, planChatEntry } from "./_lib/planChatClient";
import {
  type AdvisorRuntimeStage,
  type FinalDocState,
  type FodaState,
  type ImprovementState,
  type ObjectivesState,
  type ParetoState,
  type PlanningState,
  type ProductivityDraft,
  type ProgressState,
  canShowFinalDocUploadButton,
  isFinalDocReadyForUpload,
  isFodaComplete,
  isObjectivesReadyForValidation,
  isObjectivesStateLike,
  normalizeParetoStateClient,
} from "@/lib/plan/advisorStates";
import {
  buildStage6ProgressTruthMessage,
  getAdvisorStageLabel,
} from "@/lib/plan/advisorMessages";
import { createMessage, formatAdvisorReplyForChat } from "@/lib/chat/assistantFormat";
import { describeChatIdentity } from "@/lib/chat/studentIdentity";
import { chatIdStorageKey, messagesStorageKey } from "@/lib/chat/chatStorage";
import { readSignedAssistantReply, type SignedAssistantReply } from "@/lib/chat/signedAssistantReply";
import { historySpeaker, isAdvisorSideRole, toIshikawaRecentMessage } from "@/lib/chat/messageProvenance";


type ChatMode = "general" | "plan_mejora";

export default function ChatPage() {
  const router = useRouter();

  //------------------------------------------
  useEffect(() => {
    // En desktop abrimos sidebar por defecto; en móvil queda cerrado
    if (typeof window === "undefined") return;

    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => setSidebarOpen(mq.matches);

    apply();
    mq.addEventListener?.("change", apply);

    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Sesión de Supabase Auth del cliente (useChatSession: solo obtiene la sesión y el token)
  const { ready, sessionEmail, userId, accessToken, authenticated, accountName, getAuthHeaders } =
    useChatSession();

  // -----------------------------
  // Redirect si no está autenticado y gate final del chat (FUENTE DE VERDAD: /api/me)
  // -----------------------------
  const { gateChecked, gateMessage, accessDenied, canInteract, identity, whenIdentityKnown } = useAccessGate({
    ready,
    authenticated,
    router,
  });

  // Nombre que muestra el chat (studentIdentity.ts): el del perfil que trae /api/me; sin perfil, el
  // de la cuenta de Google. headerName va en la cabecera ("Univ. …"); greetingName, en el saludo.
  const chatIdentity = useMemo(
    () => describeChatIdentity({ ...identity, accountName, email: sessionEmail }),
    [identity, accountName, sessionEmail]
  );

  // La apertura de E0 espera a /api/me para saludar con el mismo nombre que la cabecera. No agrega
  // espera visible: el chat no se muestra hasta que /api/me responde (gateChecked).
  async function waitForGreetingName() {
    const me = await whenIdentityKnown();
    return describeChatIdentity({ ...me, accountName, email: sessionEmail }).greetingName;
  }

  // -----------------------------
  // Estado de UI / Chat
  // -----------------------------
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // -----------------------------
  // Theme (dark/light) — persistente
  // -----------------------------
  type ThemeMode = "dark" | "light";
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    // Lee tema guardado (si existe)
    try {
      const saved = localStorage.getItem("optia-theme");
      const t = saved === "light" || saved === "dark" ? saved : "dark";
      setTheme(t);
      document.documentElement.dataset.theme = t;
    } catch {}
  }, []);

  function toggleTheme() {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("optia-theme", next);
    } catch {}
    document.documentElement.dataset.theme = next;
  }


  // ✅ IMPORTANTE: mode debe existir ANTES de usarlo abajo
  const [mode, setMode] = useState<ChatMode>("general");

  // Refs para evitar closures con estado viejo (ej: Nuevo chat y envío inmediato)
  const chatIdRef = useRef<string | null>(null);
  const advisorChatBootstrapPromiseRef = useRef<Promise<string | null> | null>(null);
  const advisorChatBootstrapErrorRef = useRef<string | null>(null);
  const modeRef = useRef<ChatMode>("general");
  const messagesRef = useRef<Message[]>([]);
  // Mensajes que no se pudieron guardar en el historial (aviso y reintento).
  const persistFailures = usePersistFailures();
  // E0: chats que ya mostraron una pregunta de contexto, y mensajes enviados por el estudiante en
  // el asesor. Los comparten la apertura y el turno de E0 (_lib/stage0Opening.ts).
  const [stage0Prompts] = useState(createStage0PromptTracker);
  // Chat principal del Plan de Mejora (lo resuelve el servidor, src/lib/plan/planChat.ts). El asesor
  // siempre trabaja en él y la barra lateral solo ofrece ese chat del asesor.
  const [planChatId, setPlanChatId] = useState<string | null>(null);
  const studentSendsRef = useRef(0);

  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const composerMeasureRef = useRef<HTMLDivElement | null>(null);


  useLayoutEffect(() => {
    const measureEl = composerMeasureRef.current;
    const areaEl = chatAreaRef.current;
    if (!measureEl || !areaEl) return;

    const setVar = () => {
      const h = measureEl.getBoundingClientRect().height;
      areaEl.style.setProperty("--composer-h", `${h}px`);
    };

    setVar();

    const ro = new ResizeObserver(() => setVar());
    ro.observe(measureEl);

    return () => ro.disconnect();
  }, []);


  // -----------------------------
  // Cache ligero para evitar GETs repetidos en Ishikawa
  // -----------------------------
  type AdvisorContextPayload = {
    status?: "draft" | "confirmed";
    version?: number;
    exists?: boolean;
    chatId?: string | null;
    contextJson?: unknown;
    contextText?: string | null;
    message?: string;
    error?: string;
    code?: string;
  };

  const planContextCacheRef = useRef<{ at: number; data: PlanContextStatus } | null>(null);
  const lastProdReportCacheRef = useRef<{ at: number; data: LastProductivityReport } | null>(null);


  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const [showHoursInline, setShowHoursInline] = useState(false);

  // clientId estable para storage UI (NO es autoridad server-side)
  const clientId = useMemo(() => userId || sessionEmail || "pending", [userId, sessionEmail]);

  // ✅ Keys de storage por usuario + modo
  const storageKeyChat = chatIdStorageKey(clientId, mode);
  const storageKeyMsgs = messagesStorageKey(clientId, mode);

  // -----------------------------
  // Estado del Asesor E0-E10 (useAdvisorStageState). Ishikawa sigue en este archivo.
  // -----------------------------
  const {
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
  } = useAdvisorStageState();

  // Mismas reglas que ishikawa/validate y el mapa del asistente (ishikawaReadiness.ts): problema,
  // sin pregunta pendiente de causa raíz repetida (el "sí" del estudiante la respondería),
  // categorías completas y el mínimo de raíces cerradas. Así el paso a Pareto solo se ofrece
  // cuando validate lo va a aceptar.
  function isIshikawaReadyToClose(st: IshikawaState | null) {
    if (!st) return false;
    return evaluateIshikawaReadiness(st).ready;
  }

  // El servidor indica si el turno admite ofrecer el paso a Pareto (ui.offerStageClose: no
  // en el mismo turno que un cierre de rama); aquí se exige además que el estado cumpla
  // los mínimos. No se lee el texto del mensaje.
  function shouldOfferIshikawaStageClose(st: IshikawaState | null, ui: IshikawaTurnUi) {
    return ui.offerStageClose && isIshikawaReadyToClose(st);
  }


  const [ishikawaState, setIshikawaState] = useState<IshikawaState | null>(null);
  const saveIshikawaTimerRef = useRef<number | null>(null);

  const [ishikawaClosePending, setIshikawaClosePending] = useState(false);

  // -----------------------------
  // Transiciones y restauración del asesor (createAdvisorTransitions): se crean en cada render,
  // como cuando estaban declaradas en este componente.
  // -----------------------------
  const {
    refreshActiveAdvisorStage,
    syncActiveAdvisorStageFromBackend,
    restoreLatestAdvisorStageToNewChat,
    applyBackendAdvisorAdvance,
  } = createAdvisorTransitions({
    state: {
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
    },
    persistence: {
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
    },
    chat: {
      appendAssistant,
      persistMessageDB,
      setMessages,
      greetingName: chatIdentity.greetingName,
    },
  });

  // -----------------------------
  // 2a. Cargar desde sessionStorage y 2b. historial del backend (useChatHistory)
  // -----------------------------
  const { newGreeting } = useChatHistory({
    ready,
    authenticated,
    mode,
    modeRef,
    chatId,
    setChatId,
    setMessages,
    storageKeyChat,
    storageKeyMsgs,
    getAuthHeaders,
    router,
    greetingName: chatIdentity.greetingName,
  });

  // -----------------------------
  // 2d. (Asesor) Estado desde DB (plan_case_contexts)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;
    // Antes de cualquier espera: si el estudiante escribe mientras esto corre, la apertura de E0
    // no sale y su turno la responde (stage0Opening.ts).
    const studentSendsAtStart = studentSendsRef.current;
    const stage0OpeningDeps = {
      tracker: stage0Prompts,
      hasHistory: async (cid: string) => advisorApi.chatHasMessages(await getAuthHeaders(), cid),
      studentSendCount: () => studentSendsRef.current,
      isCurrent: (cid: string) => active && modeRef.current === "plan_mejora" && chatIdRef.current === cid,
      show: async (cid: string, text: string) => {
        const content = formatAdvisorReplyForChat(text);
        const message = createMessage("advisor", content);
        // El chat del plan no tiene historial: la apertura reemplaza lo que hubiera en pantalla.
        setMessages([message]);
        await persistMessageDB({ chatId: cid, role: "advisor", content, clientMessageId: message.id });
      },
    };

    // El chat del asesor que guardaba esta pestaña, leído antes de que nada lo cambie
    // (planChatClient.ts decide con él si lo que hay en pantalla es de otra conversación).
    let storedAdvisorChatId: string | null = null;
    try {
      storedAdvisorChatId = window.sessionStorage.getItem(advisorChatStorageKey());
    } catch {}

    (async () => {
      // Lectura fresca: el chat del plan lo resuelve el servidor y otra pestaña pudo crearlo.
      const ctx = await getPlanContextStatusCached({ force: true });
      if (!active) return;
      if (!ctx.ok) return;

      // Chat principal del plan: siempre el mismo (también con "Nuevo chat", otra pestaña, otra
      // sesión o tras recargar). Si el plan todavía no tiene chat, el servidor crea el primero.
      const currentChatId = chatIdRef.current;
      const planChatIdNow = ctx.chatId ?? (await ensureAdvisorChatId());
      if (!active) return;

      if (!planChatIdNow) {
        setMessages([
          createMessage(
            "advisor",
            advisorChatBootstrapErrorRef.current ??
              "⚠️ No pude preparar el chat del Asesor. Recarga la página e inténtalo nuevamente."
          ),
        ]);
        return;
      }

      setPlanChatId(planChatIdNow);
      const entry = planChatEntry({ storedAdvisorChatId, currentChatId, planChatId: planChatIdNow });
      if (entry.clearMessages) setMessages([]);
      if (entry.adopt) adoptAdvisorChatId(planChatIdNow);

      // ✅ CONFIRMED: el historial del chat del plan muestra dónde quedó; las etapas las restaura
      // useAdvisorEarlyStageEffects desde /api/plans/active-stage.
      if (ctx.status === "confirmed") {
        setStage0Draft({});

        // Sin historial en el chat del plan (el avance quedó guardado sin conversación), un
        // resumen del caso que no se guarda.
        const history = await advisorApi.chatHasMessages(await getAuthHeaders(), planChatIdNow);
        if (!active || chatIdRef.current !== planChatIdNow) return;
        if (history === false && messagesRef.current.length === 0) {
          const summary = formatContextSummary(ctx.contextJson);
          setAwaitingStage1Start(clientId, true);

          setMessages([
            createMessage(
              "assistant",
              "¡Hola! 👋 Ya tengo tu **Contexto del Caso** registrado:\n\n" +
                summary +
                "\n\n👉 **Importante:** la **Etapa 1 (Productividad)** se puede completar **más adelante**, cuando tengas datos del mes.\n" +
                "Por ahora, para avanzar con el diagnóstico podemos empezar con **Etapa 2 (FODA)**.\n\n" +
                "Si quieres continuar ahora, responde: **ok**, **vamos**, **listo**.\n" +
                "Si ya tienes datos, escribe: **productividad**.\n" +
                "O si quieres editar: **cambiar sector/producto/área**."
            ),
          ]);
        }
        return;
      }

      // ✅ DRAFT: E0 sigue en el chat del plan. La apertura sale solo si ese chat no tiene
      // historial guardado; si lo tiene, el historial (useChatHistory) ya muestra la última pregunta.
      setStage0Draft({
        sector: typeof ctx.contextJson?.sector === "string" ? ctx.contextJson.sector : undefined,
        products: Array.isArray(ctx.contextJson?.products) ? ctx.contextJson.products : undefined,
        process_focus: Array.isArray(ctx.contextJson?.process_focus) ? ctx.contextJson.process_focus : undefined,
      });

      const greetingName = await waitForGreetingName();
      if (!active) return;

      await openStage0(stage0OpeningDeps, {
        chatId: planChatIdNow,
        contextStatus: ctx.status,
        contextJson: ctx.contextJson,
        greetingName,
        knownEmpty: false,
        studentSendsAtStart,
      });
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, advisorRefreshNonce]); // ⚠️ Intencional: no depende de chatId para evitar loops

  // Chat del plan para la barra lateral, también desde el Asistente General. Solo lee: si el plan
  // no tiene chat todavía, no se crea aquí. Con acceso de solo lectura /api/plans/context responde
  // 403 y la barra lateral queda como antes.
  useEffect(() => {
    if (!ready || !authenticated || !gateChecked) return;
    let active = true;
    void getPlanContextStatusCached().then((ctx) => {
      if (active && ctx.ok && ctx.chatId) setPlanChatId(ctx.chatId);
    });
    return () => {
      active = false;
    };
  }, [ready, authenticated, gateChecked]);

  // -----------------------------

  // Etapa activa y carga de E2/E3 (useAdvisorEarlyStageEffects)
  useAdvisorEarlyStageEffects({
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
  });

  // 2.x Cargar estado Ishikawa (Etapa 4)
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) {
      setIshikawaState(null);
      setIshikawaClosePending(false);
      return;
    }

    let active = true;

    (async () => {
      const res = await getIshikawaState({ chatId });
      if (!active) return;
      if (!res.ok) return;

      if (res.payload?.exists && res.payload?.state) {
        const st = res.payload.state as IshikawaState;
        setIshikawaState(st);
        setIshikawaClosePending(isIshikawaReadyToClose(st));
      } else {
        setIshikawaState(null);
        setIshikawaClosePending(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, chatId]);



  // Carga de E6-E9, restauración del wizard de E1 y autoguardado de E1/E2 (useAdvisorLateStageEffects)
  useAdvisorLateStageEffects({
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
  });

  // 2.x Guardar estado Ishikawa
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!ishikawaState) return;

    if (saveIshikawaTimerRef.current) {
      window.clearTimeout(saveIshikawaTimerRef.current);
    }

    saveIshikawaTimerRef.current = window.setTimeout(() => {
      const effectiveChatId = chatIdRef.current ?? null;
      if (!effectiveChatId) return; // evita warning y guardado sin chatId
      saveIshikawaState(ishikawaState, effectiveChatId).catch(() => {});
    }, 450);

    return () => {
      if (saveIshikawaTimerRef.current) window.clearTimeout(saveIshikawaTimerRef.current);
    };
  }, [ready, authenticated, mode, ishikawaState]);

  // -----------------------------
  // 2c. Guardar en sessionStorage (useChatHistoryPersistence)
  // -----------------------------
  useChatHistoryPersistence({ authenticated, chatId, messages, storageKeyChat, storageKeyMsgs });


  // -----------------------------

  useAdvisorFinalDocEffect({
    ready,
    authenticated,
    mode,
    chatId,
    getFinalDocState,
    setFinalDocState,
  });

  // -----------------------------
  // Loading state
  // -----------------------------
  if (!ready) {
    return <ChatGateLoading message="Cargando autenticación..." />;
  }

  if (!authenticated) {
    return null;
  }

  if (!gateChecked) {
    return <ChatGateLoading message="Verificando acceso..." />;
  }

  if (accessDenied) {
    return <ChatAccessDenied message={gateMessage} onBack={() => router.replace("/")} />;
  }

  function pushAssistantOnce(text: string) {
    setMessages((prev) => {
      const last = [...prev].reverse().find((m) => isAdvisorSideRole(m.role))?.content ?? "";
      if (last.trim() === text.trim()) return prev;
      return [...prev, createMessage("advisor", text)];
    });
  }

  function stage1StartKey(cid: string) {
    return `optia-plan-stage1-start-${cid}`;
  }

  function setAwaitingStage1Start(cid: string, value: boolean) {
    try {
      if (value) window.sessionStorage.setItem(stage1StartKey(cid), "1");
      else window.sessionStorage.removeItem(stage1StartKey(cid));
    } catch {}
  }

  function isAwaitingStage1Start(cid: string) {
    try {
      return window.sessionStorage.getItem(stage1StartKey(cid)) === "1";
    } catch {
      return false;
    }
  }

  function syncResumeFlagsForAdvisorStage(stage: AdvisorRuntimeStage) {
    if (stage == null) return;

    // Si ya retomamos cualquier etapa real del asesor,
    // no debemos volver a disparar el arranque pendiente de Productividad.
    if (stage >= 1) {
      setAwaitingStage1Start(clientId, false);
    }
  }

  // -----------------------------
  // API helpers (fetch backend)
  // -----------------------------

  async function getActiveAdvisorStage() {
    const authHeaders = await getAuthHeaders();

    return advisorApi.getActiveAdvisorStage(authHeaders);
  }

  async function handleAdvisorProgressStatusQuestion() {
    const synced = await syncActiveAdvisorStageFromBackend();

    if (!synced.ok) {
      await appendAssistant(
        "No puedo confirmar el estado actualizado en este momento. Evitare asumir que ya cambio de etapa; revisemos el ultimo paso pendiente."
      );
      return true;
    }

    if (synced.stage === 6) {
      const syncedObjectivesState = isObjectivesStateLike(synced.stateJson)
        ? synced.stateJson
        : objectivesState;
      await appendAssistant(buildStage6ProgressTruthMessage(syncedObjectivesState));
      return true;
    }

    const label = getAdvisorStageLabel(synced.stage);
    const message = synced.changed
      ? `El avance registrado ya esta en **${label}**. Actualice el estado del asesor para que el progreso se alinee con tu etapa actual.`
      : `El sistema registra tu avance en **${label}**. Esa es la etapa que debo usar como referencia.`;

    await appendAssistant(message);
    return true;
  }

  // Todo guardado de mensajes pasa por aquí (appendAssistant, transiciones y el texto del
  // estudiante). Si falla, el mensaje queda pendiente y se avisa; los siguientes del mismo chat
  // esperan en cola detrás para no desordenar el historial. Ver _lib/persistFailures.ts.
  async function persistMessageDB(input: PersistMessageInput): Promise<PersistMessageResult> {
    const request = withClientMessageId(input, () => crypto.randomUUID());
    if (persistFailures.blocks(request.chatId)) {
      persistFailures.queue(request);
      return { ok: false, status: 0, code: "QUEUED", message: null, data: null };
    }

    const result = await sendMessageToHistory(request);
    if (!result.ok) persistFailures.report(request, result);
    return result;
  }

  async function sendMessageToHistory(input: PersistMessageInput): Promise<PersistMessageResult> {
    try {
      const authHeaders = await getAuthHeaders();
      return await advisorApi.persistMessageDB(authHeaders, input);
    } catch {
      return { ok: false, status: 0, code: "NETWORK", message: null, data: null };
    }
  }

  // reply: solo cuando content es la respuesta de una ruta assistant (su signedReply).
  async function appendAssistant(content: unknown, reply?: SignedAssistantReply | null) {
    await appendAssistantMessage({ modeRef, chatIdRef, setMessages, persistMessageDB }, content, reply);
  }

  async function interpretStage0WithLLM(step: 1 | 2 | 3, userText: string, ctxJson: any) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.interpretStage0WithLLM(authHeaders, step, userText, ctxJson);
  }

  async function getPlanContextStatus() {
    const authHeaders = await getAuthHeaders();

    return advisorApi.getPlanContextStatus(authHeaders);
  }

  async function getProductivityState(currentChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    return advisorApi.getProductivityState(authHeaders, currentChatId);
  }

  async function saveProductivityState(state: { prodStep: number; prodDraft: any }, currentChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    return advisorApi.saveProductivityState(authHeaders, state, currentChatId);
  }

  async function clearProductivityState() {
    const authHeaders = await getAuthHeaders();
    return advisorApi.clearProductivityState(authHeaders);
  }

  async function getLastProductivityReport() {
    try {
      const authHeaders = await getAuthHeaders();
      return await advisorApi.getLastProductivityReport(authHeaders);
    } catch (err) {
      return { ok: false, payload: null };
    }
  }

  async function getPlanContextStatusCached(opts?: { force?: boolean }): Promise<PlanContextStatus> {
    const force = Boolean(opts?.force);
    const now = Date.now();

    const cache = planContextCacheRef.current;

    if (!force && cache?.data?.status === "confirmed") return cache.data;
    if (!force && cache && now - cache.at < 30_000) return cache.data;

    const fresh = await getPlanContextStatus();
    planContextCacheRef.current = { at: now, data: fresh };
    return fresh;
  }

  async function getLastProductivityReportCached(opts?: { force?: boolean }): Promise<LastProductivityReport> {
    const force = Boolean(opts?.force);
    const now = Date.now();

    const cache = lastProdReportCacheRef.current;
    const cachedStatus = cache?.data?.payload?.status ?? null;

    if (!force && cache?.data?.ok && cachedStatus === "validated") return cache.data;
    if (!force && cache && now - cache.at < 30_000) return cache.data;

    const fresh = await getLastProductivityReport();
    lastProdReportCacheRef.current = { at: now, data: fresh };
    return fresh;
  }

  function advisorChatStorageKey() {
    return `optia-chat-id-${clientId}-plan_mejora`;
  }

  function adoptAdvisorChatId(nextChatId: string) {
    chatIdRef.current = nextChatId;
    setChatId(nextChatId);
    try {
      window.sessionStorage.setItem(advisorChatStorageKey(), nextChatId);
    } catch {}
  }

  function getAdvisorBootstrapErrorMessage(payload: AdvisorContextPayload | null) {
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (message) return message;

    const error = typeof payload?.error === "string" ? payload.error.trim() : "";
    if (error) return error;

    return null;
  }

  function cacheAdvisorContextPayload(payload: AdvisorContextPayload | null, fallbackChatId: string) {
    const contextJson =
      payload?.contextJson && typeof payload.contextJson === "object" && !Array.isArray(payload.contextJson)
        ? (payload.contextJson as Record<string, unknown>)
        : {};

    planContextCacheRef.current = {
      at: Date.now(),
      data: {
        ok: true,
        status: payload?.status === "confirmed" ? "confirmed" : "draft",
        exists: true,
        chatId: typeof payload?.chatId === "string" ? payload.chatId : fallbackChatId,
        contextJson,
        contextText: typeof payload?.contextText === "string" ? payload.contextText : null,
        message: null,
      },
    };
  }

  // Pide el chat del plan sin guardar contexto: el servidor crea uno solo si el plan no tiene.
  async function createAdvisorChatOnly(): Promise<{ ok: boolean; chatId: string | null; payload: AdvisorContextPayload | null }> {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/context", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        forceNew: true,
        contextJson: {},
        contextText: null, // ✅ CLAVE: null => activa el modo isChatOnly en el backend
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = (json?.data ?? json ?? null) as AdvisorContextPayload | null;
    const chatId = typeof payload?.chatId === "string" ? payload.chatId : null;

    if (ok && chatId) {
      adoptAdvisorChatId(chatId);
      cacheAdvisorContextPayload(payload, chatId);
    }

    return { ok, chatId, payload };
  }

  // Chat principal del plan (lo resuelve el servidor, src/lib/plan/planChat.ts) y lo deja activo.
  // Si el plan todavía no tiene chat, /api/plans/context crea el primero; si tiene, devuelve
  // siempre el mismo. Las llamadas simultáneas comparten la misma petición.
  async function ensureAdvisorChatId(): Promise<string | null> {
    if (advisorChatBootstrapPromiseRef.current) return advisorChatBootstrapPromiseRef.current;

    const bootstrapPromise = (async () => {
      advisorChatBootstrapErrorRef.current = null;

      const ctx = await getPlanContextStatusCached({ force: true });

      if (!ctx.ok) {
        advisorChatBootstrapErrorRef.current = ctx.message ?? null;
        return null;
      }

      if (ctx.chatId) {
        setPlanChatId(ctx.chatId);
        if (chatIdRef.current !== ctx.chatId) adoptAdvisorChatId(ctx.chatId);
        return ctx.chatId;
      }

      const created = await createAdvisorChatOnly();

      if (created.ok && created.chatId) {
        setPlanChatId(created.chatId);
        return created.chatId;
      }

      advisorChatBootstrapErrorRef.current = getAdvisorBootstrapErrorMessage(created.payload);
      return null;
    })();

    advisorChatBootstrapPromiseRef.current = bootstrapPromise;

    try {
      return await bootstrapPromise;
    } finally {
      if (advisorChatBootstrapPromiseRef.current === bootstrapPromise) {
        advisorChatBootstrapPromiseRef.current = null;
      }
    }
  }

  async function savePlanContextDraft(
    nextDraft: {
      sector?: string;
      products?: string[];
      process_focus?: string[];
    },
    baseContextJson?: {
      sector?: string;
      products?: string[];
      process_focus?: string[];
      stage?: string;
    }
  ) {

    const authHeaders = await getAuthHeaders();

    // Solo los campos que cambian: el servidor los fusiona con lo guardado. Antes se reenviaban los
    // tres desde el estado de la pestaña, y una pestaña vieja pisaba lo que otra había registrado.
    const contextJson: Stage0ContextJson = { stage: baseContextJson?.stage ?? "ETAPA_0" };
    if (nextDraft.sector !== undefined) contextJson.sector = nextDraft.sector;
    if (nextDraft.products !== undefined) contextJson.products = nextDraft.products;
    if (nextDraft.process_focus !== undefined) contextJson.process_focus = nextDraft.process_focus;

    const merged = { ...baseContextJson, ...contextJson };
    const contextText = [
      `Sector/Rubro: ${merged.sector || "(pendiente)"}`,
      `Producto/servicio: ${(merged.products || []).join(", ") || "(pendiente)"}`,
      `Proceso/área: ${(merged.process_focus || []).join(", ") || "(pendiente)"}`,
    ].join("\n");

    // Solo el contexto: la conversación de E0 se guarda por /api/messages.
    const reqBody: {
      contextJson: Stage0ContextJson;
      contextText: string;
      chatId?: string;
    } = {
      contextJson,
      contextText: contextText ?? "",
    };
    if (chatIdRef.current) reqBody.chatId = chatIdRef.current;

    const res = await fetch("/api/plans/context", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(reqBody),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;

    // ✅ Renombramos el payload de response
    const resPayload = json?.data ?? json;

    // ✅ Si el backend creó un chatId (plan_mejora), adoptarlo en el frontend
    const returnedChatId = (resPayload?.chatId ?? null) as string | null;

    if (returnedChatId && returnedChatId !== chatIdRef.current) {
      chatIdRef.current = returnedChatId;
      setChatId(returnedChatId);
      try {
        window.sessionStorage.setItem(storageKeyChat, returnedChatId);
      } catch {}
    }

    return { ok, payload: resPayload };
  }

  // Confirma exactamente los datos que el estudiante revisó y aprobó (stage0Turn.ts).
  async function confirmPlanContext(reviewed: Stage0ContextJson) {
    const authHeaders = await getAuthHeaders();
    return advisorApi.confirmPlanContext(authHeaders, reviewed);
  }

  // Turno de E0 (contexto en borrador): _lib/turns/stage0Turn.ts.
  async function handleStage0DraftFlow(input: {
    text: string;
    ctx: PlanContextStatus;
  }): Promise<boolean> {
    return handleStage0Turn(
      {
        chatId: () => chatIdRef.current,
        greetingName: chatIdentity.greetingName,
        editingField,
        setEditingField,
        setStage0Draft,
        setAwaitingStage1Start: (value) => setAwaitingStage1Start(clientId, value),
        tracker: stage0Prompts,
        appendAssistant: (text) => appendAssistant(text),
        interpret: (step, text, ctxJson) => interpretStage0WithLLM(step, text, ctxJson),
        saveDraft: (extracted, base) => savePlanContextDraft(extracted, base),
        confirm: (reviewed) => confirmPlanContext(reviewed),
        refreshContext: () => {
          planContextCacheRef.current = null;
          return getPlanContextStatusCached({ force: true });
        },
        cacheContext: (data) => {
          planContextCacheRef.current = { at: Date.now(), data };
        },
      },
      input
    );
  }

  async function saveProductivity(payload: any, chatId?: string | null) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.saveProductivity(authHeaders, payload, chatId);
  }

  async function validateProductivity(period: string) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.validateProductivity(authHeaders, period);
  }

  function buildRecentHistoryForAssistant(maxTurns = 10) {
    const msgs = messagesRef.current
      .filter((m) => m.role === "user" || isAdvisorSideRole(m.role))
      .slice(-maxTurns);

    // Los textos locales del asesor van como PLATFORM_GUIDE, no como respuestas del asistente.
    const base = msgs
      .map((m) => `${historySpeaker(m.role)}: ${m.content}`)
      .join("\n");

    // ---------------------------------------------
    // Etapa 10: si hay feedback previo (v1), lo incluimos como contexto
    // para que el agente responda preguntas con coherencia.
    // NOTA: Solo aplica mientras NO esté finalizado.
    // ---------------------------------------------
    const shouldInjectStage10 =
      modeRef.current === "plan_mejora" &&
      !!finalDocState &&
      finalDocState.step !== "finalized" &&
      typeof finalDocState.lastFeedback === "string" &&
      finalDocState.lastFeedback.trim().length > 0;

    if (!shouldInjectStage10) return base;

    // Limitar tamaño para no inflar contexto
    const feedback = finalDocState!.lastFeedback!.trim().slice(0, 1600);

    // Lo arma el navegador: va como contexto, nunca como instrucción de sistema.
    const injected =
      "CONTEXT: Etapa 10 (Documento final)\n" +
      `- Estado: ${finalDocState!.step}\n` +
      `- Versión actual: ${finalDocState!.versionNumber}\n` +
      "- Feedback anterior entregado al estudiante (resumen):\n" +
      feedback +
      "\n\n" +
      "CONTEXT: Responde conversacionalmente usando este feedback como referencia. No inventes información.\n\n";

    return injected + base;
  }

  function buildRecentMessagesForIshikawa(maxMessages = 6) {
    return messagesRef.current
      .filter((m) => m.role === "user" || isAdvisorSideRole(m.role))
      .slice(-maxMessages)
      .map((m) => ({ role: m.role, content: String(m.content ?? "").trim() }))
      .filter((m) => m.content.length > 0)
      .map(toIshikawaRecentMessage);
  }

  async function callProductivityAssistant(input: {
    studentMessage: string;
    prodStep: number;
    prodDraft: ProductivityDraft;
    caseContext: any;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callProductivityAssistant(authHeaders, input, chatIdRef.current ?? null, buildRecentHistoryForAssistant(10));
  }

  async function getFodaState(chatIdArg?: string | null) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId =
      chatIdArg === undefined ? (chatIdRef.current ?? null) : chatIdArg;

    return advisorApi.getFodaState(authHeaders, effectiveChatId);
  }


  async function saveFodaState(state: FodaState, chatIdArg?: string | null) {
    if (!accessToken) {
      return { ok: false as const, skipped: true as const, reason: "NO_ACCESS_TOKEN" as const };
    }

    const effectiveChatId = chatIdArg ?? chatIdRef.current ?? null;
    if (!effectiveChatId) {
      return { ok: false as const, skipped: true as const, reason: "NO_CHAT_ID" as const };
    }

    const authHeaders = await getAuthHeaders();

    return advisorApi.saveFodaState(authHeaders, state, effectiveChatId);
  }

  function getFodaSaveErrorMessage(result: {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    status?: number;
    json?: any;
  }) {
    if (result?.skipped && result?.reason === "NO_ACCESS_TOKEN") {
      return "⚠️ No pude guardar tu avance del FODA porque no encontré una sesión válida. Recarga la página e inténtalo nuevamente.";
    }

    if (result?.skipped && result?.reason === "NO_CHAT_ID") {
      return "⚠️ No pude guardar tu avance del FODA porque el chat aún no estaba inicializado. Vuelve a enviar tu último mensaje.";
    }

    const backendMessage =
      typeof result?.json?.message === "string" && result.json.message.trim().length > 0
        ? result.json.message.trim()
        : null;

    if (backendMessage) {
      return `⚠️ No pude guardar tu avance del FODA. ${backendMessage}`;
    }

    if (typeof result?.status === "number" && result.status >= 400) {
      return `⚠️ No pude guardar tu avance del FODA (HTTP ${result.status}).`;
    }

    return "⚠️ No pude guardar tu avance del FODA. No continúes todavía; primero recarga la página y vuelve a intentarlo.";
  }

  async function callFodaAssistant(input: {
    studentMessage: string;
    fodaState: FodaState;
    caseContext: any;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callFodaAssistant(authHeaders, input, chatIdRef.current ?? null, buildRecentHistoryForAssistant(10));
  }

  async function getBrainstormState(chatIdArg?: string | null) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId =
      chatIdArg === undefined ? (chatIdRef.current ?? null) : chatIdArg;

    return advisorApi.getBrainstormState(authHeaders, effectiveChatId);
  }

  async function saveBrainstormState(state: BrainstormState, chatId?: string | null) {
    if (!accessToken) {
      console.warn("[BRAINSTORM] Intento de guardado sin accessToken. Se omite.");
      return { ok: false };
    }

    const effectiveChatId = chatId ?? chatIdRef.current ?? null;

    // ✅ CLAVE: si no hay chatId, NO guardes (evitas el error)
    if (!effectiveChatId) {
      console.warn("[BRAINSTORM] No hay chatId para guardar state. Se omite.");
      return { ok: false };
    }

    const authHeaders = await getAuthHeaders();
    return advisorApi.saveBrainstormState(authHeaders, state, effectiveChatId);
  }

    async function validateFoda(chatIdArg?: string | null) {
      const authHeaders = await getAuthHeaders();
      const effectiveChatId = chatIdArg ?? chatIdRef.current ?? null;

      return advisorApi.validateFoda(authHeaders, effectiveChatId);
    }

  async function callBrainstormAssistant(input: {
    studentMessage: string;
    brainstormState: BrainstormState;
    caseContext: any;
    stage1Summary: any;
    fodaSummary: any;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callBrainstormAssistant(authHeaders, input, chatIdRef.current ?? null, buildRecentHistoryForAssistant(10));
  }

  async function validateBrainstorm() {
    const authHeaders = await getAuthHeaders();
    return advisorApi.validateBrainstorm(authHeaders, chatIdRef.current);
  }

  async function getIshikawaState(args?: { chatId?: string | null }) {
    const authHeaders = await getAuthHeaders();
    const effectiveChatId = args?.chatId ?? chatIdRef.current ?? null;

    if (!effectiveChatId) {
      return {
        ok: true,
        payload: { exists: false, state: null, row: null },
      };
    }

    return advisorApi.getIshikawaState(authHeaders, effectiveChatId);
  }

  async function saveIshikawaState(state: IshikawaState, chatId?: string | null) {
    try {
      if (!accessToken) {
        console.warn("[ISHIKAWA] Intento de guardado sin accessToken. Se omite.");
        return { ok: false };
      }

      const effectiveChatId = chatId ?? chatIdRef.current ?? null;
      if (!effectiveChatId) {
        console.warn("[ISHIKAWA] No hay chatId para guardar state. Se omite.");
        return { ok: false };
      }

      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/plans/ishikawa/state", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ state, chatId: effectiveChatId }),
      });

      const contentType = res.headers.get("content-type") ?? "";
      let json: any = null;
      let text: string | null = null;

      if (contentType.includes("application/json")) {
        json = await res.json().catch(() => null);
      } else {
        text = await res.text().catch(() => null);
      }

      const ok = res.ok && json?.ok !== false;

      // ⚠️ IMPORTANTE: NO usar console.error aquí (provoca overlay rojo en Next)
      if (!ok) {
        console.warn("[ISHIKAWA] save state failed", {
          status: res.status,
          contentType,
          json,
          text,
        });
      }

      return { ok };
    } catch (e: any) {
      // ⚠️ IMPORTANTE: NO usar console.error aquí (provoca overlay rojo)
      console.warn("[ISHIKAWA] save state exception", { message: e?.message ?? String(e) });
      return { ok: false };
    }
  }


  async function validateIshikawa() {
    const authHeaders = await getAuthHeaders();
    return advisorApi.validateIshikawa(authHeaders, chatId);
  }

  async function saveParetoState(state: ParetoState, chatId?: string | null) {
  if (!accessToken) {
    console.warn("[PARETO] Guardado sin accessToken. Se omite.");
    return { ok: false };
  }

  const effectiveChatId = chatId ?? chatIdRef.current ?? null;
  if (!effectiveChatId) {
    console.warn("[PARETO] No hay chatId para guardar state. Se omite.");
    return { ok: false };
  }

  const normalizedState = normalizeParetoStateClient(state);
  if (!normalizedState) {
    console.warn("[PARETO] State inválido antes de guardar.");
    return { ok: false };
  }

  const authHeaders = await getAuthHeaders();
  return advisorApi.saveParetoState(authHeaders, normalizedState, effectiveChatId);
  }

  async function callParetoAssistant(input: {
    studentMessage: string;
    paretoState: ParetoState;
    caseContext: Record<string, unknown> | null;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callParetoAssistant(authHeaders, input, chatIdRef.current ?? null, buildRecentHistoryForAssistant(10));
  }

    async function validatePareto(effectiveChatId?: string | null) {
      const authHeaders = await getAuthHeaders();
      const cid = effectiveChatId ?? chatIdRef.current ?? null;

      return advisorApi.validatePareto(authHeaders, cid);
    }


    async function getGenericStageState(
      stage: number,
      args?: { chatId?: string | null; latest?: boolean }
    ) {
      const authHeaders = await getAuthHeaders();

      return advisorApi.getGenericStageState(authHeaders, stage, args);
    }


    async function saveGenericStageState(
      stage: number,
      stateJson: Record<string, unknown>,
      effectiveChatId?: string | null
    ) {
      if (!accessToken) {
        console.warn(`[STAGE ${stage}] Guardado sin accessToken. Se omite.`);
        return { ok: false as const, payload: null };
      }

      const authHeaders = await getAuthHeaders();
      const cid = effectiveChatId ?? chatIdRef.current ?? null;

      if (!cid) {
        console.warn(`[STAGE ${stage}] No hay chatId para guardar state. Se omite.`);
        return { ok: false as const, payload: null };
      }

      return advisorApi.saveGenericStageState(authHeaders, stage, stateJson, cid);
    }


  async function clearStageState(stage: number, effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    if (!cid) return { ok: false as const, payload: null };

    return advisorApi.clearStageState(authHeaders, stage, cid);
  }



  async function getObjectivesState(effectiveChatId?: string | null) {
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };
    return getGenericStageState(6, { chatId: cid });
  }

  async function saveObjectivesState(state: ObjectivesState, effectiveChatId?: string | null) {
    return saveGenericStageState(6, state as unknown as Record<string, unknown>, effectiveChatId);
  }

  async function callObjectivesAssistant(input: {
    studentMessage: string;
    objectivesState: ObjectivesState;
    caseContext: Record<string, unknown> | null;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();
    const cid = input.effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.callObjectivesAssistant(authHeaders, input, cid, buildRecentHistoryForAssistant(10));
  }

  async function validateObjectives(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.validateObjectives(authHeaders, cid);
  }

  async function getImprovementState(effectiveChatId?: string | null) {
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };
    return getGenericStageState(7, { chatId: cid });
  }

  async function saveImprovementState(state: ImprovementState, effectiveChatId?: string | null) {
    return saveGenericStageState(7, state as unknown as Record<string, unknown>, effectiveChatId);
  }

  async function callImprovementAssistant(input: {
    studentMessage: string;
    improvementState: ImprovementState;
    caseContext: Record<string, unknown> | null;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();
    const cid = input.effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.callImprovementAssistant(authHeaders, input, cid, buildRecentHistoryForAssistant(10));
  }

  async function validateImprovement(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.validateImprovement(authHeaders, cid);
  }

  async function getPlanningState(effectiveChatId?: string | null) {
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };
    return getGenericStageState(8, { chatId: cid });
  }

  async function savePlanningState(state: PlanningState, effectiveChatId?: string | null) {
    return saveGenericStageState(8, state as unknown as Record<string, unknown>, effectiveChatId);
  }

  async function callPlanningAssistant(args: {
    studentMessage: string;
    planningState: PlanningState;
    caseContext: any;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callPlanningAssistant(authHeaders, args, args.effectiveChatId ?? chatIdRef.current, buildRecentHistoryForAssistant(10));
  }

  async function validatePlanning(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.validatePlanning(authHeaders, cid);
  }

  async function saveProgressState(state: ProgressState, effectiveChatId?: string | null) {
    return saveGenericStageState(9, state as unknown as Record<string, unknown>, effectiveChatId);
  }

  async function callProgressAssistant(args: {
    studentMessage: string;
    progressState: ProgressState;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callProgressAssistant(authHeaders, args, args.effectiveChatId ?? chatIdRef.current, buildRecentHistoryForAssistant(10));
  }

  async function validateProgress(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.validateProgress(authHeaders, cid);
  }

  async function getProgressState(effectiveChatId?: string | null) {
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };
    return getGenericStageState(9, { chatId: cid });
  }

  async function getFinalDocState(effectiveChatId?: string | null) {
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };
    return getGenericStageState(10, { chatId: cid });
  }

  // ================================
  // ETAPA 10: helpers API
  // ================================
  async function saveFinalDocState(state: FinalDocState, effectiveChatId?: string | null) {
    return saveGenericStageState(10, state as unknown as Record<string, unknown>, effectiveChatId);
  }

  // versionNumber no se envía: lo decide el servidor a partir de los artefactos ya
  // guardados y vuelve dentro de updates.nextState.
  async function callFinalDocAssistant(args: {
    effectiveChatId?: string | null;
    fileName: string;
    storagePath: string;
    extractedText: string;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callFinalDocAssistant(authHeaders, args, args.effectiveChatId ?? chatIdRef.current, buildRecentHistoryForAssistant(12));
  }

  async function validateFinalDoc(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    return advisorApi.validateFinalDoc(authHeaders, cid);
  }


  async function callIshikawaAssistant(args: {
    studentMessage: string;
    chatId: string; // el servidor verifica que el chat sea del usuario y lee de ahí sus campos
    ishikawaState: IshikawaState;
    caseContext: any;
    stage1Summary: any;
    brainstormState: any;
    recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  }){
    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/plans/ishikawa/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(args),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;

    if (!ok) {
      console.error("[ISHIKAWA] assistant failed", { status: res.status, json });
      return { ok: false as const, assistantMessage: "⚠️ No pude procesar tu mensaje en Ishikawa.", nextState: args.ishikawaState, ui: NO_TURN_UI, signedReply: null };
    }

    const data = json?.data ?? json?.payload ?? json ?? null;

    const assistantMessage =
      data?.assistantMessage ?? null;

    const nextState =
      data?.updates?.nextState ?? null;


    if (!assistantMessage || !nextState) {
      return {
        ok: true as const,
        assistantMessage: "⚠️ No pude interpretar bien este turno de Ishikawa. Vuelve a escribir tu idea y seguimos desde la misma rama.",
        nextState: args.ishikawaState,
        ui: NO_TURN_UI,
        signedReply: null,
      };
    }

    return {
      ok: true as const,
      assistantMessage,
      nextState: nextState as IshikawaState,
      ui: parseIshikawaTurnUi(data?.ui),
      signedReply: readSignedAssistantReply(true, data, args.chatId),
    };
  }

  async function handleStage6NextStepQuestion(args: {
    text: string;
    objectivesState: ObjectivesState;
    effectiveChatId: string;
    advisorChatId: string;
  }) {
    const { text, objectivesState: currentObjectivesState, effectiveChatId, advisorChatId } = args;

    if (!isObjectivesReadyForValidation(currentObjectivesState)) {
      await appendAssistant(buildStage6ProgressTruthMessage(currentObjectivesState));
      return true;
    }

    if (!wantsStage6ValidationNow(text)) {
      await appendAssistant(
        "Tus objetivos ya se ven suficientemente estructurados para validarlos. " +
          "Si quieres pasar a **Etapa 7**, dime que validemos o que pasemos; primero ejecutare la validacion y solo despues actualizare el progreso."
      );
      return true;
    }

    const validation = await validateObjectives(effectiveChatId);

    if (!validation.ok) {
      const msg = validation.payload?.message ?? "No se pudo cerrar Etapa 6 (Objetivos).";
      await appendAssistant(`⚠️ ${msg}`);
      return true;
    }

    if (!validation.payload?.valid) {
      const msg =
        validation.payload?.message ??
        "La Etapa 6 aun no quedo validada. Revisa los ajustes pendientes antes de pasar a la Etapa 7.";

      await appendAssistant(
        "Todavia no puedo pasar a **Etapa 7**.\n\n" +
          `⚠️ ${msg}\n\n` +
          "Sigamos corrigiendo eso primero."
      );
      return true;
    }

    const moved = await applyBackendAdvisorAdvance({
      fromStage: 6,
      payload: validation.payload,
      effectiveChatId: advisorChatId,
    });

    if (!moved) {
      await appendAssistant(
        "La Etapa 6 quedo validada, pero no pude preparar automaticamente la Etapa 7. Recarga el chat y retomamos."
      );
    }

    return true;
  }

  // -----------------------------
  // Enviar mensaje
  // -----------------------------

  // -----------------------------
  // Dependencias de los turnos del asesor (src/app/chat/_lib/turns): referencias de este render.
  // -----------------------------
  const advisorTurnDeps: AdvisorTurnDeps = {
    state: {
      brainstormClosePending,
      brainstormState,
      chatIdRef,
      clientId,
      fodaState,
      ishikawaClosePending,
      messagesRef,
      prodDraft,
      prodStep,
      setActiveAdvisorStage,
      setBrainstormClosePending,
      setBrainstormState,
      setFodaState,
      setImprovementState,
      setIshikawaClosePending,
      setIshikawaState,
      setObjectivesState,
      setParetoState,
      setPlanningState,
      setProdDraft,
      setProdStep,
      setProgressState,
    },
    api: {
      callBrainstormAssistant,
      callFodaAssistant,
      callImprovementAssistant,
      callIshikawaAssistant,
      callObjectivesAssistant,
      callParetoAssistant,
      callPlanningAssistant,
      callProductivityAssistant,
      callProgressAssistant,
      clearProductivityState,
      clearStageState,
      getBrainstormState,
      getFodaSaveErrorMessage,
      getIshikawaState,
      saveBrainstormState,
      saveFodaState,
      saveImprovementState,
      saveIshikawaState,
      saveObjectivesState,
      saveParetoState,
      savePlanningState,
      saveProductivity,
      saveProgressState,
      validateBrainstorm,
      validateFoda,
      validateImprovement,
      validateIshikawa,
      validateObjectives,
      validatePareto,
      validatePlanning,
      validateProductivity,
      validateProgress,
    },
    chat: {
      appendAssistant,
      buildRecentMessagesForIshikawa,
    },
    flow: {
      applyBackendAdvisorAdvance,
      handleStage6NextStepQuestion,
      isIshikawaReadyToClose,
      restoreLatestAdvisorStageToNewChat,
      setAwaitingStage1Start,
      shouldOfferIshikawaStageClose,
    },
  };

  async function handleSend(text: string) {
    if (!text.trim()) return;
    if (!canInteract) return;

    // ================================
    // ETAPA 10 (Documento final): conversación fluida permitida hasta finalizar.
    // Solo bloqueamos cuando ya se cerró (finalized).
    // ================================
    if (modeRef.current === "plan_mejora" && finalDocState?.step === "finalized") {
      await appendAssistant(
        "✅ El **modo Asesor** ya está **cerrado** (Etapa 10 finalizada).\n\n" +
          "Si necesitas ayuda adicional, cambia al **modo Asistente general**."
      );
      return;
    }

      // El estudiante habló: si la apertura de E0 todavía no salió, ya no sale (su turno responde).
      if (modeRef.current === "plan_mejora") studentSendsRef.current += 1;

      // 1) Pintar SIEMPRE mensaje del usuario
      const userMessage = createMessage("user", text);
      setMessages((prev) => [...prev, userMessage]);

      // 2) Intercept horas SOLO en modo general (antes de llamar /api/chat)
      if (modeRef.current === "general" && isHoursIntent(text)) {
        setShowHoursInline(true);
        setMessages((prev) => [
          ...prev,
          createMessage("advisor", "Listo ✅ Aquí tienes el formulario para registrar tus horas de esta semana."),
        ]);
        return;
      }

      // Si no es horas, cerramos panel y seguimos normal
      setShowHoursInline(false);

      setIsSending(true);

    try {
      const authHeaders = await getAuthHeaders();
      // ------------------------------------------
      // 1) MODO PLAN DE MEJORA → /api/plans/review
      // ------------------------------------------
      if (modeRef.current === "plan_mejora") {
        // ⚠️ IMPORTANTE: dentro de este handleSend usamos un chatId "efectivo" local,
        let effectiveChatId: string | null = chatIdRef.current;

        // El turno va al chat del plan: si todavía no hay chat activo, o el activo no es el del plan
        // (recién se cambió de modo), se resuelve con el servidor.
        if (!effectiveChatId || (planChatId && effectiveChatId !== planChatId)) {
          effectiveChatId = await ensureAdvisorChatId();
        }

        if (!effectiveChatId) {
          const bootstrapError =
            advisorChatBootstrapErrorRef.current ??
            "⚠️ No pude obtener el chat activo del Asesor. Recarga la página e inténtalo nuevamente.";

          setMessages((prev) => [
            ...prev,
            createMessage("advisor", bootstrapError),
          ]);
          return;
        }

        const advisorChatId = effectiveChatId;

        await persistMessageDB({ chatId: advisorChatId, role: "user", content: text, clientMessageId: userMessage.id });

        if (looksLikeAdvisorProgressStatusQuestion(text)) {
          await handleAdvisorProgressStatusQuestion();
          return;
        }

        const ctx = await getPlanContextStatusCached();
        const lastReport = await getLastProductivityReportCached();
        if (ctx.ok && ctx.status !== "confirmed") {
          const handledStage0 = await handleStage0DraftFlow({
            text,
            ctx,
          });

          if (handledStage0) {
            return;
          }
        }
        const lastStatus = lastReport.ok ? lastReport.payload?.status : null;
        const isStage1Validated = lastStatus === "validated";

        // ✅ Etapa 1 (Productividad) NO bloquea el avance a FODA y siguientes.
        // La productividad se puede completar cuando el estudiante tenga datos del mes.
        const allowSkipProductivity = true;
        const diagUnlocked = isStage1Validated || allowSkipProductivity;

        // ================================
        // ETAPA 9: Reporte de avances (fluido con assistant)
        // ================================
        if (activeAdvisorStage === 9 && progressState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleProgressTurn(advisorTurnDeps, { text, effectiveChatId, advisorChatId, progressState });
          return;
        }

        // ================================
        // ETAPA 8: Planificación (assistant decide intención y cierre)
        // ================================
        if (activeAdvisorStage === 8 && planningState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handlePlanningTurn(advisorTurnDeps, { text, ctx, effectiveChatId, advisorChatId, planningState });
          return;
        }

        // ================================
        // ETAPA 7: Plan de mejora (assistant decide intención y cierre)
        // ================================
        if (activeAdvisorStage === 7 && improvementState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleImprovementTurn(advisorTurnDeps, { text, ctx, effectiveChatId, advisorChatId, improvementState });
          return;
        }

        // ================================
        // ETAPA 6: Objetivos (en progreso)
        // ================================
        if (activeAdvisorStage === 6 && objectivesState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleObjectivesTurn(advisorTurnDeps, { text, effectiveChatId, advisorChatId, ctx, objectivesState });
          return;
        }

        // ================================
        // ETAPA 5: Pareto (en progreso)
        // ================================

        if (activeAdvisorStage === 5 && paretoState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleParetoTurn(advisorTurnDeps, { text, ctx, effectiveChatId, advisorChatId, paretoState });
          return;
        }

        // ================================
        // ETAPA 4: Ishikawa (fluido con assistant)
        // ================================

        let effectiveIshikawaState: IshikawaState | null =
         activeAdvisorStage === 4 ? ishikawaState : null;

        // ✅ Si el usuario viene de "Nuevo chat" y el state aún no cargó en React,
        // lo buscamos directo del backend (chatId opcional, fallback por periodo).
        if (
          !effectiveIshikawaState &&
          activeAdvisorStage === 4 &&
          ctx.ok &&
          ctx.status === "confirmed" &&
          diagUnlocked &&
          effectiveChatId
        ) {
          const resIsh = await getIshikawaState({ chatId: effectiveChatId });
          const exists = resIsh.ok && resIsh.payload?.exists && resIsh.payload?.state;

          if (exists) {
            effectiveIshikawaState = resIsh.payload.state as IshikawaState;
            setIshikawaState(effectiveIshikawaState);

            // Evita que el flujo vuelva a mostrar el cierre de Brainstorm estando en Etapa 4
            setBrainstormClosePending(false);

            // Opcional ya existente en tu lógica: migrar al chat nuevo si aplica
            if (effectiveChatId) {
              await saveIshikawaState(effectiveIshikawaState, effectiveChatId);
            }
          }
        }        

        if (activeAdvisorStage === 4 && effectiveIshikawaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleIshikawaTurn(advisorTurnDeps, { effectiveIshikawaState, effectiveChatId, text, advisorChatId, ctx, lastReport });
          return;
        }

        // ================================
        // ETAPA 3: Lluvia de ideas (en progreso)
        // ================================

        if (activeAdvisorStage === 3 && brainstormState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleBrainstormTurn(advisorTurnDeps, { text, ctx, advisorChatId, lastReport, effectiveChatId, brainstormState });
          return;
        }

        // ================================
        // ETAPA 3: Enganche inicial (si no existe estado)
        // ================================
        if (activeAdvisorStage === 3 && ctx.ok && ctx.status === "confirmed" && diagUnlocked && !brainstormState) {
          if (await handleBrainstormStartTurn(advisorTurnDeps, { text, effectiveChatId })) return;
        }

        // ================================
        // ETAPA 2: FODA (enganche inicial)
        // ================================

        // ✅ Atajo: si FODA ya está completo y el usuario dice "ok/qué sigue" → validar y pasar a Etapa 3
        if (
          activeAdvisorStage === 2 &&
          fodaState &&
          ctx.ok &&
          ctx.status === "confirmed" &&
          isStage1Validated &&
          isFodaComplete(fodaState) &&
          !brainstormState
        ) {
          if (await handleFodaCloseTurn(advisorTurnDeps, { text, advisorChatId })) return;
        }

        // ETAPA 2: FODA en progreso (con IA)
        if (activeAdvisorStage === 2 && fodaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          await handleFodaTurn(advisorTurnDeps, { text, ctx, advisorChatId, fodaState });
          return;
        }

        // 1) Si ya está confirmado: recién llamamos /api/plans/review
        const body: any = { text };
        if (effectiveChatId) body.chatId = effectiveChatId;

        // Si está confirmado pero el usuario solo saluda, NO revisamos plan
        if (isGreetingOrSmallTalk(text)) {
          await appendAssistant(
            "¡Hola! 👋 Ya tengo registrado tu **Contexto del Caso**.\n\n" +
              "Podemos continuar con la **Etapa 1: Productividad mensual**.\n\n" +
              "Si quieres, responde **ok** y empezamos."
          );
          return;
        }

        const st = await getProductivityState(chatIdRef.current);
        const hasWizard = st.ok && st.payload?.exists && st.payload?.state?.prodStep > 0;


        // ✅ Si acabamos de confirmar Etapa 0: arrancar Productividad (Etapa 1) sin /review
        if (
          ctx.ok &&
          ctx.status === "confirmed" &&
          !hasWizard &&
          isAwaitingStage1Start(clientId) &&
          (activeAdvisorStage == null || activeAdvisorStage <= 1)
        ) {
          await handleProductivityStartTurn(advisorTurnDeps, { text, ctx });
          return;
        }

        // -----------------------------
        // ETAPA 1: Productividad Wizard (LLM fluido con JSON estructurado)
        // -----------------------------
        if (ctx.ok && ctx.status === "confirmed" && prodStep > 0) {
          await handleProductivityWizardTurn(advisorTurnDeps, { text, ctx, effectiveChatId });
          return;
        }

        const res = await fetch("/api/plans/review", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        const ok = res.ok && data?.ok !== false;
        const payload = data?.data ?? data;

        if (payload?.chatId && payload.chatId !== effectiveChatId) {
          setChatId(payload.chatId);
          window.sessionStorage.setItem(storageKeyChat, payload.chatId);
        }

        if (!ok) {
          setMessages((prev) => [
            ...prev,
            createMessage(
              "assistant",
              payload?.message || payload?.error || "Hubo un problema al revisar el plan."
            ),
          ]);
          return;
        }

        let feedbackText = `Aquí tienes la revisión del plan (versión ${
          payload?.version ?? "1"
        }):\n\n`;

        if (Array.isArray(payload?.sections)) {
          for (const section of payload.sections) {
            feedbackText += `🟦 *${String(section.section).toUpperCase()}*\n${section.feedback}\n\n`;
          }
        } else if (payload?.feedback) {
          feedbackText += payload.feedback;
        }

        setMessages((prev) => [...prev, createMessage("assistant", feedbackText)]);
        return;
      }

      // ------------------------------------------
      // 2) MODO GENERAL → /api/chat
      // ------------------------------------------
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          message: text,
          chatId: chatIdRef.current,
          mode: modeRef.current,
        }),
      });

      const data = await res.json();
      const ok = res.ok && data?.ok !== false;
      const payload = data?.data ?? data;

      if (!ok) {
        setMessages((prev) => [
          ...prev,
          createMessage(
            "assistant",
            payload?.message || payload?.error || "⚠️ Error desde el servidor."
          ),
        ]);
        return;
      }

      if (payload?.chatId && payload.chatId !== chatId) {
        setChatId(payload.chatId);
        window.sessionStorage.setItem(storageKeyChat, payload.chatId);
      }

      setMessages((prev) => [...prev, createMessage("assistant", payload.reply ?? "Listo.")]);
    } catch {
      setMessages((prev) => [
        ...prev,
        createMessage("advisor", "⚠️ Ocurrió un error al procesar tu mensaje."),
      ]);
    } finally {
      setIsSending(false);
    }
  }

  async function handleNewChat(targetMode?: ChatMode) {
    const nextMode: ChatMode = targetMode ?? mode;

    setShowHoursInline(false);
    setIsSending(false);
    // -----------------------
    // MODO GENERAL: sí "nuevo chat", independiente. No toca el plan ni el chat del asesor.
    // -----------------------
    if (nextMode === "general") {
      chatIdRef.current = null;
      setChatId(null);
      setMessages([newGreeting()]);

      try {
        window.sessionStorage.removeItem(`optia-chat-id-${clientId}-general`);
        window.sessionStorage.removeItem(`optia-messages-${clientId}-general`);
      } catch {}

      return;
    }

    // -----------------------
    // MODO ASESOR (plan_mejora): el Plan de Mejora es uno solo. "Nuevo chat" vuelve a su chat
    // principal con la etapa, el historial y los artefactos; no crea otro chat ni reinicia E0.
    // -----------------------
    if (nextMode === "plan_mejora") {
      if (mode !== "plan_mejora") {
        modeRef.current = "plan_mejora";
        setMode("plan_mejora");
      } else {
        pushAssistantOnce(PLAN_CONTINUES_NOTICE);
      }

      // El arranque del asesor resuelve el chat del plan con el servidor y lo abre.
      setAdvisorRefreshNonce((n) => n + 1);
      return;
    }
  }

  function clearStorageFor(m: ChatMode) {
    try {
      window.sessionStorage.removeItem(chatIdStorageKey(clientId, m));
      window.sessionStorage.removeItem(messagesStorageKey(clientId, m));
    } catch {
      // ignore
    }
  }
  
  // Cerrar sesión
  async function handleLogout() {
    try {
      clearStorageFor("general");
       clearStorageFor("plan_mejora");
    } catch {
      // ignore
    }

    await supabase.auth.signOut();
    router.push("/");
  }

  // ---------------------------------------------
  // Subir archivo Word/PDF (Etapa 10) y validar final
  // ---------------------------------------------
  async function handleUploadPlanFile(file: File) {
    if (!file) return;
    if (!canInteract) return;

    if (!userId) {
      setMessages((prev) => [
        ...prev,
        createMessage("advisor", "Debes iniciar sesión para subir y revisar un plan de mejora."),
      ]);
      return;
    }

    if (modeRef.current !== "plan_mejora" || activeAdvisorStage !== 10) {
      await appendAssistant(
        "⚠️ En este momento no se puede subir un documento. Llega a **Etapa 10** para poder adjuntar tu Word/PDF."
      );
      return;
    }

    const effectiveChatId = chatIdRef.current ?? chatId ?? null;
    if (!effectiveChatId) {
      await appendAssistant("⚠️ No encontré un chat activo para guardar tu documento. Intenta recargar el chat.");
      return;
    }

    const currentFinalDocState: FinalDocState =
      finalDocState && isFinalDocReadyForUpload(finalDocState)
        ? finalDocState
        : {
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
    if (!effectiveChatId) {
      await appendAssistant("⚠️ No encontré un chat activo para guardar tu documento. Intenta recargar el chat.");
      return;
    }

    setMessages((prev) => [
      ...prev,
      createMessage(
        "assistant",
        `📄 Recibí el archivo "${file.name}". Estoy extrayendo el texto y evaluando el documento final...`
      ),
    ]);
    setIsSending(true);

    try {
      const authHeaders = await getAuthHeaders();

      // 1) Mantener /api/plans/upload (extrae texto + devuelve storagePath)
      const formData = new FormData();
      formData.append("file", file);
      formData.append("chatId", effectiveChatId);
      formData.append("versionNumber", String(currentFinalDocState.versionNumber));

      const uploadRes = await fetch("/api/plans/upload", {
        method: "POST",
        headers: { ...authHeaders },
        body: formData,
      });

      const uploadData = await uploadRes.json().catch(() => null);
      const uploadOk = uploadRes.ok && uploadData?.ok !== false;
      const uploadPayload = uploadData?.data ?? uploadData;

      if (!uploadOk) {
        await appendAssistant(
          uploadPayload?.message ||
            uploadPayload?.error ||
            "No se pudo procesar el archivo. Verifica que sea PDF o Word (.docx)."
        );
        return;
      }

      const extractedText: string = String(uploadPayload?.text ?? "");
      const storagePath: string = String(uploadPayload?.storagePath ?? "");

      if (extractedText.trim().length < 50 || !storagePath) {
        await appendAssistant(
          "⚠️ Se subió el archivo, pero no se pudo obtener el texto o el storagePath. Intenta subirlo nuevamente."
        );
        return;
      }

      // 2) Llamar IA de Etapa 10 (NO usar /api/plans/review)
      const a = await callFinalDocAssistant({
        effectiveChatId,
        fileName: file.name,
        storagePath,
        extractedText,
      });

      if (!a.ok || !a.payload?.assistantMessage || !a.payload?.updates?.nextState) {
        await appendAssistant(
          a.payload?.message ||
            a.payload?.error ||
            "⚠️ No se pudo evaluar el documento final. Intenta subirlo otra vez."
        );
        return;
      }

      const nextFromApi = a.payload.updates.nextState as any;

      // La versión la fija el servidor; el cliente solo la refleja.
      const versionNumber: 1 | 2 = nextFromApi?.versionNumber === 2 ? 2 : 1;

      const nextState: FinalDocState = {
        step: "review",
        versionNumber,
        lastFeedback: String(a.payload.assistantMessage ?? "") || null,
        upload: {
          fileName: file.name,
          storagePath,
          extractedText,
          uploadedAt: new Date().toISOString(),
        },
        extractedSections: (nextFromApi?.extractedSections ?? null) as any,
        evaluation: (nextFromApi?.evaluation ?? null) as any,
      };

      setFinalDocState(nextState);
      await saveFinalDocState(nextState, effectiveChatId);

      await appendAssistant(a.payload.assistantMessage, a.signedReply);

      // 3) Validar / cerrar o pedir v2
      const v = await validateFinalDoc(effectiveChatId);
      if (!v.ok) {
        await appendAssistant("⚠️ No se pudo validar la Etapa 10. Intenta nuevamente.");
        return;
      }

      const valid = Boolean((v.payload as any)?.valid);
      const msg = String((v.payload as any)?.message ?? "").trim();

      if (valid) {
        if (msg) await appendAssistant(msg);
        const finalized: FinalDocState = { ...nextState, step: "finalized" };
        setFinalDocState(finalized);
        await saveFinalDocState(finalized, effectiveChatId);
        return;
      }

      // Si no valida, el backend pide v2 (solo pasa cuando es v1 con observaciones)
      if (msg) await appendAssistant(msg);

      const needsV2: FinalDocState = {
        ...nextState,
        step: "needs_v2",
        versionNumber: 2,
        lastFeedback: msg || nextState.lastFeedback,
      };

      setFinalDocState(needsV2);
      await saveFinalDocState(needsV2, effectiveChatId);
    } catch (e) {
      console.error("Error en handleUploadPlanFile:", e);
      await appendAssistant("⚠️ Ocurrió un error al procesar el documento final.");
    } finally {
      setIsSending(false);
    }
  }

  // -----------------------------
  // RENDER
  // -----------------------------
  return (
    <ChatLayout
      sidebar={
        <Sidebar
          currentChatId={chatId}
          currentMode={mode}
          activeAdvisorStage={activeAdvisorStage}
          onSelectChat={(id, pickedMode) => {
            const m = pickedMode === "plan_mejora" ? "plan_mejora" : "general";
            setShowHoursInline(false);
            modeRef.current = m;

            // El asesor siempre abre el chat del plan: lo resuelve su arranque con el servidor.
            if (m === "plan_mejora") {
              setMode(m);
              setAdvisorRefreshNonce((n) => n + 1);
              return;
            }

            chatIdRef.current = id;
            setMode(m);
            setChatId(id);
            setStage0Draft({});
          }}
          onNewChat={() => handleNewChat()}
          onLogout={handleLogout}
          displayName={chatIdentity.headerName}
          planChatId={planChatId}
        />
      }
      sidebarOpen={sidebarOpen}
      onCloseSidebar={() => setSidebarOpen(false)}
    >
      {/* Barra superior interna del chat */}
      <ChatHeader
        theme={theme}
        displayName={chatIdentity.headerName}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onToggleTheme={toggleTheme}
      />

      {/* Selector de modo */}
      <ModeSelector
        mode={mode}
        onSelectGeneral={() => {
          if (mode === "general") return;
          setShowHoursInline(false);
          modeRef.current = "general";
          setMode("general");
        }}
        onSelectPlanMejora={() => {
          if (mode === "plan_mejora") return;
          setShowHoursInline(false);
          modeRef.current = "plan_mejora";
          // El arranque del asesor (effect por cambio de modo) resuelve y abre el chat del plan.
          setMode("plan_mejora");
        }}
      />

      {gateMessage && (
        <div className="mb-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-200">
          {gateMessage}
        </div>
      )}

      {/*
        PASO 1 (UI): el composer se superpone al chat (tipo Gemini/iMessage).
        Esto evita que el "fondo" del panel cree una barra sólida debajo del input.
        (El espacio extra y autoscroll se ajustan en el PASO 2)
      */}
      <div ref={chatAreaRef} className="relative flex-1 min-h-0 flex flex-col">
        {/* ✅ el área scrollable debe ser flex-1 para ocupar todo el alto disponible */}
        <div className="flex-1 min-h-0 flex">
          <MessageList messages={messages} isTyping={isSending} />
        </div>

        {showHoursInline && (
          <div className="mt-3">
            <HoursInlinePanel onClose={() => setShowHoursInline(false)} />
          </div>
        )}

        {/* ✅ composer flotante abajo */}

        <div className="chat-composer absolute inset-x-0 bottom-3 z-20 pointer-events-none px-2 sm:px-3">
          <div ref={composerMeasureRef} className="pointer-events-auto relative z-10 mx-auto w-full max-w-4xl">
            <PersistFailureNotice
              notice={describePersistFailures(persistFailures.failures)}
              retrying={persistFailures.retrying}
              onRetry={() => void persistFailures.retry(sendMessageToHistory)}
              onDismiss={persistFailures.dismiss}
            />
            <MessageInput
              onSend={handleSend}
              disabled={isSending || !canInteract}
              onUploadFile={
                canShowFinalDocUploadButton(
                  mode,
                  canInteract,
                  activeAdvisorStage,
                  finalDocState
                )
                  ? handleUploadPlanFile
                  : undefined
              }
            />
          </div>
        </div>

      </div>
    </ChatLayout>
  );
}
