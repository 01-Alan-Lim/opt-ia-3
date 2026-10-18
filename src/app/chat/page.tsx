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
import { GREETING, useChatHistory, useChatHistoryPersistence } from "./_lib/useChatHistory";
import { Message } from "@/lib/types";
import {
  BrainstormState,
  sanitizeBrainstormState,
} from "@/lib/plan/brainstormFlow";
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
  type Stage0InterpretPayload,
  advisorResumeGreeting,
  askForMissingStage0Field,
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
import {
  createMessage,
  formatAssistantMessageForReadability,
  softenAssistantLeadInChat,
} from "@/lib/chat/assistantFormat";
import { chatIdStorageKey, messagesStorageKey } from "@/lib/chat/chatStorage";
import { readSignedAssistantReply } from "@/lib/chat/signedAssistantReply";


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
      displayName,
    },
  });

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
