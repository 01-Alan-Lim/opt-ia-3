// src/app/chat/page.tsx
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { HoursInlinePanel } from "@/components/chat/HoursInlinePanel";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { ChatAccessDenied, ChatGateLoading } from "@/components/chat/ChatGateScreen";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ModeSelector } from "@/components/chat/ModeSelector";
import * as advisorApi from "./_lib/advisorApi";
import { useAccessGate } from "./_lib/useAccessGate";
import { useChatSession } from "./_lib/useChatSession";
import {
  useAdvisorEarlyStageEffects,
  useAdvisorFinalDocEffect,
  useAdvisorLateStageEffects,
  useAdvisorStageState,
} from "./_lib/useAdvisorStages";
import { GREETING, useChatHistory, useChatHistoryPersistence } from "./_lib/useChatHistory";
import { Message } from "@/lib/types";
import {
  BrainstormState,
  sanitizeBrainstormState,
  resolveBrainstormStep,
  isBrainstormReadyToClose,
} from "@/lib/plan/brainstormFlow";
import { MAX_WHY_DEPTH, MIN_ROOT_CAUSES } from "@/lib/plan/rootCauseLimits";
import {
  NO_TURN_UI,
  parseIshikawaTurnUi,
  type BranchClosure,
  type IshikawaTurnUi,
  type PendingRootMatch,
  type RootCauseEntry,
} from "@/lib/plan/ishikawaTree";
import { evaluateIshikawaReadiness } from "@/lib/plan/ishikawaReadiness";
import {
  isGreetingOrSmallTalk,
  isHoursIntent,
  isProdQuestion,
  isReadyIntent,
  isShortAffirmativeReply,
  looksLikeAdvisorProgressStatusQuestion,
  looksLikeObjectivesClosureRequest,
  looksLikeProgressClosureRequest,
  looksLikeStage6NextStepQuestion,
  normalizeText,
  wantsAdvanceStage,
  wantsKeepAdding,
  wantsStage6ValidationNow,
} from "@/lib/plan/advisorClientIntent";
import {
  type Stage0ContextJson,
  type Stage0InterpretPayload,
  advisorResumeGreeting,
  askForMissingStage0Field,
  buildAdvisorGreeting,
  buildStage0ProgressMessage,
  buildStage0Welcome,
  classifyStage0DecisionIntent,
  detectEditingField,
  detectStage0Intent,
  extractStage0Deterministic,
  formatContextSummary,
  getNextStage0StepFromContext,
  hasMultipleStage0FieldSignals,
  hasStage0Extraction,
  hasStage0ProductSignal,
  lastAssistantIsStage0Prompt,
  mergeStage0Context,
  mergeStage0Extraction,
  promptForStep,
  readStage0Context,
  readStage0Extraction,
  shouldAnswerWithoutLLM,
  stage0HelpMessage,
  stage0StepForField,
} from "@/lib/plan/stage0Context";
import {
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
  applyAssistantPatchToDraft,
  canShowFinalDocUploadButton,
  isAdvisorRuntimeStageValue,
  isFinalDocReadyForUpload,
  isFodaComplete,
  isObjectivesReadyForValidation,
  isObjectivesStateLike,
  isProgressReadyForValidation,
  mergeCosts,
  normalizeParetoStateClient,
  sanitizeFodaState,
} from "@/lib/plan/advisorStates";
import {
  buildStage6ProgressTruthMessage,
  getAdvisorStageLabel,
  promptProd,
} from "@/lib/plan/advisorMessages";
import {
  createMessage,
  formatAssistantMessageForReadability,
  softenAssistantLeadInChat,
} from "@/lib/chat/assistantFormat";
import { chatIdStorageKey, messagesStorageKey } from "@/lib/chat/chatStorage";


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
  const { ready, sessionEmail, userId, accessToken, authenticated, displayName, getAuthHeaders } =
    useChatSession();

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
  type PlanContextStatus = {
    ok: boolean;
    status: "draft" | "confirmed";
    exists: boolean;
    chatId: string | null;
    contextJson: any;
    contextText: string | null;
    message?: string | null;
  };

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

  type LastProductivityReport = { ok: boolean; payload: any | null };

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
  } = useAdvisorStageState();

  type IshikawaSubCause = {
    id: string;
    text: string;
    whys?: string[];
    rejectedWhyAttempts?: number; // rechazos deterministas seguidos en esta subcausa
    reformulateWhy?: boolean; // el próximo porqué aceptado reemplaza al último
    whysReplace?: boolean; // solo en tránsito: la lista de porqués es autoritativa al guardar
    closure?: BranchClosure; // cierre revisado de la rama; solo lo escribe el servidor
  };

  type IshikawaMainCause = {
    id: string;
    text: string;
    subCauses: IshikawaSubCause[];
  };

  type IshikawaCategoryNode = {
    id: string;
    name: string;
    mainCauses: IshikawaMainCause[];
  };

  type IshikawaState = {
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


  const [ishikawaState, setIshikawaState] = useState<IshikawaState | null>(null);
  const saveIshikawaTimerRef = useRef<number | null>(null);

  const [ishikawaClosePending, setIshikawaClosePending] = useState(false);

  // -----------------------------
  // Redirect si no está autenticado y gate final del chat (FUENTE DE VERDAD: /api/me)
  // -----------------------------
  const { gateChecked, gateMessage, accessDenied, canInteract } = useAccessGate({ ready, authenticated, router });

  // -----------------------------
  // 2a. Cargar desde sessionStorage y 2b. historial del backend (useChatHistory)
  // -----------------------------
  useChatHistory({
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
  });

  // -----------------------------
  // 2d. (Asesor) Estado desde DB (plan_case_contexts)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;

    (async () => {
      const ctx = await getPlanContextStatusCached();
      if (!active) return;
      if (!ctx.ok) return;

      const fresh = getPlanFresh(clientId);

      // ✅ Si es "fresh", creamos un chat NUEVO del asesor (chat-only)
      if (fresh) {
        // Creamos chat nuevo SOLO para conversación
        const createdChatId = await ensureAdvisorChatId({ createNew: true });
        const created = { ok: Boolean(createdChatId), chatId: createdChatId };
        if (!active) return;
        // Ya no estamos fresh después de crear el chat
        setPlanFresh(clientId, false);

        const lastReport = await getLastProductivityReportCached();
        if (!active) return;

        const lastStatus = lastReport.ok ? lastReport.payload?.status : null;
        const isStage1Validated = lastStatus === "validated";


        if (ctx.status === "confirmed" && created.ok && created.chatId) {
          const restored = await restoreLatestAdvisorStageToNewChat(created.chatId);
          if (!active) return;
          if (restored) return;
        }


        // Si el contexto está confirmado, abrir con resumen + confirmación Etapa 1
        if (ctx.status === "confirmed") {
          if (isStage1Validated) {
            // ✅ Si Etapa 1 ya está validada, decidir si retomamos Etapa 2 o 3
            const resBS = await getBrainstormState();
            const bsExists = resBS.ok && resBS.payload?.exists;
            const bs = (resBS.payload?.state ?? null) as any;

            if (bsExists && bs) {
              // Rehidrata también el estado local
              setBrainstormState(sanitizeBrainstormState(bs));

              const nIdeas = Array.isArray(bs.ideas) ? bs.ideas.length : 0;
              const min = typeof bs.minIdeas === "number" ? bs.minIdeas : 10;
              const problem = bs.problem?.text ? `**${bs.problem.text}**` : "**(aún no definido)**";

              const resumeMsg =
                "📌 Ya tienes avance en **Etapa 3 (Lluvia de ideas)**.\n\n" +
                `- Problema: ${problem}\n` +
                `- Ideas: **${nIdeas} / ${min}**\n\n` +
                "👉 Continúa con la siguiente causa (una idea clara y concreta).";

              setMessages([createMessage("assistant", resumeMsg)]);

              if (created.ok && created.chatId) {
                await persistMessageDB({
                  chatId: created.chatId,
                  role: "assistant",
                  content: resumeMsg,
                });
              }

              setStage0Draft({});
              return;
            }

            // Si NO hay avance en Etapa 3, mantenemos el mensaje original de Etapa 2
            const p = lastReport.payload?.payload ?? null;
            const period = p?.period_key ?? "(sin periodo)";
            const type = p?.type ?? "(sin tipo)";

            const doneMsg =
              "✅ Ya tienes **Etapa 1 (Productividad)** completada y validada.\n\n" +
              `- Periodo: **${period}**\n` +
              `- Tipo: **${type}**\n\n` +
              "👉 Puedes continuar con **Etapa 2: Análisis FODA** cuando quieras.";

            setMessages([createMessage("assistant", doneMsg)]);

            if (created.ok && created.chatId) {
              await persistMessageDB({
                chatId: created.chatId,
                role: "assistant",
                content: doneMsg,
              });
            }

            setStage0Draft({});
            return;
          }
        }

        // Si está draft, iniciamos wizard en el step correcto (sin guardar nada todavía)
        const next = getNextStage0StepFromContext(ctx.contextJson);

        setStage0Draft({
          sector: typeof ctx.contextJson?.sector === "string" ? ctx.contextJson.sector : undefined,
          products: Array.isArray(ctx.contextJson?.products) ? ctx.contextJson.products : undefined,
          process_focus: Array.isArray(ctx.contextJson?.process_focus) ? ctx.contextJson.process_focus : undefined,
        });

        const step = ((next === 0 ? 1 : next) as 1 | 2 | 3);
        const greet = advisorResumeGreeting(ctx.contextJson, step);

        setMessages([
          createMessage("assistant", greet),
          createMessage("assistant", promptForStep(step)),
        ]);

        return;
      }

      // ✅ Si NO es fresh: sincronizamos el chatId con DB solo si no hay chatId local aún
      if (!chatIdRef.current) {
        if (ctx.chatId) {
          adoptAdvisorChatId(ctx.chatId);
        } else {
          await ensureAdvisorChatId();
          if (!active) return;
        }
      }

      // ✅ Si está CONFIRMED: no tocar wizard
      if (ctx.status === "confirmed") {
        // Si no hay mensajes aún, mostrar resumen + pedir confirmación Etapa 1
        if (messagesRef.current.length === 0) {
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

        setStage0Draft({});
        return;
      }

      // ✅ DRAFT: reanudar wizard en el step correcto
      const nextStep = getNextStage0StepFromContext(ctx.contextJson);
      const step = (nextStep === 0 ? 1 : nextStep) as 1 | 2 | 3;

      setStage0Draft({
        sector: typeof ctx.contextJson?.sector === "string" ? ctx.contextJson.sector : undefined,
        products: Array.isArray(ctx.contextJson?.products) ? ctx.contextJson.products : undefined,
        process_focus: Array.isArray(ctx.contextJson?.process_focus) ? ctx.contextJson.process_focus : undefined,
      });

      // Si no hay prompt visible, empuja solo 1 vez la pregunta correcta
      if (!lastAssistantIsStage0Prompt(messages)) {
        pushAssistantOnce(promptForStep(step));
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, mode, advisorRefreshNonce]); // ⚠️ Intencional: no depende de chatId para evitar loops

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
      const last = [...prev].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (last.trim() === text.trim()) return prev;
      return [...prev, createMessage("assistant", text)];
    });
  }

  function planFreshKey(cid: string) {
    return `optia-plan-fresh-${cid}`;
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

  function setPlanFresh(cid: string, value: boolean) {
    try {
      if (value) window.sessionStorage.setItem(planFreshKey(cid), "1");
      else window.sessionStorage.removeItem(planFreshKey(cid));
    } catch {}
  }

  function getPlanFresh(cid: string) {
    try {
      return window.sessionStorage.getItem(planFreshKey(cid)) === "1";
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

  function shouldPreserveAdvisorStateOnRefreshFailure(args: {
    currentStage: AdvisorRuntimeStage;
    status: number;
    errorCode?: string | null;
  }) {
    if (args.currentStage == null || args.currentStage <= 0) return false;

    if (args.status >= 500) return true;
    if (args.errorCode === "AUTH_UPSTREAM_TIMEOUT") return true;

    return false;
  }

  // -----------------------------
  // API helpers (fetch backend)
  // -----------------------------

  async function getActiveAdvisorStage() {
    const authHeaders = await getAuthHeaders();

    return advisorApi.getActiveAdvisorStage(authHeaders);
  }

  function asRecordOrNull(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
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

    async function refreshActiveAdvisorStage() {
    const resolved = await getActiveAdvisorStage();

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

  async function persistMessageDB(input: {
    chatId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.persistMessageDB(authHeaders, input);
  }

  async function appendAssistant(content: unknown) {
    const safeRaw =
      typeof content === "string"
        ? content
        : content == null
          ? ""
          : (() => {
              try {
                return JSON.stringify(content);
              } catch {
                return String(content);
              }
            })();

    let safe =
      modeRef.current === "plan_mejora"
        ? softenAssistantLeadInChat(safeRaw)
        : safeRaw;

    if (modeRef.current === "plan_mejora") {
      safe = formatAssistantMessageForReadability(safe);
    }

    setMessages((prev) => [...prev, createMessage("assistant", safe)]);

    if (modeRef.current === "plan_mejora" && chatIdRef.current) {
      await persistMessageDB({ chatId: chatIdRef.current, role: "assistant", content: safe });
    }
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

  async function ensureAdvisorChatId(opts?: { createNew?: boolean }): Promise<string | null> {
    if (chatIdRef.current) return chatIdRef.current;
    if (advisorChatBootstrapPromiseRef.current) return advisorChatBootstrapPromiseRef.current;

    const bootstrapPromise = (async () => {
      advisorChatBootstrapErrorRef.current = null;

      if (!opts?.createNew) {
        const ctx = await getPlanContextStatusCached({ force: true });

        if (!ctx.ok) {
          advisorChatBootstrapErrorRef.current = ctx.message ?? null;
          return null;
        }

        if (ctx.chatId) {
          adoptAdvisorChatId(ctx.chatId);
          return ctx.chatId;
        }
      }

      const created = await createAdvisorChatOnly();

      if (created.ok && created.chatId) {
        setPlanFresh(clientId, false);
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
    opts?: { userMessage?: string; assistantMessage?: string },
    baseContextJson?: {
      sector?: string;
      products?: string[];
      process_focus?: string[];
      stage?: string;
    }
  ) {

    const authHeaders = await getAuthHeaders();

    const contextJson = {
      stage: baseContextJson?.stage ?? "ETAPA_0",
      sector:
        nextDraft.sector ??
        stage0Draft.sector ??
        baseContextJson?.sector ??
        "",
      products:
        nextDraft.products ??
        stage0Draft.products ??
        baseContextJson?.products ??
        [],
      process_focus:
        nextDraft.process_focus ??
        stage0Draft.process_focus ??
        baseContextJson?.process_focus ??
        [],
    };

    const contextText = [
      `Sector/Rubro: ${contextJson.sector || "(pendiente)"}`,
      `Producto/servicio: ${(contextJson.products || []).join(", ") || "(pendiente)"}`,
      `Proceso/área: ${(contextJson.process_focus || []).join(", ") || "(pendiente)"}`,
    ].join("\n");

    const reqBody: {
      contextJson: Stage0ContextJson;
      contextText: string;
      userMessage?: string;
      assistantMessage?: string;
      chatId?: string;
    } = {
      contextJson,
      contextText: contextText ?? "",
    };
    if (opts?.userMessage) reqBody.userMessage = opts.userMessage;
    if (opts?.assistantMessage) reqBody.assistantMessage = opts.assistantMessage;
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

  async function confirmPlanContext() {
    const authHeaders = await getAuthHeaders();
    return advisorApi.confirmPlanContext(authHeaders);
  }

  async function handleStage0DraftFlowV2(input: {
    text: string;
    ctx: PlanContextStatus;
  }): Promise<boolean> {
    const { text, ctx } = input;
    const ctxJson = (ctx.contextJson ?? {}) as Record<string, unknown>;
    const currentStage0Context = readStage0Context(ctxJson);

    const editingStep = stage0StepForField(editingField);
    const nextStep = getNextStage0StepFromContext(ctxJson);
    const step = editingStep ?? ((nextStep === 0 ? 1 : nextStep) as 1 | 2 | 3);

    const localIntent = detectStage0Intent(text);
    const decisionIntent = classifyStage0DecisionIntent(text, localIntent);
    const correctionTarget =
      editingField ?? (decisionIntent === "correction" ? detectEditingField(text) : null);
    const forcedField = correctionTarget ?? null;
    const deterministicExtraction = extractStage0Deterministic(text, step, forcedField);

    if (shouldAnswerWithoutLLM(decisionIntent, deterministicExtraction)) {
      if (decisionIntent === "unknown") {
        await appendAssistant(
          stage0HelpMessage(step) +
            "\n\nElige una opcion aproximada o dime como lo describiria la empresa."
        );
        return true;
      }

      await appendAssistant(
        decisionIntent === "meta_process"
          ? "Estamos armando el contexto base del caso para que las siguientes etapas no trabajen con datos inventados.\n\n" +
              askForMissingStage0Field(step, currentStage0Context)
          : stage0HelpMessage(step)
      );
      return true;
    }

    const shouldAskLLM =
      hasMultipleStage0FieldSignals(text) ||
      !hasStage0Extraction(deterministicExtraction) ||
      (!forcedField &&
        step === 1 &&
        hasStage0ProductSignal(text) &&
        !deterministicExtraction.sector);

    const interpreted = shouldAskLLM
      ? await interpretStage0WithLLM(step, text, ctxJson)
      : { ok: true, payload: null };
    const result =
      interpreted.ok && interpreted.payload
        ? (interpreted.payload as Stage0InterpretPayload)
        : null;

    const llmExtraction = result ? readStage0Extraction(result) : {};
    let extractedContext = mergeStage0Extraction(llmExtraction, deterministicExtraction);

    if (forcedField === "sector") {
      extractedContext = { sector: extractedContext.sector };
    } else if (forcedField === "products") {
      extractedContext = { products: extractedContext.products };
    } else if (forcedField === "process_focus") {
      extractedContext = { process_focus: extractedContext.process_focus };
    }

    if (hasStage0Extraction(extractedContext)) {
      const nextContext = mergeStage0Context(currentStage0Context, extractedContext);
      const assistantMessage = buildStage0ProgressMessage(extractedContext, nextContext);

      const saved = await savePlanContextDraft(
        extractedContext,
        undefined,
        currentStage0Context
      );

      if (!saved.ok) {
        await appendAssistant("No pude guardar el contexto en este momento. Intenta otra vez.");
        return true;
      }

      planContextCacheRef.current = null;
      const refreshed = await getPlanContextStatusCached({ force: true });
      const liveContext = refreshed.ok
        ? readStage0Context((refreshed.contextJson ?? {}) as Record<string, unknown>)
        : nextContext;
      const liveMissingStep = getNextStage0StepFromContext(liveContext);

      if (liveMissingStep !== 0) {
        setStage0Draft(liveContext);
        setEditingField(null);

        planContextCacheRef.current = {
          at: Date.now(),
          data: {
            ...ctx,
            exists: true,
            status: "draft",
            chatId: refreshed.ok
              ? refreshed.chatId
              : ((saved.payload?.chatId ?? ctx.chatId) as string | null),
            contextJson: liveContext,
            contextText: refreshed.ok
              ? refreshed.contextText
              : ((saved.payload?.contextText ?? ctx.contextText) as string | null),
          },
        };

        await appendAssistant(
          buildStage0ProgressMessage(extractedContext, liveContext) || assistantMessage
        );
        return true;
      }

      const confirmed = await confirmPlanContext();

      if (!confirmed.ok) {
        await appendAssistant(
          confirmed.payload?.message ||
            "Guarde el contexto, pero no pude confirmarlo todavia. Intenta nuevamente."
        );
        return true;
      }

      planContextCacheRef.current = null;
      const confirmedFresh = await getPlanContextStatusCached({ force: true });
      const finalContext = (
        confirmedFresh.ok
          ? confirmedFresh.contextJson
          : confirmed.payload?.contextJson ?? liveContext
      ) as Record<string, unknown>;

      planContextCacheRef.current = {
        at: Date.now(),
        data: {
          ...ctx,
          exists: true,
          status: "confirmed",
          chatId: (confirmed.payload?.chatId ?? saved.payload?.chatId ?? ctx.chatId) as string | null,
          contextJson: finalContext,
          contextText: (confirmed.payload?.contextText ?? ctx.contextText) as string | null,
        },
      };

      setStage0Draft(readStage0Context(finalContext));
      setEditingField(null);
      setAwaitingStage1Start(clientId, true);

      await appendAssistant(
        "Etapa 0 completada y confirmada.\n\n" +
          formatContextSummary(finalContext) +
          "\n\nYa quedo registrado el contexto base de tu caso.\n\n" +
          "Si tienes datos mensuales, escribe **productividad**. Si no, responde **ok** y seguimos con el diagnostico."
      );

      return true;
    }

    if (decisionIntent === "correction") {
      const targetStep = stage0StepForField(correctionTarget);
      if (correctionTarget && targetStep) {
        setEditingField(correctionTarget);
        await appendAssistant(
          "Claro, lo ajustamos. Dime el nuevo dato para actualizarlo sin reiniciar el contexto.\n\n" +
            askForMissingStage0Field(targetStep, currentStage0Context)
        );
        return true;
      }

      await appendAssistant(
        "Claro, podemos corregir el contexto. Dime si quieres cambiar **rubro**, **producto/servicio** o **area/proceso**."
      );
      return true;
    }

    if (decisionIntent === "context_change") {
      await appendAssistant(
        "Podemos ajustar el contexto del caso. Dime que dato quieres cambiar: **rubro**, **producto/servicio** o **area/proceso**."
      );
      return true;
    }

    if (localIntent === "GREETING" || localIntent === "START") {
      await appendAssistant(buildStage0Welcome(step));
      return true;
    }

    if (localIntent === "CONFIRM") {
      await appendAssistant(
        "Aun falta completar un dato del contexto antes de avanzar.\n\n" +
          askForMissingStage0Field(step, currentStage0Context)
      );
      return true;
    }

    if (decisionIntent === "unknown") {
      await appendAssistant(
        stage0HelpMessage(step) +
          "\n\nElige una opcion aproximada o dime como lo describiria la empresa."
      );
      return true;
    }

    if (
      decisionIntent === "help_request" ||
      decisionIntent === "example_request" ||
      decisionIntent === "meta_process" ||
      decisionIntent === "off_topic" ||
      decisionIntent === "ambiguous" ||
      localIntent === "QUESTION"
    ) {
      await appendAssistant(
        decisionIntent === "meta_process"
          ? "Estamos armando el contexto base del caso para que las siguientes etapas no trabajen con datos inventados.\n\n" +
              askForMissingStage0Field(step, currentStage0Context)
          : stage0HelpMessage(step)
      );
      return true;
    }

    const clarificationQuestion =
      result && typeof result.clarificationQuestion === "string"
        ? result.clarificationQuestion.trim()
        : "";

    await appendAssistant(
      clarificationQuestion ||
        "Necesito un dato un poco mas claro para guardarlo correctamente.\n\n" +
          askForMissingStage0Field(step, currentStage0Context)
    );
    return true;
  }

  async function handleStage0DraftFlow(input: {
    text: string;
    ctx: PlanContextStatus;
  }): Promise<boolean> {
    return handleStage0DraftFlowV2(input);

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
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-maxTurns);

    const base = msgs
      .map((m) => `${m.role === "user" ? "STUDENT" : "ASSISTANT"}: ${m.content}`)
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

    const injected =
      "SYSTEM: Contexto interno Etapa 10 (Documento final)\n" +
      `- Estado: ${finalDocState!.step}\n` +
      `- Versión actual: ${finalDocState!.versionNumber}\n` +
      "- Feedback anterior entregado al estudiante (resumen):\n" +
      feedback +
      "\n\n" +
      "SYSTEM: Instrucción: Responde conversacionalmente usando este feedback como referencia. No inventes información.\n\n";

    return injected + base;
  }

  function buildRecentMessagesForIshikawa(maxMessages = 6) {
    return messagesRef.current
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-maxMessages)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" as const : "user" as const,
        content: String(m.content ?? "").trim(),
      }))
      .filter((m) => m.content.length > 0);
  }

  async function callProductivityAssistant(input: {
    studentMessage: string;
    prodStep: number;
    prodDraft: ProductivityDraft;
    caseContext: any;
  }) {
    const authHeaders = await getAuthHeaders();

    return advisorApi.callProductivityAssistant(authHeaders, input, buildRecentHistoryForAssistant(10));
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

    return advisorApi.callFodaAssistant(authHeaders, input, buildRecentHistoryForAssistant(10));
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

    return advisorApi.callBrainstormAssistant(authHeaders, input, buildRecentHistoryForAssistant(10));
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
      return { ok: false as const, assistantMessage: "⚠️ No pude procesar tu mensaje en Ishikawa.", nextState: args.ishikawaState, ui: NO_TURN_UI };
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
      };
    }

    return {
      ok: true as const,
      assistantMessage,
      nextState: nextState as IshikawaState,
      ui: parseIshikawaTurnUi(data?.ui),
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }

      const msg =
        "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
        "Tu **Contexto del Caso** ya está confirmado.\n\n" +
        "Ahora corresponde continuar con la **Etapa 2 (FODA)**.\n\n" +
        "👉 Empecemos por lo más fácil: dime una **fortaleza interna** de la empresa o del proceso analizado.";

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
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

      const greet =
      step === 1
        ? buildAdvisorGreeting(displayName)
        : "👌 Continuemos desde donde quedamos para completar el Contexto del Caso.";

      const msg = `${greet}\n\n${promptForStep(step)}`;

      setMessages([createMessage("assistant", msg)]);
      await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
      return true;
    }

    return false;
  }

  type ValidationPayloadLike = {
    next?: { toStage?: number | null; hint?: string | null } | null;
    roots?: string[] | null;
    final?: {
      criticalRoots?: string[] | null;
      selectedRoots?: string[] | null;
    } | null;
  };

  function readNextStageFromValidation(
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

  function readCriticalRootsFromValidation(
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

      // 1) Pintar SIEMPRE mensaje del usuario
      const userMessage = createMessage("user", text);
      setMessages((prev) => [...prev, userMessage]);

      // 2) Intercept horas SOLO en modo general (antes de llamar /api/chat)
      if (modeRef.current === "general" && isHoursIntent(text)) {
        setShowHoursInline(true);
        setMessages((prev) => [
          ...prev,
          createMessage("assistant", "Listo ✅ Aquí tienes el formulario para registrar tus horas de esta semana."),
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
        const mustStartFresh = getPlanFresh(clientId);

        // ⚠️ IMPORTANTE: dentro de este handleSend usamos un chatId "efectivo" local,
        let effectiveChatId: string | null = chatIdRef.current;

        if (!effectiveChatId) {
          effectiveChatId = await ensureAdvisorChatId({ createNew: mustStartFresh });
        }

        if (!effectiveChatId) {
          const bootstrapError =
            advisorChatBootstrapErrorRef.current ??
            "⚠️ No pude obtener el chat activo del Asesor. Recarga la página e inténtalo nuevamente.";

          setMessages((prev) => [
            ...prev,
            createMessage("assistant", bootstrapError),
          ]);
          return;
        }

        const advisorChatId = effectiveChatId;

        await persistMessageDB({ chatId: advisorChatId, role: "user", content: text });

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
          const assistant = await callProgressAssistant({
            studentMessage: text,
            progressState,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMsg =
              typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
                ? `⚠️ ${assistant.payload.message}`
                : "⚠️ No pude procesar tu reporte. Cuéntame brevemente qué lograste implementar hasta hoy.";
            await appendAssistant(backendMsg);
            return;
          }

          const nextState = assistant.payload.updates.nextState as ProgressState;

          setProgressState(nextState);
          await saveProgressState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          const progressAction = assistant.payload?.updates?.action;

          if (nextState.step === "review" && isProgressReadyForValidation(nextState)) {
            const shouldValidateNow =
              progressAction === "ready_to_validate" ||
              looksLikeProgressClosureRequest(text);

            if (!shouldValidateNow) {
              return;
            }

            const v = await validateProgress(effectiveChatId);

            if (!v.ok) {
              await appendAssistant("⚠️ No se pudo cerrar el reporte de avances.");
              return;
            }

            if (v.payload?.valid) {
              const moved = await applyBackendAdvisorAdvance({
                fromStage: 9,
                payload: v.payload,
                effectiveChatId: advisorChatId,
              });

              if (!moved) {
                await appendAssistant(
                  "✅ La Etapa 9 quedó validada, pero no pude preparar automáticamente la Etapa 10. Recarga el chat y retomamos."
                );
              }
              return;
            }

            await appendAssistant(
              `⚠️ ${v.payload?.message ?? "Todavía falta ajustar la Etapa 9 antes de cerrarla."}`
            );
          }

          return;
        }

        // ================================
        // ETAPA 8: Planificación (assistant decide intención y cierre)
        // ================================
        if (activeAdvisorStage === 8 && planningState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callPlanningAssistant({
            studentMessage: text,
            planningState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMsg =
              typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
                ? `⚠️ ${assistant.payload.message}`
                : "⚠️ No pude procesar tu Planificación. Dime en 1 línea cuántas semanas te quedan o qué parte del cronograma quieres ajustar.";
            await appendAssistant(backendMsg);
            return;
          }

          const nextState = assistant.payload.updates.nextState as PlanningState;
          const shouldValidateNow = assistant.payload?.decision?.shouldValidateNow === true;

          setPlanningState(nextState);
          await savePlanningState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          if (!shouldValidateNow) {
            return;
          }

          const v = await validatePlanning(effectiveChatId);

          if (!v.ok) {
            const msg = v.payload?.message ?? "No se pudo cerrar Etapa 8 (Planificación).";
            await appendAssistant(`⚠️ ${msg}`);
            return;
          }

          if (!v.payload?.valid) {
            const msg =
              v.payload?.message ??
              "La Etapa 8 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 9.";

            await appendAssistant(
              "Aún no podemos cerrar la **Etapa 8 (Planificación)**.\n\n" +
                `⚠️ ${msg}\n\n` +
                "Si quieres, te ayudo a completar exactamente lo que falta."
            );
            return;
          }

          const moved = await applyBackendAdvisorAdvance({
            fromStage: 8,
            payload: v.payload,
            effectiveChatId: advisorChatId,
          });

          if (!moved) {
            await appendAssistant(
              "✅ La Etapa 8 quedó validada, pero no pude preparar automáticamente la Etapa 9. Recarga el chat y retomamos."
            );
          }

          return;
        }

        // ================================
        // ETAPA 7: Plan de mejora (assistant decide intención y cierre)
        // ================================
        if (activeAdvisorStage === 7 && improvementState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callImprovementAssistant({
            studentMessage: text,
            improvementState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMsg =
              typeof assistant.payload?.message === "string" && assistant.payload.message.trim()
                ? `⚠️ ${assistant.payload.message}`
                : "⚠️ No pude procesar tu Plan de Mejora. Dime en 1 o 2 líneas qué parte quieres ajustar o si quieres que revise si ya está listo.";
            await appendAssistant(backendMsg);
            return;
          }

          const nextState = assistant.payload.updates.nextState as ImprovementState;
          const shouldValidateNow = assistant.payload?.decision?.shouldValidateNow === true;

          setImprovementState(nextState);
          await saveImprovementState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          if (!shouldValidateNow) {
            return;
          }

          const v = await validateImprovement(effectiveChatId);

          if (!v.ok) {
            const msg = v.payload?.message ?? "No se pudo cerrar Etapa 7 (Plan de Mejora).";
            await appendAssistant(`⚠️ ${msg}`);
            return;
          }

          if (!v.payload?.valid) {
            const msg =
              v.payload?.message ??
              "La Etapa 7 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 8.";

            await appendAssistant(
              "Aún no podemos cerrar la **Etapa 7 (Plan de Mejora)**.\n\n" +
                `⚠️ ${msg}\n\n` +
                "Si quieres, te ayudo a corregir exactamente lo que falta."
            );
            return;
          }

          const moved = await applyBackendAdvisorAdvance({
            fromStage: 7,
            payload: v.payload,
            effectiveChatId: advisorChatId,
          });

          if (!moved) {
            await appendAssistant(
              "✅ La Etapa 7 quedó validada, pero no pude preparar automáticamente la Etapa 8. Recarga el chat y retomamos."
            );
          }

          return;
        }

        // ================================
        // ETAPA 6: Objetivos (en progreso)
        // ================================
        if (activeAdvisorStage === 6 && objectivesState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          if (looksLikeStage6NextStepQuestion(text)) {
            await handleStage6NextStepQuestion({
              text,
              objectivesState,
              effectiveChatId,
              advisorChatId,
            });
            return;
          }

          const assistant = await callObjectivesAssistant({
            studentMessage: text,
            objectivesState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
          const backendCode = assistant.payload?.code ?? null;
          const backendMessage =
            assistant.payload?.message ??
            assistant.payload?.detail?.message ??
            null;

          if (backendCode === "BAD_REQUEST") {
            setObjectivesState(null);
            await clearStageState(6, effectiveChatId);

            const restored = await restoreLatestAdvisorStageToNewChat(effectiveChatId);
            if (restored) {
              return;
            }
          }

          await appendAssistant(
            backendMessage
              ? `⚠️ ${backendMessage}`
              : "⚠️ No pude procesar tus objetivos en este momento. Cuéntame brevemente qué quieres mejorar y te ayudo a redactar un objetivo general."
          );
          return;
        }

          const nextState = assistant.payload.updates.nextState as ObjectivesState;

          setObjectivesState(nextState);
          await saveObjectivesState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          // Validamos Etapa 6 cuando el estado ya está en review
          // y el estudiante confirma cierre con una frase natural o una respuesta corta.
          if (nextState.step === "review" && isObjectivesReadyForValidation(nextState)) {
            const wantsToCloseObjectives =
              looksLikeObjectivesClosureRequest(text) || isShortAffirmativeReply(text);

            if (!wantsToCloseObjectives) {
              return;
            }

            const v = await validateObjectives(effectiveChatId);

            if (!v.ok) {
              const msg = v.payload?.message ?? "No se pudo cerrar Etapa 6 (Objetivos).";
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            if (!v.payload?.valid) {
              const msg =
                v.payload?.message ??
                "La Etapa 6 aún no quedó validada. Revisa los ajustes pendientes antes de pasar a la Etapa 7.";

              await appendAssistant(
                "Aún no podemos cerrar la **Etapa 6 (Objetivos)**.\n\n" +
                  `⚠️ ${msg}\n\n` +
                  "Cuando quieras, te ayudo a corregir exactamente lo que falta."
              );
              return;
            }

            const moved = await applyBackendAdvisorAdvance({
              fromStage: 6,
              payload: v.payload,
              effectiveChatId: advisorChatId,
            });

            if (!moved) {
              await appendAssistant(
                "✅ La Etapa 6 quedó validada, pero no pude preparar automáticamente la Etapa 7. Recarga el chat y retomamos."
              );
            }
            return;
          }
          return;
        }

        // ================================
        // ETAPA 5: Pareto (en progreso)
        // ================================

        if (activeAdvisorStage === 5 && paretoState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callParetoAssistant({
            studentMessage: text,
            paretoState,
            caseContext: (ctx.contextJson ?? null) as any,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant("⚠️ No pude procesar tu avance en Pareto. ¿Puedes reformular en 1–2 líneas lo que hiciste?");
            return;
          }

          const nextState = normalizeParetoStateClient(assistant.payload.updates.nextState);

          if (!nextState) {
            await appendAssistant("⚠️ El estado de Pareto llegó incompleto. Vuelve a enviar tu último avance para continuar.");
            return;
          }

          setParetoState(nextState);
          await saveParetoState(nextState, effectiveChatId);

          // Si aún no está cerrado, mostramos guía normal
          if (nextState.step !== "done") {
            await appendAssistant(assistant.payload.assistantMessage);
            return;
          }

          // Si llegó a done, primero validamos y recién luego cerramos de verdad
          const v = await validatePareto(effectiveChatId);

          if (!v.ok) {
            const rollbackState: ParetoState = {
              ...nextState,
              step: "collect_critical",
            };

            setParetoState(rollbackState);
            await saveParetoState(rollbackState, effectiveChatId);

            const msg =
              v.payload?.message ??
              "No se pudo cerrar Etapa 5 (Pareto). Revisa que hayas enviado tu grupo crítico y el porcentaje del problema que concentra.";
            await appendAssistant(`⚠️ ${msg}`);
            return;
          }

          if (!v.payload?.valid) {
            const rollbackState: ParetoState = {
              ...nextState,
              step: "collect_critical",
            };

            setParetoState(rollbackState);
            await saveParetoState(rollbackState, effectiveChatId);

            const msg =
              v.payload?.message ??
              "Pareto aún no quedó validado. Revisa tu grupo crítico antes de pasar a Objetivos.";
            await appendAssistant(`⚠️ ${msg}`);
            return;
          }

          await appendAssistant(assistant.payload.assistantMessage);

          const moved = await applyBackendAdvisorAdvance({
            fromStage: 5,
            payload: v.payload,
            effectiveChatId: advisorChatId,
          });

          if (!moved) {
            await appendAssistant(
              "✅ La Etapa 5 quedó validada, pero no pude preparar automáticamente la Etapa 6. Recarga el chat y retomamos."
            );
          }

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
          const ishikawaState = effectiveIshikawaState;
          // 1) Si aún no hay problema, el primer mensaje del estudiante se toma como problema (1 línea)
          const problemText =
            typeof ishikawaState.problem === "string"
              ? ishikawaState.problem
              : (typeof ishikawaState.problem?.text === "string" ? ishikawaState.problem.text : "");

          if (!problemText.trim()) {
            const hasConversation = messagesRef.current.length > 0;

            // ✅ Si ya hay conversación, NO asumas que estamos empezando Ishikawa.
            // Probablemente llegó un ishikawaState desfasado/vacío (race).
            if (hasConversation) {
            const resIshFresh = await getIshikawaState({
              chatId: effectiveChatId ?? chatIdRef.current ?? null,
            });
            const freshState = resIshFresh.ok && resIshFresh.payload?.exists && resIshFresh.payload?.state
              ? (resIshFresh.payload.state as IshikawaState)
              : null;

              if (freshState) {
                setIshikawaState(freshState);
                await saveIshikawaState(freshState, effectiveChatId);

                // No agregamos ningún mensaje robótico.
                // Reintentamos el flujo normal (Gemini) con el state ya sincronizado.
                const ai = await callIshikawaAssistant({
                  studentMessage: text,
                  chatId: advisorChatId,
                  ishikawaState: freshState,
                  caseContext: ctx?.contextJson ?? null,
                  stage1Summary: null,
                  brainstormState: null,
                  recentMessages: buildRecentMessagesForIshikawa(6),
                });

                if (ai.ok) {
                  setIshikawaState(ai.nextState);
                  await saveIshikawaState(ai.nextState, effectiveChatId);
                  await appendAssistant(ai.assistantMessage);
                } else {
                  await appendAssistant("⚠️ Estoy detectando que el Ishikawa no tiene el problema cargado. ¿Puedes volver a pegar el problema principal en 1 línea?");
                }

                return;
              }

              // Si no logramos refrescar el state, pedimos el problema sin reiniciar el chat.
              await appendAssistant("⚠️ Parece que no tengo el **problema principal** en el Ishikawa. Pégalo en **1 línea** y seguimos con la misma categoría.");
              return;
            }

            // ✅ Caso real de inicio (no hay conversación): aquí sí tomamos el primer mensaje como problema.
            const next: IshikawaState = {
              ...ishikawaState,
              problem: { text: text.trim().slice(0, 1200) },
            };
            setIshikawaState(next);
            await saveIshikawaState(next, effectiveChatId);

            // 🔁 En vez de un texto robótico fijo, pedimos 1ra causa de forma corta y natural:
            await appendAssistant(
              "Perfecto — ya registré el problema. 🙌\n\n" +
              "Ahora dime **una causa concreta** (qué pasa / dónde pasa) y la ubico en Hombre/Máquina/Método/etc., y empezamos con los **¿por qué?**."
            );
            return;
          }


          // ✅ Si el usuario solo confirma (OK/Sí) al iniciar Ishikawa, NO lo mandamos al assistant.
          // Esto evita el loop de “No pude ubicar tu respuesta”.
          const tConfirm = normalizeText(text).trim();

          // ✅ Acepta confirmaciones aunque tengan texto extra: "ok, está bien", "sí ok", "listo entonces"
          const isConfirmOnly = /^(ok|okey|okay|si|sí|listo|dale|vamos)\s*[!.?,]*\s*$/.test(tConfirm);

          const hasAnyCauses = (ishikawaState.categories ?? []).some((c) => {
            const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
            return mains.length > 0;
          });

          const tNorm = normalizeText(text);
          const isBareAdvance =
            isConfirmOnly || (wantsAdvanceStage(text) && tNorm.split(" ").length <= 4);

          if (isBareAdvance && !hasAnyCauses) {
            await appendAssistant(
              "✅ **Etapa 4 – Análisis de Causa Raíz (Ishikawa + 5 Porqués)**\n\n" +
              `🎯 **Problema principal:**\n${problemText}\n\n` +
              "Vamos a trabajar como en clase:\n" +
              "👉 **Primer paso:** responde a esta pregunta:\n\n" +
              `❓ **¿Por qué ocurre este problema?**\n\n` +
              "Escribe una causa que tú consideres importante. Puede venir de la lluvia de ideas que ya hicimos.\n\n" +
              "Yo me encargo de ubicarla en la categoría correcta (Hombre, Máquina, Método, etc.) y luego bajamos con más **porqués** hasta llegar a la causa raíz."
            );
            return;
          }

          // Si ya estábamos pidiendo confirmación para pasar a Pareto
          if (ishikawaClosePending && isIshikawaReadyToClose(ishikawaState)) {
            if (wantsAdvanceStage(text)) {
              const v = await validateIshikawa();
              if (!v.ok) {
                const msg = v.payload?.message ?? "No se pudo cerrar Etapa 4.";
                await appendAssistant(`⚠️ ${msg}`);
                return;
              }

              setIshikawaClosePending(false);

              const moved = await applyBackendAdvisorAdvance({
                fromStage: 4,
                payload: v.payload,
                effectiveChatId: advisorChatId,
              });

              if (!moved) {
                await appendAssistant(
                  "✅ Ishikawa validado, pero no pude preparar automáticamente la Etapa 5. Recarga el chat para continuar desde Pareto."
                );
              }

              return;
            }

            if (wantsKeepAdding(text)) {
              setIshikawaClosePending(false);
              // seguimos normal para refinar
            } else {
              await appendAssistant(
                "Ya tenemos una base suficiente del Ishikawa.\n\n" +
                  "Ahora tú decides cómo seguir:\n" +
                  "• podemos revisar o ajustar alguna causa\n" +
                  "• agregar otra subcausa o ir a otra categoría\n" +
                  "• o pasar a Pareto (Etapa 5)\n\n" +
                  "Dime qué prefieres."
              );
              return;
            }
          }

          // 2) Ya hay problema: delegamos al assistant para clasificar + guiar + 5 porqués
          const assistant = await callIshikawaAssistant({
            studentMessage: text,
            chatId: advisorChatId,
            ishikawaState,
            caseContext: ctx.contextJson ?? null,
            stage1Summary: lastReport.ok ? lastReport.payload ?? null : null,
            brainstormState: brainstormState ?? null,
            recentMessages: buildRecentMessagesForIshikawa(6),
          });

          const nextState = assistant.nextState ?? ishikawaState;
          setIshikawaState(nextState);
          await saveIshikawaState(nextState, effectiveChatId);

          await appendAssistant(assistant.assistantMessage);

          // ✅ Solo ofrecemos pasar de etapa si el servidor lo admite en este turno (no justo tras cerrar una rama)
          if (shouldOfferIshikawaStageClose(nextState, assistant.ui)) {
            setIshikawaClosePending(true);
            await appendAssistant(
              "✅ Ya tenemos una base suficiente del Ishikawa. " +
                "Si quieres, podemos **seguir refinando**, **revisar otra causa o categoría**, o **pasar a la Etapa 5 (Pareto)**."
            );
          } else {
            setIshikawaClosePending(false);
          }
          return;
        }

        // ================================
        // ETAPA 3: Lluvia de ideas (en progreso)
        // ================================

        if (activeAdvisorStage === 3 && brainstormState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const readyToClose = isBrainstormReadyToClose(brainstormState);

          // Si ya completó el mínimo y estamos esperando confirmación del estudiante:
          if (brainstormClosePending && readyToClose) {
            if (wantsAdvanceStage(text)) {
              const v = await validateBrainstorm();
              if (!v.ok) {
                const msg = v.payload?.message ?? "No se pudo cerrar Etapa 3.";
                await appendAssistant(`⚠️ ${msg}`);
                return;
              }



              const problemFromBrainstorm = (brainstormState?.problem?.text ?? "").trim();
              const problemFromFoda = (typeof (fodaState as any)?.problem === "string"
                ? ((fodaState as any).problem as string)
                : ((fodaState as any)?.problem?.text ?? "")
              ).trim();

              const problemFromContext = (
                ctx?.contextJson?.problem?.text ??
                ctx?.contextJson?.problem ??
                ""
              ).toString().trim();

              const finalProblem = (problemFromBrainstorm || problemFromFoda || problemFromContext).trim();

              setBrainstormClosePending(false);

              const moved = await applyBackendAdvisorAdvance({
                fromStage: 3,
                payload: v.payload,
                effectiveChatId: advisorChatId,
                initialProblemText: finalProblem || null,
              });

              if (!moved) {
                await appendAssistant(
                  "✅ Etapa 3 validada, pero no pude preparar automáticamente Ishikawa. Recarga el chat para continuar."
                );
              }

              return;
            }

            if (wantsKeepAdding(text)) {
              // El estudiante quiere seguir: quitamos el “pendiente” y dejamos que el flujo normal procese la idea
              setBrainstormClosePending(false);
              // OJO: no hacemos return, para que el código continúe y procese la causa con el assistant
            } else {
              // Si responde algo ambiguo, pedimos confirmación clara
              await appendAssistant("¿Quieres **seguir agregando** causas o **pasamos a Ishikawa (Etapa 4)**?");
              return;
            }
          }

          const assistant = await callBrainstormAssistant({
            studentMessage: text,
            brainstormState,
            caseContext: ctx.contextJson,
            stage1Summary: lastReport.ok ? lastReport.payload : null,
            // Para no inventar otro endpoint, usamos el propio estado FODA si existe (si está validado, igual sirve como resumen)
            fodaSummary: fodaState ?? null,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMessage =
              typeof assistant.payload?.message === "string" && assistant.payload.message.trim().length > 0
                ? assistant.payload.message.trim()
                : null;

            await appendAssistant(
              backendMessage ??
                "⚠️ Tuve un problema momentáneo para interpretar este turno de la Etapa 3. Vuelve a enviarlo y continuamos desde aquí."
            );
            return;
          }

          const nextState = sanitizeBrainstormState(assistant.payload.updates.nextState);

          await appendAssistant(assistant.payload.assistantMessage);

          setBrainstormState(nextState);
          await saveBrainstormState(nextState, effectiveChatId);

          // ✅ Si ya se completó el mínimo, NO cerramos automático: pedimos confirmación natural
          if (isBrainstormReadyToClose(nextState)) {
            setBrainstormClosePending(true);
            await appendAssistant(
              "✅ Ya tenemos suficientes causas.\n\n" +
              "¿Quieres **seguir agregando** más causas o **pasamos a la Etapa 4 (Ishikawa)**?"
            );
            return;
          }
          return;
        }

        // ================================
        // ETAPA 3: Enganche inicial (si no existe estado)
        // ================================
        if (activeAdvisorStage === 3 && ctx.ok && ctx.status === "confirmed" && diagUnlocked && !brainstormState) {
          // Si el usuario escribe "etapa 3" o "lluvia" o "ideas", iniciamos.
          const t = text.toLowerCase();
          const wantsE3 = t.includes("etapa 3") || t.includes("lluvia") || t.includes("ideas") || t.includes("brainstorm");

          if (wantsE3) {
            const resBS = await getBrainstormState();
            const exists = resBS.ok && resBS.payload?.exists;

            if (!exists) {
              const initial: BrainstormState = {
                step: "choose_strategy",
                strategy: null,
                problem: null,
                ideas: [],
                minIdeas: 10,
              };

              setBrainstormState(initial);
              await saveBrainstormState(initial, effectiveChatId);

              await appendAssistant(
                "Perfecto 👍 Iniciamos la **Etapa 3: Lluvia de ideas (causas)**.\n\n" +
                "✅ Primero debes elegir tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
                "👉 Escríbeme: por ejemplo **FO** y dime el motivo en 1–2 líneas.\n\n" +
                "Luego definiremos la **problemática principal** y recién empezaremos con las causas."
              );
              return;
            }

            const existingRaw = resBS.payload?.state ?? null;
            const existing = existingRaw ? sanitizeBrainstormState(existingRaw) : null;

            if (existing) {
              setBrainstormState(existing);

              const n = Array.isArray(existing.ideas) ? existing.ideas.length : 0;
              const step = resolveBrainstormStep(existing);

              if (step === "choose_strategy") {
                await appendAssistant(
                  "📌 Retomemos tu **Etapa 3: Lluvia de ideas**.\n\n" +
                    "Primero debemos elegir la **estrategia obligatoria**: **FO / DO / FA / DA**.\n\n" +
                    "Si quieres, puedo ayudarte a escoger la más conveniente según tu FODA."
                );
                return;
              }

              if (step === "define_problem") {
                await appendAssistant(
                  `📌 Retomemos tu **Etapa 3**.\n\n` +
                    `Estrategia elegida: **${existing.strategy?.type ?? "-"}**.\n\n` +
                    "Ahora falta aterrizar la **problemática principal** que vas a trabajar.\n\n" +
                    "Puedes escribirme tu propuesta y yo te ayudo a formularla mejor."
                );
                return;
              }

              if (step === "review") {
                await appendAssistant(
                  `📌 Retomemos tu **Etapa 3**.\n\n` +
                    `Estrategia: **${existing.strategy?.type ?? "-"}**\n` +
                    `Problema: **${existing.problem?.text ?? "(pendiente)"}**\n` +
                    `Causas registradas: **${n}**.\n\n` +
                    "✅ Ya cumples el mínimo. Puedes agregar más causas o decirme que pasemos a Ishikawa."
                );
                return;
              }

              await appendAssistant(
                `📌 Retomemos tu **Etapa 3**.\n\n` +
                  `Estrategia: **${existing.strategy?.type ?? "-"}**\n` +
                  `Problema: **${existing.problem?.text ?? "(pendiente)"}**\n` +
                  `Causas registradas: **${n}**.\n\n` +
                  "👉 Continúa con otra causa y yo te ayudo a pulirla si hace falta."
              );
              return;
            }
          }
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
          const t = normalizeText(text);
          const wantsNext =
            isReadyIntent(text) ||
            t.includes("que sigue") ||
            t.includes("siguiente") ||
            t.includes("pasamos") ||
            t.includes("continuar");

          if (wantsNext) {
            const v = await validateFoda();
            if (!v?.ok) {
              await appendAssistant(
                v?.payload?.message ??
                  "⚠️ Aún no puedo validar el FODA. Revisa que haya 3 puntos en cada cuadrante y sustento en O/A."
              );
              return;
            }

            const moved = await applyBackendAdvisorAdvance({
              fromStage: 2,
              payload: v.payload,
              effectiveChatId: advisorChatId,
            });

            if (!moved) {
              await appendAssistant(
                "✅ FODA validado, pero no pude preparar automáticamente la Etapa 3. Recarga el chat para continuar."
              );
            }

            return;

          }
        }

        // ETAPA 2: FODA en progreso (con IA)
        if (activeAdvisorStage === 2 && fodaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callFodaAssistant({
            studentMessage: text,
            fodaState,
            caseContext: ctx.contextJson,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMessage =
              typeof assistant.payload?.message === "string" && assistant.payload.message.trim().length > 0
                ? assistant.payload.message.trim()
                : null;

            await appendAssistant(
              backendMessage ??
                "⚠️ Seguimos en esta parte del FODA, pero tuve un problema momentáneo para procesar tu mensaje. Vuelve a enviarlo y continuamos desde aquí."
            );
            return;
          }

          const nextState = assistant.payload.updates.nextState as FodaState;
          const action = assistant.payload.updates?.action as string | undefined;

          // 1) mostrar respuesta “docente”
          await appendAssistant(assistant.payload.assistantMessage);

          // 2) aplicar estado y guardar
          setFodaState(nextState);

          const saveResult = await saveFodaState(nextState, advisorChatId);
          if (!saveResult.ok) {
            await appendAssistant(getFodaSaveErrorMessage(saveResult));
            return;
          }

          // 3) ✅ Si ya está completo (o el LLM lo marca como complete) → VALIDAR y saltar a Etapa 3
          const completed = action === "complete" || isFodaComplete(nextState);

          if (completed) {
            const v = await validateFoda();

          if (!v?.ok) {
            const msg =
              v?.payload?.message ??
              "⚠️ Aún no puedo validar el FODA. Revisa que haya 3 puntos en cada cuadrante y sustento en O/A.";
            await appendAssistant(msg);
            return;
          }

          const moved = await applyBackendAdvisorAdvance({
            fromStage: 2,
            payload: v.payload,
            effectiveChatId: advisorChatId,
          });

          if (!moved) {
            await appendAssistant(
              "✅ FODA validado, pero no pude preparar automáticamente la Etapa 3. Recarga el chat para continuar."
            );
          }

          return;
          }

          return; // importante: ya atendimos FODA
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
          // si el usuario pregunta (no robótico), respondemos y re-preguntamos el paso actual
          if (isProdQuestion(text) && !isReadyIntent(text)) {
            await appendAssistant(
              "Claro 🙂 En esta etapa trabajaremos una **medición básica de productividad mensual**.\n\n" +
                "Necesito una línea, producto o servicio concreto, junto con **ingresos del mes** y **costos del mes**.\n\n" +
                "No te preocupes: iremos paso a paso."
            );

            setActiveAdvisorStage(1);
            setProdStep(1);

            await appendAssistant(promptProd(1, ctx.contextJson, prodDraft));
            return;
          }

          // Si escribe "productividad", iniciar Etapa 1
          if (text.toLowerCase().includes("productividad")) {
            setAwaitingStage1Start(clientId, false);

            const products = Array.isArray(ctx.contextJson?.products)
              ? ctx.contextJson.products.filter(Boolean)
              : [];
            const autoLine = products.length === 1 ? String(products[0]) : undefined;

            setActiveAdvisorStage(1);
            setProdDraft({ line: autoLine, required_costs: 3 });
            setProdStep(1);

            await appendAssistant(
              "Perfecto. Empecemos con la **Etapa 1: Productividad mensual**."
            );
            await appendAssistant(promptProd(1, ctx.contextJson, { line: autoLine }));
            return;
          }

          if (isReadyIntent(text)) {
            setAwaitingStage1Start(clientId, false);

            const products = Array.isArray(ctx.contextJson?.products)
              ? ctx.contextJson.products.filter(Boolean)
              : [];
            const autoLine = products.length === 1 ? String(products[0]) : undefined;

            setActiveAdvisorStage(1);
            setProdDraft({ line: autoLine, required_costs: 3 });
            setProdStep(1);

            await appendAssistant(
              "Excelente. Continuemos con la **Etapa 1: Productividad mensual**."
            );
            await appendAssistant(promptProd(1, ctx.contextJson, { line: autoLine }));
            return;
          }

          // si no confirmó, pedimos confirmación para iniciar productividad
          await appendAssistant(
            "Antes de avanzar necesito tu confirmación para iniciar la **Etapa 1: Productividad mensual**.\n\n" +
              "Cuando quieras, responde **ok**, **listo** o **vamos**."
          );
          return;
        }

        // -----------------------------
        // ETAPA 1: Productividad Wizard (LLM fluido con JSON estructurado)
        // -----------------------------
        if (ctx.ok && ctx.status === "confirmed" && prodStep > 0) {
          // 1) Llamar al orquestador fluido
          const requiredCosts = prodDraft.required_costs === 3 ? 3 : 4;

          const assistant = await callProductivityAssistant({
            studentMessage: text,
            prodStep,
            prodDraft: {
              ...prodDraft,
              required_costs: requiredCosts,
            },
            caseContext: ctx.contextJson,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage) {
            await appendAssistant("⚠️ No pude interpretar bien tu respuesta. ¿Puedes decirlo en una frase corta (con números si aplica)?");
            return;
          }

          const a = assistant.payload;

          // 2) Mostrar mensaje “humano”
          await appendAssistant(a.assistantMessage);

          // 3) Aplicar patch + acumular costos
          const patched = applyAssistantPatchToDraft(prodDraft, a.updates?.patch ?? {});
          const mergedCosts = mergeCosts(patched.costs, a.updates?.addCosts ?? [], requiredCosts);

          const nextDraft: ProductivityDraft = {
            ...patched,
            required_costs: requiredCosts,
            costs: mergedCosts.length ? mergedCosts : patched.costs,
          };

          const nextStepRaw = typeof a.updates?.step === "number" ? a.updates.step : prodStep;
          const nextStep = Math.max(1, Math.min(5, Math.trunc(nextStepRaw))) as ProdStep;

          setProdDraft(nextDraft);
          setProdStep(nextStep);

          // 4) Si el modelo dice “doneWithStage=true”, guardamos y validamos
          if (a.control?.doneWithStage) {
            // Construir payload en el formato que tu /api/plans/productivity espera
            const payload = {
              type: nextDraft.type ?? "monetaria",
              period_key: nextDraft.period_key!,
              line: nextDraft.line,
              income_bs: nextDraft.income_bs,
              costs: nextDraft.costs,
              notes: nextDraft.notes,
            };

            const saved = await saveProductivity(payload, chatIdRef.current);
            if (!saved.ok) {
              await appendAssistant(saved?.data?.message || "⚠️ No pude guardar el reporte.");
              return;
            }



            const validated = await validateProductivity(payload.period_key);
              if (!validated.ok) {
                const issues = validated?.details?.issues;
                const score = validated?.details?.score;

                await appendAssistant(
                  "⚠️ Aún no está listo para validar.\n" +
                    (Array.isArray(issues) ? `\nProblemas:\n- ${issues.join("\n- ")}` : "") +
                    (score
                      ? `\n\nRúbrica:\n- coherencia: ${score.coherence}\n- tipo: ${score.type_choice}\n- claridad: ${score.clarity}\n- total: ${score.total}`
                      : "") +
                    "\n\nCorrige eso y me lo envías de nuevo 🙂"
                );
                return;
              }

              const initial: FodaState = {
                currentQuadrant: "F",
                items: {
                  F: [],
                  D: [],
                  O: [],
                  A: [],
                },
              };

              await clearProductivityState();

              setProdStep(0);
              setProdDraft({});
              setActiveAdvisorStage(2);

              setFodaState(initial);
              await saveFodaState(initial, effectiveChatId);

              await appendAssistant(
                "✅ **Etapa 1 (Productividad) validada**.\n\n" +
                  "Ahora pasamos a la **Etapa 2: Análisis FODA**.\n\n" +
                  "Empezamos con **Fortalezas (internas)**.\n\n" +
                  "Dime una fortaleza real del proceso o área que analizas."
              );

              return;

          }

          return; // importante: ya atendimos el mensaje
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
        createMessage("assistant", "⚠️ Ocurrió un error al procesar tu mensaje."),
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
    // MODO GENERAL: sí "nuevo chat"
    // -----------------------
    if (nextMode === "general") {
      chatIdRef.current = null;
      setChatId(null);
      setMessages([createMessage("assistant", GREETING)]);

      try {
        // Limpia general
        window.sessionStorage.removeItem(`optia-chat-id-${clientId}-general`);
        window.sessionStorage.removeItem(`optia-messages-${clientId}-general`);

        // ✅ CLAVE: si el usuario apretó "+ Nuevo chat" (sin targetMode), también limpia asesor
        if (!targetMode) {
          window.sessionStorage.removeItem(`optia-chat-id-${clientId}-plan_mejora`);
          window.sessionStorage.removeItem(`optia-messages-${clientId}-plan_mejora`);
          setPlanFresh(clientId, true);
          setAwaitingStage1Start(clientId, false);
        }
      } catch {}

      // También resetea wizard local para evitar “arrastres”
      if (!targetMode) {
        setStage0Draft({});
      }

      return;
    }

    // -----------------------
    // MODO ASESOR (plan_mejora): nuevo chat “limpio”
    // -----------------------
    if (nextMode === "plan_mejora") {
      setShowHoursInline(false);
      setIsSending(false);

      // NO reseteamos el progreso (etapas). Solo creamos un chat nuevo.
      setMessages([createMessage("assistant", "⏳ Creando un nuevo chat para continuar tu avance...")]);

      // Limpia cache local del chat actual (solo UI), pero NO toca el estado del caso
      try {
        window.sessionStorage.removeItem(`optia-chat-id-${clientId}-plan_mejora`);
        window.sessionStorage.removeItem(`optia-messages-${clientId}-plan_mejora`);
      } catch {}

      // FODA aún no tiene persistencia backend.
      // Se guarda solo en memoria hasta cierre de etapa.
      try {
        if (saveFodaTimerRef.current) window.clearTimeout(saveFodaTimerRef.current);
      } catch {
        // noop
      }

      try {
        if (saveWizardTimerRef.current) window.clearTimeout(saveWizardTimerRef.current);
        // Guarda Productividad si estuviera en medio (no afecta si ya está validada)
        await saveProductivityState({ prodStep, prodDraft }, chatIdRef.current);
      } catch {
        // no rompemos UX
      }

      try {
        if (brainstormState) await saveBrainstormState(brainstormState, chatIdRef.current);
      } catch {}

      try {
        if (saveIshikawaTimerRef.current) window.clearTimeout(saveIshikawaTimerRef.current);
        if (ishikawaState) await saveIshikawaState(ishikawaState, chatIdRef.current);
      } catch {}

      // Señal para que el effect cree un chat nuevo del asesor (chat-only)
      setPlanFresh(clientId, true);
      setAdvisorRefreshNonce((n) => n + 1);

      // Asegura modo asesor
      if (mode !== "plan_mejora") {
        modeRef.current = "plan_mejora";
        setMode("plan_mejora");
      }

      // IMPORTANTE: no tocamos stage0Step/stage0Draft/prodStep/prodDraft aquí
      chatIdRef.current = null;
      setChatId(null);

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
        createMessage("assistant", "Debes iniciar sesión para subir y revisar un plan de mejora."),
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

      await appendAssistant(a.payload.assistantMessage);

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
            modeRef.current = m;
            chatIdRef.current = id;
            setMode(m);
            setChatId(id);
            setShowHoursInline(false);
            setStage0Draft({});
          }}
          onNewChat={() => handleNewChat()}
          onLogout={handleLogout}
          displayName={displayName}
        />
      }
      sidebarOpen={sidebarOpen}
      onCloseSidebar={() => setSidebarOpen(false)}
    >
      {/* Barra superior interna del chat */}
      <ChatHeader
        theme={theme}
        displayName={displayName}
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
          setMode("plan_mejora");
          void ensureAdvisorChatId();
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
