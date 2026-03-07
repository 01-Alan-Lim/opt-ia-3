// src/app/chat/page.tsx
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import { HoursInlinePanel } from "@/components/chat/HoursInlinePanel";
import Link from "next/link";
import Image from "next/image";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { Sidebar } from "@/components/chat/Sidebar";
import { MessageList } from "@/components/chat/MessageList";
import { MessageInput } from "@/components/chat/MessageInput";
import { Message } from "@/lib/types";

type ChatMode = "general" | "plan_mejora";

type GateReason =
  | "OK"
  | "NEEDS_ONBOARDING"
  | "PENDING_APPROVAL"
  | "COHORT_INACTIVE"
  | "ACCESS_NOT_STARTED"
  | "ACCESS_EXPIRED";

const GREETING =
  "Hola, soy OPT-IA. Me conecto a Supabase y Google AI para ayudarte con productividad en MyPEs.";

const ADVISOR_GREETING =
  "¡Hola! 👋 Cuando quieras empezar, necesito 3 datos rápidos para armar el Contexto del Caso.\n\n" +
  "Escribe: **empezar** o dime directamente el **sector/rubro** (ej: alimentos, textil, servicios).";


function createMessage(role: Message["role"], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export default function ChatPage() {
  const router = useRouter();

  // -----------------------------
  // Auth (Supabase)
  // -----------------------------
  const [ready, setReady] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionFullName, setSessionFullName] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

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

  // Mantiene el estado de sesión actualizado
  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      setSessionEmail(data.session?.user?.email ?? null);
      setUserId(data.session?.user?.id ?? null);
      setAccessToken(data.session?.access_token ?? null);

      const meta = data.session?.user?.user_metadata as Record<string, unknown> | undefined;
      const full =
        (typeof meta?.full_name === "string" && meta.full_name.trim()) ||
        (typeof meta?.name === "string" && meta.name.trim()) ||
        null;

      setSessionFullName(full);
      setReady(true);
    }

    loadSession();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSessionEmail(newSession?.user?.email ?? null);
      setUserId(newSession?.user?.id ?? null);
      setAccessToken(newSession?.access_token ?? null);

      const meta = (newSession?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const full =
        (typeof meta.full_name === "string" && meta.full_name.trim()) ||
        (typeof meta.name === "string" && meta.name.trim()) ||
        null;

      setSessionFullName(full);
      setReady(true);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const authenticated = useMemo(() => Boolean(userId), [userId]);

  const displayName = useMemo(() => {
    if (sessionFullName) return sessionFullName;

    const email = sessionEmail ?? "";
    const base = email.split("@")[0]?.trim();
    return base || "Usuario";
  }, [sessionFullName, sessionEmail]);

  // -----------------------------
  // Estado de UI / Chat
  // -----------------------------
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
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
  const modeRef = useRef<ChatMode>("general");
  const messagesRef = useRef<Message[]>([]);
  const suppressNextHistoryHydrationRef = useRef(false);

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
  const storageKeyChat = `optia-chat-id-${clientId}-${mode}`;
  const storageKeyMsgs = `optia-messages-${clientId}-${mode}`;

  // -----------------------------
  // Etapa 0 Wizard (plan_mejora)
  // -----------------------------
  type Stage0Step = 0 | 1 | 2 | 3; // 0=idle, 1=sector, 2=producto, 3=proceso (listo para confirmar)
  const [stage0Step, setStage0Step] = useState<Stage0Step>(0);
  const [stage0Draft, setStage0Draft] = useState<{
    sector?: string;
    products?: string[];
    process_focus?: string[];
  }>({});

  type EditTarget = "sector" | "products" | "process_focus" | null;
  const [editingField, setEditingField] = useState<EditTarget>(null);

  // -----------------------------
  // Etapa 1 (Productividad) Wizard
  // -----------------------------
  type ProdStep = 0 | 1 | 2 | 3 | 4 | 5;
  // 0=idle, 1=tipo, 2=periodo, 3=ingreso, 4=costos, 5=confirmacion

  type ProductivityDraft = {
    type?: "monetaria" | "fisica";
    unit_reason?: string;         // por qué eligió monetaria/física
    required_costs?: number;      // 3 o 4 (configurable). Default 4
    period_key?: string;          // YYYY-MM
    line?: string;                // línea/producto
    income_bs?: number;           // ingresos del mes
    costs?: { name: string; amount_bs: number; note?: string }[];
    notes?: string;
  };

  type FodaQuadrant = "F" | "D" | "O" | "A";

  type FodaState = {
    currentQuadrant: FodaQuadrant;
    pendingEvidence?: { quadrant: "O" | "A"; index: number } | null;
    items: {
      F: { text: string }[];
      D: { text: string }[];
      O: { text: string; evidence?: string }[];
      A: { text: string; evidence?: string }[];
    };
  };

  type BrainstormIdea = { text: string };

  type BrainstormState = {
    strategy: { type: "FO" | "DO" | "FA" | "DA"; rationale?: string } | null;
    problem: { text: string } | null;
    ideas: BrainstormIdea[];
    minIdeas: number;
  };

  //-----------
  function sanitizeBrainstormState(raw: any): BrainstormState {
    const strategyType = raw?.strategy?.type;
    const strategyOk =
      strategyType === "FO" || strategyType === "DO" || strategyType === "FA" || strategyType === "DA";

    const problemText =
      typeof raw?.problem === "string"
        ? raw.problem
        : (typeof raw?.problem?.text === "string" ? raw.problem.text : "");

    const ideas: BrainstormIdea[] = Array.isArray(raw?.ideas)
      ? raw.ideas
          .map((x: any) => ({ text: typeof x?.text === "string" ? x.text : String(x ?? "").trim() }))
          .filter((x: BrainstormIdea) => x.text.trim().length > 0)
      : [];

    const minIdeas = typeof raw?.minIdeas === "number" ? raw.minIdeas : 10;

    return {
      strategy: strategyOk
        ? { type: strategyType, rationale: typeof raw?.strategy?.rationale === "string" ? raw.strategy.rationale : undefined }
        : null,
      problem: problemText.trim() ? { text: problemText.trim().slice(0, 240) } : null,
      ideas,
      minIdeas,
    };
  }
  //-----------

  type IshikawaSubCause = {
    id: string;
    text: string;
    whys?: string[];
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
    maxWhyDepth: number;                // 3-5 (prefer 3)
    minRootCandidates: number;
    cursor?: { categoryId?: string; mainCauseId?: string } | null;
    rootCauses?: string[];
  };

  type ParetoCriterion = { id: string; name: string; weight?: number };

  type ParetoState = {
    roots: string[];              // viene de ishikawa_final.validate
    selectedRoots: string[];      // 10-15 (para trabajar en Excel)
    criteria: ParetoCriterion[];  // exactamente 3
    criticalRoots: string[];      // top 20% (el estudiante vuelve del Excel y lo pega)
    minSelected: number;          // 10
    maxSelected: number;          // 15
    step:
      | "select_roots"
      | "define_criteria"
      | "set_weights"
      | "excel_work"
      | "collect_critical"
      | "done";
  };

  type ObjectivesState = {
    generalObjective: string;
    specificObjectives: string[];
    linkedCriticalRoots: string[];
    step: "general" | "specific" | "review";
  };

  type ImprovementInitiative = {
    id: string;
    title: string;
    description: string;
    linkedRoot: string | null;       // causa crítica (Pareto) o raíz (Ishikawa)
    linkedObjective: string | null;  // objetivo específico (Etapa 6)
    measurement: {
      indicator: string | null;      // puede ser cualitativo
      kpi: string | null;            // opcional
      target: string | null;         // opcional
    };
    feasibility: {
      estimatedWeeks: number | null;
      notes: string | null;
    };
  };

  type ImprovementState = {
    stageIntroDone: boolean;
    step: "discover" | "build" | "refine" | "review";
    focus: {
      chosenRoot: string | null;
      chosenObjective: string | null;
    };
    initiatives: ImprovementInitiative[];
    lastSummary: string | null;
  };

  function isImprovementReadyForValidation(st: ImprovementState) {
    const initiatives = Array.isArray(st.initiatives) ? st.initiatives : [];
    if (initiatives.length < 2) return false;

    const allHaveObjective = initiatives.every((i) => Boolean((i.linkedObjective ?? "").trim()));
    if (!allHaveObjective) return false;

    const allHaveMeasurement = initiatives.every((i) => {
      const indicator = (i.measurement?.indicator ?? "").trim();
      const kpi = (i.measurement?.kpi ?? "").trim();
      return Boolean(indicator || kpi);
    });
    if (!allHaveMeasurement) return false;

    return true;
  }

  // ================================
  // ETAPA 8: Planificación (types + gate helper)
  // ================================
  type PlanningMilestone = {
    id: string;
    title: string;
    week: number | null; // 1..N
    deliverable: string | null;
  };

  type PlanningWeekItem = {
    week: number;
    focus: string;
    tasks: string[];
    evidence: string | null;
    measurement: string | null;
  };

  type PlanningState = {
    stageIntroDone: boolean;
    step: "time_window" | "breakdown" | "schedule" | "review";
    time: {
      studentWeeks: number | null;
      courseCutoffDate: string | null; // opcional si el contexto lo trae
      effectiveWeeks: number | null;   // opcional
      notes: string | null;
    };
    plan: {
      weekly: PlanningWeekItem[];
      milestones: PlanningMilestone[];
      risks: string[];
    };
    lastSummary: string | null;
  };

  function isPlanningReadyForValidation(st: PlanningState) {
    const studentWeeksOk =
      typeof st?.time?.studentWeeks === "number" && Number.isFinite(st.time.studentWeeks) && st.time.studentWeeks > 0;

    const cutoffOk = typeof st?.time?.courseCutoffDate === "string" && st.time.courseCutoffDate.trim().length > 0;

    // Basta con semanas o con fecha de corte (si el estudiante no sabe semanas)
    if (!studentWeeksOk && !cutoffOk) return false;

    const weekly = Array.isArray(st?.plan?.weekly) ? st.plan.weekly : [];
    const milestones = Array.isArray(st?.plan?.milestones) ? st.plan.milestones : [];

    if (weekly.length < 1) return false;
    if (milestones.length < 2) return false;

    const hasMeasurement = weekly.some((w) => Boolean((w?.measurement ?? "").toString().trim()));
    if (!hasMeasurement) return false;

    return true;
  }

  // ================================
  // ETAPA 9: Reporte de avances
  // ================================
  type ProgressState = {
    step: "intro" | "report" | "clarify" | "review";
    reportText: string | null;
    progressPercent: number | null; // 0–100
    measurementNote: string | null; // solo textual
    summary: string | null;
    updatedAtLocal: string | null;
  };

  function isProgressReadyForValidation(st: ProgressState) {
    if (!st) return false;

    const textOk =
      typeof st.reportText === "string" &&
      st.reportText.trim().length >= 20;

    const pctOk =
      typeof st.progressPercent === "number" &&
      Number.isFinite(st.progressPercent) &&
      st.progressPercent >= 0 &&
      st.progressPercent <= 100;

    return textOk && pctOk;
  }

  // ================================
  // ETAPA 10: Documento final (Word/PDF) - 2 versiones máximo
  // ================================
  type FinalDocState = {
    // Nota: "review" coincide con lo que devuelve /api/plans/final_doc/assistant
    step: "await_upload" | "review" | "needs_v2" | "finalized";
    versionNumber: 1 | 2;
    lastFeedback: string | null;

    upload: {
      fileName: string | null;
      storagePath: string | null;
      extractedText: string | null;
      uploadedAt: string | null;
    };

    // Campo esperado por /api/plans/final_doc/validate (no es obligatorio en UI, pero se guarda)
    extractedSections?: {
      resumen_ejecutivo?: string | null;
      diagnostico?: string | null;
      objetivos?: string | null;
      propuesta_mejora?: string | null;
      plan_implementacion?: string | null;
      conclusiones?: string | null;
    } | null;

    // Campo esperado por /api/plans/final_doc/validate (sale desde la IA)
    evaluation?: {
      total_score?: number;
      total_label?: "Deficiente" | "Regular" | "Adecuado" | "Bien";
      detail?: Record<string, unknown>;
      signals?: Record<string, unknown>;
      mejoras?: string[];
      needs_resubmission?: boolean;
    } | null;
  };

  function isFinalDocReadyForUpload(st: FinalDocState | null) {
    if (!st) return false;
    return st.step === "await_upload" || st.step === "needs_v2";
  }

  function isFodaComplete(st: FodaState) {
    const quadrants: Array<keyof FodaState["items"]> = ["F", "D", "O", "A"];
    const okCounts = quadrants.every((q) => Array.isArray(st.items?.[q]) && st.items[q].length >= 3);
    const noPending = !st.pendingEvidence;
    return okCounts && noPending;
  }

  function isBrainstormReadyToClose(st: BrainstormState | null) {
    if (!st) return false;

    const problemText =
      typeof (st as any).problem === "string"
        ? (st as any).problem
        : (typeof (st as any).problem?.text === "string" ? (st as any).problem.text : "");

    const hasProblem = problemText.trim().length >= 10;

    const ideasCount = Array.isArray(st.ideas) ? st.ideas.length : 0;
    const min = typeof st.minIdeas === "number" ? st.minIdeas : 10;

    return hasProblem && ideasCount >= min;
  }

  function isObjectivesReadyForValidation(st: {
    generalObjective: string;
    specificObjectives: string[];
    linkedCriticalRoots: string[];
  }) {
    const generalOk = (st.generalObjective ?? "").trim().length >= 15;

    const specificOk =
      Array.isArray(st.specificObjectives) &&
      st.specificObjectives.filter((s) => (s ?? "").trim().length > 0).length >= 3;

    const linkedOk =
      Array.isArray(st.linkedCriticalRoots) &&
      st.linkedCriticalRoots.filter((r) => (r ?? "").trim().length > 0).length >= 1;

    return generalOk && specificOk && linkedOk;
  }

  function countRootCandidatesFromIshikawa(st: IshikawaState | null) {
    if (!st) return 0;

    const isPlaceholder = (x: any) => {
      const t = (x ?? "").toString().trim().toLowerCase();
      return !t || t === "causa" || t === "subcausa";
    };

    const normalizeWhys = (sc: any) => {
      const whys = Array.isArray(sc?.whys) ? sc.whys : [];
      return whys
        .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
        .map((t: any) => (t ?? "").toString().trim())
        .filter(Boolean);
    };

    const cats = Array.isArray(st.categories) ? st.categories : [];
    const roots: string[] = [];

    for (const c of cats) {
      const mains = Array.isArray((c as any)?.mainCauses) ? (c as any).mainCauses : [];
      for (const m of mains) {
        const subs = Array.isArray((m as any)?.subCauses) ? (m as any).subCauses : [];
        for (const s of subs) {
          const whys = normalizeWhys(s);

          // raíz = último porqué si existe
          if (whys.length > 0) {
            const last = whys[whys.length - 1];
            if (last && !isPlaceholder(last)) roots.push(last);
            continue;
          }

          // fallback: subcausa si tiene texto útil
          const t = ((s as any)?.text ?? (s as any)?.name ?? "").toString().trim();
          if (t && !isPlaceholder(t)) roots.push(t);
        }
      }
    }

    return new Set(roots).size;
  }

  function isIshikawaReadyToClose(st: IshikawaState | null) {
    if (!st) return false;

    const problemText =
      typeof st.problem === "string"
        ? st.problem
        : (typeof (st.problem as any)?.text === "string" ? (st.problem as any).text : "");

    if (!problemText.trim()) return false;

    const cats = Array.isArray(st.categories) ? st.categories : [];
    const minCats = typeof st.minCategories === "number" ? st.minCategories : 4;
    const minMain = typeof st.minMainCausesPerCategory === "number" ? st.minMainCausesPerCategory : 3;

    // ✅ Para cierre (pasar a Pareto), consideramos suficiente 1 subcausa válida por causa principal,
    // porque la profundidad real está en whys[].
    const minSubForClose = 1;

    const isPlaceholder = (x: any) => {
      const t = (x ?? "").toString().trim().toLowerCase();
      return !t || t === "causa" || t === "subcausa";
    };

    const normalizeWhys = (sc: any) => {
      const whys = Array.isArray(sc?.whys) ? sc.whys : [];
      return whys
        .map((w: any) => (typeof w === "string" ? w : (w?.text ?? "")))
        .map((t: any) => (t ?? "").toString().trim())
        .filter(Boolean);
    };

    const isSubValid = (sc: any) => {
      const n = ((sc as any)?.name ?? (sc as any)?.text ?? "").toString().trim();
      if (n && !isPlaceholder(n)) return true;
      return normalizeWhys(sc).length > 0;
    };

    const isMainComplete = (mc: any) => {
      const name = ((mc as any)?.name ?? (mc as any)?.text ?? "").toString().trim();
      if (!name || isPlaceholder(name)) return false;

      const subs = Array.isArray((mc as any)?.subCauses) ? (mc as any).subCauses : [];
      const validSubs = subs.filter(isSubValid);
      return validSubs.length >= minSubForClose;
    };

    const mainCompleteCount = (cat: any) => {
      const mains = Array.isArray((cat as any)?.mainCauses) ? (cat as any).mainCauses : [];
      return mains.filter(isMainComplete).length;
    };

    // ✅ Categoría completa = tiene ≥ minMain causas principales completas
    const completeCats = cats.filter((c: any) => mainCompleteCount(c) >= minMain);

    // ✅ NO exigimos todas las categorías: exigimos al menos minCats categorías completas
    if (completeCats.length < minCats) return false;

    const minRoots =
      typeof (st as any).minRootCandidates === "number"
        ? (st as any).minRootCandidates
        : Math.max(1, minCats * minMain);

    return countRootCandidatesFromIshikawa(st) >= minRoots;

  }

  function isProgressQuestion(text: string) {
    const raw = (text ?? "").trim();
    const t = normalizeText(raw);

    if (!t) return false;

    // 1) Señales fuertes: casi imposible que sea otra cosa
    const strongSignals =
      t.includes("en que etapa estoy") ||
      t.includes("en qué etapa estoy") ||
      t.includes("que etapa sigue") ||
      t.includes("qué etapa sigue") ||
      t.includes("cuantas faltan") ||
      t.includes("cuántas faltan") ||
      t.includes("que etapas ya hice") ||
      t.includes("qué etapas ya hice") ||
      t.includes("pasar a la siguiente etapa") ||
      t.includes("pasar a la otra etapa") ||
      t.includes("podemos pasar a la siguiente") ||
      t.includes("puedo pasar a la siguiente") ||
      t.includes("puedo avanzar de etapa") ||
      t.includes("avanzar de etapa");

    if (strongSignals) return true;

    // 2) Señal media: "qué falta / culminar" SOLO si es claramente pregunta
    const looksLikeQuestion =
      raw.includes("?") ||
      t.startsWith("que ") ||
      t.startsWith("qué ") ||
      t.startsWith("como ") ||
      t.startsWith("cómo ") ||
      t.startsWith("está bien") ||
      t.startsWith("esta bien") ||
      t.startsWith("podemos ") ||
      t.startsWith("puedo ");

    const mediumSignals =
      t.includes("que falta para") ||
      t.includes("qué falta para") ||
      t.includes("falta para cerrar") ||
      t.includes("culminar esta etapa") ||
      t.includes("terminar esta etapa");

    // Evitar falsos positivos típicos dentro de Ishikawa (causas)
    const falsePositives =
      t.includes("falta manual") ||
      t.includes("falta de manual") ||
      t.includes("falta de recursos") ||
      t.includes("falta de apoyo") ||
      t.includes("falta de capacitacion") ||
      t.includes("falta de capacitación") ||
      t.includes("falta de estandar") ||
      t.includes("falta de estándar");

    if (falsePositives) return false;

    return looksLikeQuestion && mediumSignals;
  }


  const [fodaState, setFodaState] = useState<FodaState | null>(null);
  const [brainstormState, setBrainstormState] = useState<BrainstormState | null>(null);
  const [brainstormClosePending, setBrainstormClosePending] = useState(false);

  const [prodStep, setProdStep] = useState<ProdStep>(0);
  const [prodDraft, setProdDraft] = useState<ProductivityDraft>({});

  const [planContextJson, setPlanContextJson] = useState<Record<string, unknown>>({});

  // Fuerza re-evaluación del effect del asesor cuando el usuario presiona "Nuevo chat"
  const [advisorRefreshNonce, setAdvisorRefreshNonce] = useState(0);

  // Gate final (solo /api/me)
  const [gateChecked, setGateChecked] = useState(false);
  const [gateReason, setGateReason] = useState<GateReason | null>(null);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [canInteract, setCanInteract] = useState(true); // false => solo lectura

  const [ishikawaState, setIshikawaState] = useState<IshikawaState | null>(null);
  const saveIshikawaTimerRef = useRef<number | null>(null);

  const [ishikawaClosePending, setIshikawaClosePending] = useState(false);

  const [paretoState, setParetoState] = useState<ParetoState | null>(null);
  const saveParetoTimerRef = useRef<number | null>(null);

  const [objectivesState, setObjectivesState] = useState<ObjectivesState | null>(null);
  const saveObjectivesTimerRef = useRef<number | null>(null);

  const [improvementState, setImprovementState] = useState<ImprovementState | null>(null);
  const saveImprovementTimerRef = useRef<number | null>(null);

  const [planningState, setPlanningState] = useState<PlanningState | null>(null);
  const savePlanningTimerRef = useRef<number | null>(null);

  const [progressState, setProgressState] = useState<ProgressState | null>(null);
  const [finalDocState, setFinalDocState] = useState<FinalDocState | null>(null);

  const saveProgressTimerRef = useRef<number | null>(null);


  const [ishikawaProblemPending, setIshikawaProblemPending] = useState(false);

  const saveBrainstormTimerRef = useRef<number | null>(null);
  const brainstormValidatedRef = useRef(false);

  // -----------------------------
  // Redirect si no está autenticado
  // -----------------------------
  useEffect(() => {
    if (ready && !authenticated) {
      router.replace("/");
    }
  }, [ready, authenticated, router]);

  // -----------------------------
  // Gate final del chat (FUENTE DE VERDAD: /api/me)
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;

    let active = true;

    (async () => {
      try {
        setGateChecked(false);

        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
          if (!active) return;
          setGateChecked(true);
          return;
        }

        const res = await fetch("/api/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        const json = await res.json().catch(() => null);
        const isOk = res.ok && json?.ok !== false;
        const payload = isOk ? (json?.data ?? json) : null;

        if (!active) return;

        // defaults
        setAccessDenied(false);
        setCanInteract(true);
        setGateMessage(null);

        // Si /api/me falla, manejamos 401/403 explícitamente
        if (!payload) {
          // 401: token inválido / sesión muerta => cerrar sesión y volver al home
          if (res.status === 401) {
            await supabase.auth.signOut();
            setGateChecked(true);
            router.replace("/");
            return;
          }

          // 403: correo no autorizado
          if (res.status === 403) {
            await supabase.auth.signOut(); // 🔥 importante: evita que "recuerde" la sesión
            setAccessDenied(true);
            setCanInteract(false);
            setGateMessage(
              "Acceso restringido. Debes iniciar sesión con un correo institucional autorizado."
            );
            setGateChecked(true);
            router.replace("/?reason=forbidden");
            return;
          }

          // Otros fallos: no bloqueamos, pero marcamos gate como chequeado
          setGateChecked(true);
          return;
        }

        // ✅ /api/me => { user, profile, gates }
        const role = (payload?.user?.role ?? "student") as "student" | "teacher";
        if (role === "teacher") {
          setGateChecked(true);
          router.replace("/docente");
          return;
        }

        const reason = (payload?.gates?.reason ?? null) as GateReason | null;
        setGateReason(reason);

        if (!reason) {
          setGateChecked(true);
          return;
        }

        if (reason === "NEEDS_ONBOARDING") {
          setGateChecked(true);
          router.replace("/onboarding");
          return;
        }

        if (reason === "PENDING_APPROVAL") {
          setCanInteract(false);
          setGateMessage(
            "Tu registro fue enviado y está pendiente de aprobación del docente."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "COHORT_INACTIVE") {
          setCanInteract(false);
          setGateMessage(
            "Tu cohorte está inactiva. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "ACCESS_NOT_STARTED") {
          setCanInteract(false);
          setGateMessage(
            "Tu acceso aún no ha iniciado. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        if (reason === "ACCESS_EXPIRED") {
          setCanInteract(false);
          setGateMessage(
            "Tu acceso al asistente ha finalizado. Puedes ver tu historial, pero no enviar mensajes."
          );
          setGateChecked(true);
          return;
        }

        setGateChecked(true);
      } catch (e) {
        if (!active) return;
        console.error("Chat gate (/api/me) failed:", e);
        setGateChecked(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, authenticated, router]);

  // -----------------------------
  // 2a. Cargar desde sessionStorage
  // -----------------------------
  useEffect(() => {
    if (!ready || !authenticated) return;

    try {
      const storedChatId = window.sessionStorage.getItem(storageKeyChat);
      const storedMsgs = window.sessionStorage.getItem(storageKeyMsgs);

      setChatId(storedChatId || null);

      if (storedMsgs) {
        const parsed = JSON.parse(storedMsgs);

        // ✅ Si estaba guardado "[]", lo tratamos como vacío real (mostrar saludo)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
        } else {
          if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
          else setMessages([]);
        }
      } else {
        if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
        else setMessages([]);
      }
    } catch (e) {
      console.warn("No se pudo leer storage:", e);
      if (mode === "general") setMessages([createMessage("assistant", GREETING)]);
      else setMessages([]); // ✅ Asesor en blanco
    }



  }, [ready, authenticated, storageKeyChat, storageKeyMsgs, mode]);

  // -----------------------------
  // 2b. Cargar historial del backend (si hay chatId)
  // -----------------------------
  useEffect(() => {
    if (!ready) return;

    // ✅ Si acabamos de crear chatId y ya pintamos respuesta en UI, no hidratar (solo una vez)
    if (suppressNextHistoryHydrationRef.current) {
      suppressNextHistoryHydrationRef.current = false;
      return;
    }

    if (!authenticated) {
      setChatId(null);
      setMessages(modeRef.current === "general"
        ? [createMessage("assistant", GREETING)]
        : []
      );
      return;
    }

    if (!chatId) return;

    async function loadMessages() {
      setIsLoadingHistory(true);
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`/api/messages?chatId=${chatId}`, {
          headers: { ...authHeaders },
        });

        if (res.status === 401) {
          await supabase.auth.signOut();
          router.replace("/");
          return;
        }

        const data = await res.json();

        if (res.ok && data?.ok !== false) {
          const msgs = data?.data?.messages ?? data?.messages;
          if (Array.isArray(msgs) && msgs.length > 0) {
            setMessages(
              (Array.isArray(msgs) ? msgs : []).map((m: any) => ({
                ...m,
                content: typeof m?.content === "string" ? m.content : String(m?.content ?? ""),
              }))
            );
          }
        }

      } catch (err) {
        console.error("Error al cargar mensajes:", err);
      } finally {
        setIsLoadingHistory(false);
      }
    }

    loadMessages();
  }, [ready, authenticated, chatId]);

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

      setPlanContextJson(ctx.contextJson ?? {});

      const fresh = getPlanFresh(clientId);

      // ✅ Si es "fresh", creamos un chat NUEVO del asesor (chat-only)
      if (fresh) {
        // Creamos chat nuevo SOLO para conversación
        const created = await createAdvisorChatOnly();
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

              setStage0Step(0);
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

            setStage0Step(0);
            setStage0Draft({});
            return;
          }
        }

        // Si está draft, iniciamos wizard en el step correcto (sin guardar nada todavía)
        const next = getNextStage0StepFromContext(ctx.contextJson);
        setStage0Step(next === 0 ? 1 : (next as any));

        setStage0Draft({
          sector: typeof ctx.contextJson?.sector === "string" ? ctx.contextJson.sector : undefined,
          products: Array.isArray(ctx.contextJson?.products) ? ctx.contextJson.products : undefined,
          process_focus: Array.isArray(ctx.contextJson?.process_focus) ? ctx.contextJson.process_focus : undefined,
        });

        const stepToAsk = (next === 0 ? 1 : next) as 1 | 2 | 3;

        const intro =
          stepToAsk === 1
            ? ADVISOR_GREETING
            : "👌 Continuemos desde donde quedamos para completar el Contexto del Caso.";

        const step = ((next === 0 ? 1 : next) as 1 | 2 | 3);
        const greet = advisorResumeGreeting(ctx.contextJson, step);

        setMessages([
          createMessage("assistant", greet),
          createMessage("assistant", promptForStep(step)),
        ]);

        return;
      }

      // ✅ Si NO es fresh: sincronizamos el chatId con DB solo si no hay chatId local aún
      if (!chatId && ctx.chatId) {
        setChatId(ctx.chatId);
        try {
          window.sessionStorage.setItem(storageKeyChat, ctx.chatId);
        } catch {}
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

        setStage0Step(0);
        setStage0Draft({});
        return;
      }

      // ✅ DRAFT: reanudar wizard en el step correcto
      const nextStep = getNextStage0StepFromContext(ctx.contextJson);
      const step = (nextStep === 0 ? 1 : nextStep) as 1 | 2 | 3;

      setStage0Step(step as any);
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

      // res.payload = { ok, exists, state }
      if (res.payload?.exists && res.payload?.state) {
        setFodaState(res.payload.state);
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

  // 2.x Cargar estado Ishikawa (Etapa 4)
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;

    let active = true;

    (async () => {
      const res = await getIshikawaState();
      if (!active) return;
      if (!res.ok) return;

      if (res.payload?.exists && res.payload?.state) {
        const st = res.payload.state as IshikawaState;
        setIshikawaState(st);

        // ✅ si el estado ya está listo, mantenemos el “pending”
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




  // 2.x Cargar estado Improvement (Etapa 7)
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (mode !== "plan_mejora") return;
    if (!chatId) return;

    let active = true;

    (async () => {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/plans/improvement/state?chatId=${encodeURIComponent(chatId)}`, {
        headers: { ...authHeaders },
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      if (!active) return;
      if (!ok) return;

      const row = json?.data?.row ?? json?.row ?? null;
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
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/plans/planning/state?chatId=${encodeURIComponent(chatId)}`, {
        headers: { ...authHeaders },
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      if (!active) return;
      if (!ok) return;

      const row = json?.data?.row ?? json?.row ?? null;
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
      const authHeaders = await getAuthHeaders();
      const res = await fetch(
        `/api/plans/progress/state?chatId=${encodeURIComponent(chatId)}`,
        { headers: { ...authHeaders } }
      );

      const json = await res.json().catch(() => null);
      if (!active) return;
      if (!res.ok || json?.ok === false) return;

      const row = json?.data?.row ?? null;
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

  const restoredWizardRef = useRef<string | null>(null);

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

      setPlanContextJson(ctx.contextJson ?? {});

      // Solo tiene sentido si Etapa 0 está confirmada
      if (ctx.status !== "confirmed") return;

      const st = await getProductivityState();
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

  const saveWizardTimerRef = useRef<number | null>(null);
  const saveFodaTimerRef = useRef<number | null>(null);

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

    // debounce
    if (saveFodaTimerRef.current) {
      window.clearTimeout(saveFodaTimerRef.current);
    }

    saveFodaTimerRef.current = window.setTimeout(() => {
      saveFodaState(fodaState).catch(() => {
        // silencioso: no rompemos UX
      });
    }, 400);

    return () => {
      if (saveFodaTimerRef.current) {
        window.clearTimeout(saveFodaTimerRef.current);
      }
    };
  }, [ready, authenticated, mode, fodaState]);

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
  // 2c. Guardar en sessionStorage
  // -----------------------------
  useEffect(() => {
    if (!authenticated) return;

    try {
      if (chatId) window.sessionStorage.setItem(storageKeyChat, chatId);
      else window.sessionStorage.removeItem(storageKeyChat);
        if (messages.length) window.sessionStorage.setItem(storageKeyMsgs, JSON.stringify(messages));
        else window.sessionStorage.removeItem(storageKeyMsgs);
      } catch (e) {
        console.warn("No se pudo guardar en storage:", e);
      }
    }, [authenticated, chatId, messages, storageKeyChat, storageKeyMsgs]);

  // -----------------------------
  // Loading state
  // -----------------------------
  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[color:var(--background)] text-[color:var(--foreground)]">
        <p className="text-sm text-slate-300">Cargando autenticación...</p>
      </main>
    );
  }

  if (!authenticated) {
    return null;
  }

  if (!gateChecked) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[color:var(--background)] text-[color:var(--foreground)]">
        <p className="text-sm text-slate-300">Verificando acceso...</p>
      </main>
    );
  }

  if (accessDenied) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[color:var(--background)] text-[color:var(--foreground)]">
        <div className="max-w-md w-full mx-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h1 className="text-lg font-semibold mb-2">Acceso restringido</h1>
          <p className="text-sm text-slate-300 mb-4">
            {gateMessage ??
              "Debes iniciar sesión con un correo institucional autorizado para usar OPT-IA."}
          </p>
          <button
            className="w-full rounded bg-slate-800 px-3 py-2 hover:bg-slate-700 text-sm"
            onClick={() => router.replace("/")}
          >
            Volver al inicio
          </button>
        </div>
      </main>
    );
  }

  // -----------------------------
  // Helpers puros (texto / parse)
  // -----------------------------

  function normalizeText(s: string) {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // quita acentos
      .replace(/[^\p{L}\p{N}\s]/gu, " ") // quita signos
      .replace(/\s+/g, " ")
      .trim();
  }

  function wantsAdvanceStage(input: string) {
    const t = normalizeText(input);

    // confirmaciones típicas (texto corto)
    if (["si", "sí", "ok", "okay", "dale", "listo", "vamos", "de acuerdo"].includes(t)) return true;

    // frases comunes de avanzar
    if (t.includes("pasemos") || t.includes("avancemos") || t.includes("continuemos") || t.includes("sigamos")) return true;

    // intención explícita: pasar / avanzar a etapa 5 / pareto
    if (
      t.includes("pasar a") ||
      t.includes("pasemos a") ||
      t.includes("ir a") ||
      t.includes("vamos a")
    ) {
      if (
        t.includes("etapa 5") ||
        t.includes("etapa cinco") ||
        t.includes("quinta etapa") ||
        t.includes("fase 5") ||
        t.includes("pareto") ||
        t.includes("5ta") ||
        t.includes("5a")
      ) {
        return true;
      }
    }

    // menciona etapa 4 o etapa 5 explícitamente
    if (t.includes("etapa 4") || t.includes("etapa cuatro") || t.includes("fase 4")) return true;
    if (t.includes("etapa 5") || t.includes("etapa cinco") || t.includes("fase 5") || t.includes("pareto")) return true;

    return false;
  }

  function wantsKeepAdding(text: string) {
    const t = normalizeText(text).trim();

    // Si el usuario escribe una causa larga, eso cuenta como "seguir agregando"
    if (looksLikeNewCause(text)) return true;

    return (
      t.includes("seguir") ||
      t.includes("mas") ||            // más
      t.includes("otra") ||
      t.includes("agregar") ||
      t.includes("anadir") ||         // añadir (sin tilde)
      t.includes("añadir") ||
      t.includes("aun") ||            // aún
      t.includes("todavia") ||
      t.includes("todavía")
    );
  }

  function looksLikeNewCause(text: string) {
    const t = (text || "").trim();

    // Si es pregunta, normalmente es meta (no es una nueva causa)
    if (t.endsWith("?")) return false;

    // Muy corto suele ser confirmación ("ok", "sí", etc.)
    if (t.length < 18) return false;

    // Si es una frase relativamente larga, sin signos de pregunta, puede ser causa
    const words = t.split(/\s+/).filter(Boolean);
    return words.length >= 6;
  }

  // ✅ SOLO UNA VEZ (y usa hasHorasPhrase)
  function isHoursIntent(text: string) {
    const t = normalizeText(text);

    const hasHora = t.includes("hora");

    const hasReg =
      t.includes("registr") ||
      t.includes("cargar") ||
      t.includes("llenar") ||
      t.includes("subir") ||
      t.includes("anotar");

    const hasHorasPhrase =
      t.includes("mis horas") ||
      t.includes("registro de horas") ||
      t.includes("reporte de horas");

    return (hasHora && hasReg) || hasHorasPhrase;
  }

  // -----------------------------
  // Helpers FODA
  // -----------------------------
  function quadrantLabel(q: FodaQuadrant) {
    return q === "F" ? "Fortalezas"
      : q === "D" ? "Debilidades"
      : q === "O" ? "Oportunidades"
      : "Amenazas";
  }

  function isFodaQuestion(text: string) {
    const t = normalizeText(text);
    return (
      t.endsWith("?") ||
      t.includes("no se") ||
      t.includes("no estoy seguro") ||
      t.includes("ejemplo") ||
      t.includes("como") ||
      t.includes("que significa")
    );
  }

  function looksGenericFoda(text: string) {
    const t = normalizeText(text);
    const generic = [
      "hay mercado",
      "buena ubicacion",
      "personal capacitado",
      "alta demanda",
      "competencia",
      "problemas economicos",
      "crisis",
      "inflacion",
    ];
    return generic.some((g) => t.includes(g));
  }

  function needsEvidence(q: FodaQuadrant) {
    // Externo exige sustento
    return q === "O" || q === "A";
  }

  // -----------------------------
  // Etapa 0 (Contexto del caso) helpers
  // -----------------------------

  type Stage0Intent = "GREETING" | "QUESTION" | "START" | "CONFIRM" | "EDIT" | "ANSWER";

  function isGreetingOrSmallTalk(text: string) {
    const t = normalizeText(text).trim();

    const greetings = [
      "hola",
      "holaa",
      "buenas",
      "buenos dias",
      "buen dia",
      "buenas tardes",
      "buenas noches",
      "hey",
      "que tal",
      "como estas",
      "como esta",
      "saludos",
    ];

    // coincidencia exacta o que sea MUY corto tipo "hola!"
    if (greetings.includes(t)) return true;

    const startsWithGreeting =
      t.startsWith("hola") ||
      t.startsWith("buenas") ||
      t.startsWith("buenos dias") ||
      t.startsWith("buen dia") ||
      t.startsWith("buenas tardes") ||
      t.startsWith("buenas noches") ||
      t.startsWith("hey") ||
      t.startsWith("saludos");

    if (startsWithGreeting && t.length <= 25) return true;

    return false;
  }

  function isOnlyGreeting(text: string) {
    const t = normalizeText(text).trim();
    // solo saludo / small talk MUY corto (no pregunta real)
    if (!t) return false;

    const greetings = [
      "hola",
      "holaa",
      "hi",
      "hello",
      "buenas",
      "buenos dias",
      "buen dia",
      "buenas tardes",
      "buenas noches",
      "hey",
      "que tal",
      "como estas",
      "como esta",
      "saludos",
      "ola",
    ];

    if (greetings.includes(t)) return true;
    if (t.length <= 10 && (t.startsWith("hola") || t.startsWith("hey") || t.startsWith("hi"))) {
      return true;
    }

    return false;
  }

  function detectStage0Intent(text: string): Stage0Intent {
    const t = normalizeText(text).trim();
    if (!t) return "ANSWER";

    // saludo corto
    if (isGreetingOrSmallTalk(text)) return "GREETING";

    // pregunta / meta-pregunta
    const looksQuestion =
      t.endsWith("?") ||
      t.includes("cual era la primera pregunta") ||
      t.includes("cual es la primera pregunta") ||
      t.includes("que era la primera pregunta") ||
      t.includes("que preguntaste") ||
      t.includes("que debo responder") ||
      t.includes("no entiendo") ||
      t.includes("explicame");

    if (looksQuestion) return "QUESTION";

    // empezar / iniciar wizard
    const isStart =
      t === "empezar" ||
      t === "iniciar" ||
      t === "comenzar" ||
      t.includes("quiero empezar") ||
      t.includes("quiero iniciar") ||
      t.includes("iniciemos") ||
      t.includes("arranquemos");

    if (isStart) return "START";

    // confirmar avanzar (cuando ya se capturó todo y se pide confirmación)
    if (isReadyIntent(text) || isConfirmIntent(text)) return "CONFIRM";

    // editar/modificar datos guardados
    if (t.includes("cambiar") || t.includes("editar") || t.includes("modificar")) return "EDIT";

    return "ANSWER";
  }

  function splitProducts(text: string) {
    // Acepta: "ladrillos, tejas" o "ladrillos y tejas"
    // También limpia frases tipo: "los productos son Yogurt y refresco"
    const cleaned = text
      .trim()
      // quita prefijos comunes
      .replace(
        /^(?:mis|los|las)?\s*(?:productos?|servicios?)\s*(?:son|es|serian|:\s*)\s*/i,
        ""
      )
      // quita "son:" al inicio si quedó
      .replace(/^(?:son|es)\s*:\s*/i, "");

    const parts = cleaned
      .split(/,| y |;/i)
      .map((s) =>
        s
          .trim()
          .replace(/[.\s]+$/g, "") // quita puntos finales
          .replace(/^[\-\*\u2022]\s*/g, "") // quita viñetas al inicio
      )
      .filter(Boolean)
      .slice(0, 6);

    // Normaliza capitalización simple (Yogurt, Refresco)
    const normalized = parts.map((p) =>
      p
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    );

    // Dedup
    return Array.from(new Set(normalized));
  }

  function splitProcesses(text: string) {
    const t = text.trim();
    if (!t) return [];
    return text
      .split(/,| y |;/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  function parseBsAmount(text: string): number | null {
    // captura 9000, 9.000, 9,000, 9000.50, 9000,50
    const m = text.match(/(-?\d[\d.,]*)/);
    if (!m) return null;

    let raw = m[1];

    // si tiene ambos , y . asumimos separador de miles + decimales
    // regla simple: el último separador es decimal si hay 2 dígitos después
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");

    if (lastComma > lastDot) {
      // coma podría ser decimal
      const dec = raw.slice(lastComma + 1);
      if (dec.length === 2) {
        raw = raw.replace(/\./g, "").replace(",", ".");
      } else {
        raw = raw.replace(/,/g, "");
      }
    } else if (lastDot > lastComma) {
      const dec = raw.slice(lastDot + 1);
      if (dec.length === 2) {
        raw = raw.replace(/,/g, "").replace(".", ".");
      } else {
        raw = raw.replace(/\./g, "");
      }
    } else {
      raw = raw.replace(/,/g, "");
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return null;
    return n;
  }

  function parseCostItems(text: string): { name: string; amount_bs: number }[] {
    // acepta: "mano de obra 2800, materia prima 3200, energia 400"
    // o por líneas:
    // Mano de obra: 2800 Bs
    const parts = text
      .split(/\n|,|;+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const items: { name: string; amount_bs: number }[] = [];

    for (const p of parts) {
      const amt = parseBsAmount(p);
      if (amt === null) continue;

      // nombre: quitar monto y símbolos
      const name = p
        .replace(/(-?\d[\d.,]*)/g, "")
        .replace(/bs\.?/gi, "")
        .replace(/:/g, "")
        .trim();

      if (!name) continue;

      items.push({
        name: name.slice(0, 80),
        amount_bs: amt,
      });
    }

    // dedup por name
    const seen = new Set<string>();
    const out: typeof items = [];
    for (const it of items) {
      const key = normalizeText(it.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }

    return out.slice(0, 30);
  }

  function isProdQuestion(text: string) {
    const t = normalizeText(text);
    return (
      t.endsWith("?") ||
      t.includes("no entiendo") ||
      t.includes("explicame") ||
      t.includes("como") ||
      t.includes("por que") ||
      t.includes("que significa") ||
      t.includes("ejemplo")
    );
  }

  function promptForStep(step: 1 | 2 | 3) {
    if (step === 1)
      return "1/3) ¿Cuál es el sector o rubro de la empresa? (ej: alimentos, textil, servicios)";
    if (step === 2)
      return "2/3) ¿Cuál es el producto o servicio principal? (puedes poner 1–3)";
    return (
      "3/3) ¿En qué área estarás principalmente? (elige 1 o escribe otra)\n" +
      "- Producción\n- Inventarios/Almacén\n- Logística/Despacho\n- Ventas/Atención al cliente\n- Calidad\n- Mantenimiento\n- Administración/Costos"
    );
  }

  function promptProd(step: ProdStep, ctxJson: any, draft: ProductivityDraft) {
    const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
    const line = draft.line || (products.length === 1 ? String(products[0]) : "");

    if (step === 1) {
      return (
        "Perfecto 👍 Iniciamos **Etapa 1: Reporte de Productividad mensual**.\n\n" +
        "🧩 **Paso 1/4 — Tipo de productividad**\n" +
        "Puedes elegir:\n" +
        "• **Monetaria** (Ingresos Bs / Costos Bs)\n" +
        "• **Física** (ej: litros / horas, kg / Bs insumos)\n\n" +
        "Dime cuál usarás y **por qué**.\n" +
        "Ejemplo: *“Trabajaré con monetaria porque tengo ingresos y costos mensuales.”*"
      );
    }

    if (step === 2) {
      return (
        "🧩 **Paso 2/4 — Periodo mensual**\n" +
        "Dime el mes en formato **YYYY-MM**.\n" +
        "Ejemplo: **2026-02**"
      );
    }

    if (step === 3) {
      const lineHint =
        products.length > 1
          ? `\n\n📌 Importante: dime solo de cuál línea es (ej: Yogurt o Refresco).`
          : line
          ? `\n\n📌 Solo de la línea: **${line}**`
          : "";

      return (
        "🧩 **Paso 3/4 — Ingresos del mes (Bs)**\n" +
        "👉 Solo del producto/línea\n" +
        "👉 del mes completo\n\n" +
        "Ejemplo: **Ingresos: 8500 Bs**" +
        lineHint
      );
    }

    if (step === 4) {
      return (
        "🧩 **Paso 4/4 — Costos principales del mes (2 a 4)**\n" +
        "Escríbelos con monto aproximado en Bs.\n\n" +
        "Ejemplo:\n" +
        "- Mano de obra: 2800\n" +
        "- Materia prima: 3200\n" +
        "- Energía: 400"
      );
    }

    // step === 5 (confirmación)
    const income = typeof draft.income_bs === "number" ? draft.income_bs : null;
    const costs = Array.isArray(draft.costs) ? draft.costs : [];
    const costTotal = costs.reduce((a, c) => a + (c.amount_bs || 0), 0);

    const prodByCost =
      income !== null && costTotal > 0 ? (income / costTotal).toFixed(3) : null;

    return (
      "✅ **Resumen del Reporte de Productividad (borrador)**\n\n" +
      `- Periodo: **${draft.period_key ?? "(pendiente)"}**\n` +
      `- Tipo: **${draft.type ?? "(pendiente)"}**\n` +
      `- Línea: **${draft.line ?? "(pendiente)"}**\n` +
      `- Ingresos (Bs): **${income ?? "(pendiente)"}**\n` +
      `- Costos: **${costs.length ? costs.map((c) => `${c.name}: ${c.amount_bs}`).join(", ") : "(pendiente)"}**\n` +
      `- Total costos (Bs): **${costs.length ? costTotal : "(pendiente)"}**\n` +
      (prodByCost ? `- Productividad global aprox: **${prodByCost}** (Ingresos/Costos)\n` : "") +
      "\n¿Confirmas que **ingresos y costos** corresponden SOLO a esa línea y al MISMO mes?\n" +
      "Responde: **sí** / **confirmo** / **ok**"
    );
  }

  function formatContextSummary(ctxJson: any) {
    const sector = String(ctxJson?.sector ?? "").trim() || "(pendiente)";
    const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
    const focus = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus.filter(Boolean) : [];

    return (
      `- **Sector:** ${sector}\n` +
      `- **Producto(s):** ${products.length ? products.join(", ") : "(pendiente)"}\n` +
      `- **Área:** ${focus.length ? focus.join(", ") : "(pendiente)"}`
    );
  }

  function pushAssistantOnce(text: string) {
    setMessages((prev) => {
      const last = [...prev].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (last.trim() === text.trim()) return prev;
      return [...prev, createMessage("assistant", text)];
    });
  }

  function isReadyIntent(text: string) {
    const t = normalizeText(text).trim();
    return (
      t === "ok" ||
      t === "okay" ||
      t === "listo" ||
      t === "dale" ||
      t === "si" ||
      t === "sí" ||
      t.includes("empecemos") ||
      t.includes("iniciemos") ||
      t.includes("continuemos")
    );
  }

  function isConfirmIntent(text: string) {
    const t = normalizeText(text).trim();
    return (
      t === "si" ||
      t === "sí" ||
      t.includes("confirmo") ||
      t.includes("confirmar") ||
      t.includes("de acuerdo") ||
      t.includes("ok confirmo")
    );
  }

  function detectEditingField(text: string): EditTarget {
    const t = normalizeText(text);

    if (t.includes("sector") || t.includes("rubro")) return "sector";
    if (t.includes("producto") || t.includes("productos") || t.includes("servicio")) return "products";
    if (t.includes("area") || t.includes("proceso")) return "process_focus";

    // Si dice "los 3" o "todo"
    if (t.includes("los 3") || t.includes("todo") || t.includes("los tres")) return null;

    return null;
  }

  function advisorResumeGreeting(ctxJson: any, step: 1 | 2 | 3) {
    const sector = String(ctxJson?.sector ?? "").trim();
    const products = Array.isArray(ctxJson?.products) ? ctxJson.products.filter(Boolean) : [];
    const area = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus.filter(Boolean) : [];

    if (step === 1) {
      return (
        "¡Hola! 👋 ¿Qué tal? Para empezar necesito 3 datos rápidos.\n" +
        "Vamos con el primero"
      );
    }

    if (step === 2) {
      return (
        "¡Perfecto! ✅ Ya tengo tu **sector/rubro**: " +
        (sector ? `**${sector}**` : "(pendiente)") +
        ".\n\nAhora sigamos con el **producto o servicio principal**"
      );
    }

    // step === 3
    return (
      "¡Genial! ✅ Ya tengo:\n" +
      `- Sector: **${sector || "(pendiente)"}**\n` +
      `- Producto(s): **${products.length ? products.join(", ") : "(pendiente)"}**\n\n` +
      "Solo me falta el **área principal** donde trabajarás"
    );
  }

  async function finalizeContextAfterEdit(updatedContextJson: any) {
    // 1) re-confirmamos en backend por si el POST dejó status draft
    const confirmed = await confirmPlanContext();

    // 2) marcamos que estamos esperando iniciar Etapa 1
    setAwaitingStage1Start(clientId, true);

    // 3) armamos resumen y lo mostramos
    const summary = formatContextSummary(updatedContextJson);

    setMessages((prev) => [
      ...prev,
      createMessage(
        "assistant",
        "✅ Listo, ya actualicé tu **Contexto del Caso (Etapa 0)**:\n\n" +
          summary +
          "\n\n👉 **Importante:** la **Etapa 1 (Productividad)** se puede completar **más adelante**, cuando tengas datos del mes.\n" +
          "Para avanzar, podemos iniciar con **Etapa 2 (FODA)**.\n\n" +
          "Puedes decir: **ok**, **vamos**, **listo** para continuar.\n" +
          "O escribe: **productividad** si ya tienes tus datos.\n\n" +
          "Si quieres cambiar algo: **cambiar sector/producto/área**."
      ),
    ]);

    // 4) limpiamos wizard local (IMPORTANTE)
    setStage0Step(0);
    setStage0Draft({});
    setEditingField(null);

    // si por algún motivo confirm falla, avisamos (pero NO volvemos al wizard)
    if (!confirmed.ok) {
      setMessages((prev) => [
        ...prev,
        createMessage(
          "assistant",
          confirmed?.payload?.message ||
            "⚠️ Guardé el cambio, pero no pude re-confirmar el contexto. Intenta nuevamente."
        ),
      ]);
    }
  }

  function getNextStage0StepFromContext(ctxJson: any): 1 | 2 | 3 | 0 {
    const sector = String(ctxJson?.sector ?? "").trim();
    const products = Array.isArray(ctxJson?.products) ? ctxJson.products : [];
    const process = Array.isArray(ctxJson?.process_focus) ? ctxJson.process_focus : [];

    if (!sector) return 1;
    if (!products.length) return 2;
    if (!process.length) return 3;
    return 0; // listo (mínimo completo)
  }

  function isContextComplete(ctxJson: any) {
    return getNextStage0StepFromContext(ctxJson) === 0;
  }

  function lastAssistantIsStage0Prompt(msgs: Message[]) {
    const last = [...msgs].reverse().find((m) => m.role === "assistant")?.content ?? "";
    return (
      last.includes("1/3") ||
      last.includes("2/3") ||
      last.includes("3/3") ||
      last.includes("¿Cuál es el producto") ||
      last.includes("¿Cuál es el sector") ||
      last.includes("¿En qué área")
    );
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

  function looksLikeDiagnosis(text: string) {
    const t = normalizeText(text);

    // Si está pidiendo editar/cambiar, NO es diagnóstico
    if (t.includes("cambiar") || t.includes("editar") || t.includes("modificar")) return false;
    const hits = [
      "problema",
      "demora",
      "retras",
      "error",
      "falla",
      "cuello",
      "cola",
      "merma",
      "defecto",
      "desperdicio",
      "tiempo de espera",
    ];

    return hits.some((k) => t.includes(k));
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

  // -----------------------------
  // API helpers (fetch backend)
  // -----------------------------
  async function getAuthHeaders(): Promise<Record<string, string>> {
    if (accessToken) return { Authorization: `Bearer ${accessToken}` };

    // Fallback por seguridad
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function persistMessageDB(input: {
    chatId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: input.chatId,
        role: input.role,
        content: input.content,
      }),
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;

    return { ok: okk, data: json?.data ?? json };
  }

  async function appendAssistant(content: unknown) {
    const safe =
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

    setMessages((prev) => [...prev, createMessage("assistant", safe)]);

    if (modeRef.current === "plan_mejora" && chatIdRef.current) {
      await persistMessageDB({ chatId: chatIdRef.current, role: "assistant", content: safe });
    }
  }

  async function interpretStage0WithLLM(step: 1 | 2 | 3, userText: string, ctxJson: any) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/context/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        step,
        userText,
        currentContextJson: ctxJson ?? {},
      }),
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;

    return { ok: okk, payload };
  }

  async function getPlanContextStatus() {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/context", { headers: { ...authHeaders } });

    const json = await res.json().catch(() => null);
    const ctxOk = res.ok && json?.ok !== false;
    const ctxPayload = json?.data ?? json;

    return {
      ok: ctxOk,
      status: (ctxPayload?.status ?? "draft") as "draft" | "confirmed",
      exists: Boolean(ctxPayload?.exists),
      chatId: (ctxPayload?.chatId ?? null) as string | null,
      contextJson: (ctxPayload?.contextJson ?? {}) as any,
      contextText: (ctxPayload?.contextText ?? null) as string | null,
    };
  }

  async function getProductivityState(currentChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const qs = currentChatId ? `?chatId=${encodeURIComponent(currentChatId)}` : "";
    const res = await fetch(`/api/plans/productivity/state${qs}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok: okk, payload };
  }

  async function saveProductivityState(state: { prodStep: number; prodDraft: any }, currentChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(`/api/plans/productivity/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: currentChatId ?? null,
        state,
      }),
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok: okk, payload };
  }

  async function clearProductivityState() {
    const authHeaders = await getAuthHeaders();
    const res = await fetch(`/api/plans/productivity/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ clear: true }),
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok: okk, payload };
  }

  async function getLastProductivityReport() {
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/plans/productivity", {
        method: "GET",
        headers: { ...authHeaders },
      });

      const data = await res.json().catch(() => null);
      const ok = res.ok && data?.ok === true;

      const payload = ok && data?.data?.exists === false ? null : (ok ? data.data : null);

      return { ok, payload };
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

  async function createAdvisorChatOnly(): Promise<{ ok: boolean; chatId: string | null; payload: any }> {
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
    const payload = json?.data ?? json;
    const chatId = (payload?.chatId ?? null) as string | null;

    if (ok && chatId) {
      chatIdRef.current = chatId;
      setChatId(chatId);
      try {
        window.sessionStorage.setItem(storageKeyChat, chatId);
      } catch {}
    }

    return { ok, chatId, payload };
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

    // ✅ Renombramos el payload de request
    const reqBody: any = {
      contextJson,
      // ✅ para evitar el error de null, mandamos string siempre
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
    const res = await fetch("/api/plans/context/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({}),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;

    return { ok, payload, status: res.status };
  }

  async function saveProductivity(payload: any, chatId?: string | null) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/productivity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: chatId ?? undefined,
        payload,
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const data = json?.data ?? json;
    return { ok, data, status: res.status };
  }

  async function validateProductivity(period: string) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/productivity/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ period }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const data = json?.data ?? json;
    return { ok, data, status: res.status };
  }

  async function handleSendGeneral(text: string) {
    if (!text.trim()) return;

    // ✅ 1. PINTAR SIEMPRE el mensaje del usuario
    const userMsg = createMessage("user", text);
    setMessages((prev) => [...prev, userMsg]);

    // intercept horas (no cambia)
    if (isHoursIntent(text)) {
      setShowHoursInline(true);
      setMessages((prev) => [
        ...prev,
        createMessage(
          "assistant",
          "Listo ✅ Aquí tienes el formulario para registrar tus horas de esta semana."
        ),
      ]);
      return;
    }

    setShowHoursInline(false);
    setIsSending(true);

    try {
      const authHeaders = await getAuthHeaders();
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

      if (payload?.chatId && payload.chatId !== chatIdRef.current) {
        suppressNextHistoryHydrationRef.current = true;
        chatIdRef.current = payload.chatId;
        setChatId(payload.chatId);
        window.sessionStorage.setItem(storageKeyChat, payload.chatId);
      }

      // ✅ 2. Ahora sí, la respuesta de la IA
      setMessages((prev) => [
        ...prev,
        createMessage("assistant", payload.reply ?? "Listo."),
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        createMessage("assistant", "⚠️ Ocurrió un error al procesar tu mensaje."),
      ]);
    } finally {
      setIsSending(false);
    }
  }

  type ProdAssistantPatch = {
    unit_type?: "monetaria" | "fisica" | null;
    unit_reason?: string | null;
    period?: string | null;          // YYYY-MM
    income_bs?: number | null;
    income_line?: string | null;
  };

  type ProdAssistantCost = { name: string; amount_bs: number; note?: string };

  type ProdAssistantResponse = {
    assistantMessage: string;
    updates: {
      step: number;
      patch: ProdAssistantPatch;
      addCosts: ProdAssistantCost[];
    };
    control: {
      needsClarification: boolean;
      doneWithStage: boolean;
    };
    signals?: {
      uncertainty?: number;
      confusion?: number;
      confidence_extract?: number;
    };
  };

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

  function mergeCosts(existing: any, add: ProdAssistantCost[], requiredCosts: number) {
    const prev: ProdAssistantCost[] = Array.isArray(existing) ? existing : [];

    const seen = new Set(prev.map((c) => normalizeText(c.name)));
    const merged: ProdAssistantCost[] = [...prev];

    for (const c of add) {
      const key = normalizeText(c.name);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        name: c.name,
        amount_bs: c.amount_bs,
        note: c.note,
      });
      if (merged.length >= requiredCosts) break;
    }

    return merged;
  }

  function applyAssistantPatchToDraft(
    current: ProductivityDraft,
    patch: ProdAssistantPatch
  ): ProductivityDraft {
    const next: ProductivityDraft = { ...current };

    // ✅ MAPEO (para que no se rompa tu estado)
    if (patch.unit_type) next.type = patch.unit_type;
    if (typeof patch.unit_reason === "string" && patch.unit_reason.trim()) next.unit_reason = patch.unit_reason.trim();

    if (patch.period) next.period_key = patch.period;
    if (typeof patch.income_bs === "number") next.income_bs = patch.income_bs;
    if (patch.income_line) next.line = patch.income_line;

    return next;
  }

  async function callProductivityAssistant(input: {
    studentMessage: string;
    prodStep: number;
    prodDraft: ProductivityDraft;
    caseContext: any;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/productivity/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        studentMessage: input.studentMessage,
        prodStep: input.prodStep,
        prodDraft: input.prodDraft,
        caseContext: input.caseContext ?? {},
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const okk = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;

    return { ok: okk, payload: payload as ProdAssistantResponse };
  }

  async function getFodaState(chatIdArg?: string | null) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId =
      chatIdArg === undefined ? (chatIdRef.current ?? null) : chatIdArg;

    const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

    const res = await fetch(`/api/plans/foda/state${qs}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }




  async function saveFodaState(state: any, chatIdArg?: string | null) {
    if (!accessToken) {
      return { ok: false as const, skipped: true as const, reason: "NO_ACCESS_TOKEN" as const };
    }

    const effectiveChatId = chatIdArg ?? chatIdRef.current ?? null;
    if (!effectiveChatId) {
      return { ok: false as const, skipped: true as const, reason: "NO_CHAT_ID" as const };
    }

    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/foda/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ state, chatId: effectiveChatId }),
    });


    const json = await res.json().catch(() => null);

    // criterio correcto: ok si HTTP ok y el JSON no dice explícitamente ok:false
    const ok = res.ok && json?.ok !== false;

    if (!ok) {
      // ⚠️ warn (no error) para que no salga el overlay rojo de Next
      console.warn("[FODA] autosave failed (non-blocking)", { status: res.status, json });
    }

    return { ok, status: res.status, json };
  }

  async function callFodaAssistant(input: {
    studentMessage: string;
    fodaState: FodaState;
    caseContext: any;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/foda/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        studentMessage: input.studentMessage,
        fodaState: input.fodaState,
        caseContext: input.caseContext ?? {},
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;

    return { ok, payload };
  }

  async function getBrainstormState(chatIdArg?: string | null) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId =
      chatIdArg === undefined ? (chatIdRef.current ?? null) : chatIdArg;

    const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

    const res = await fetch(`/api/plans/brainstorm/state${qs}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
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
    const res = await fetch("/api/plans/brainstorm/state", {
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

      if (!ok) {
        console.warn("[BRAINSTORM] save state failed", {
          status: res.status,
          contentType,
          json,
          text,
        });
      }

      return { ok };
  }

    async function validateFoda(chatIdArg?: string | null) {
      const authHeaders = await getAuthHeaders();
      const effectiveChatId = chatIdArg ?? chatIdRef.current ?? null;

      const res = await fetch("/api/plans/foda/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ chatId: effectiveChatId }),
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      return { ok, payload: json };
    }

  async function callBrainstormAssistant(input: {
    studentMessage: string;
    brainstormState: BrainstormState;
    caseContext: any;
    stage1Summary: any;
    fodaSummary: any;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/brainstorm/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        studentMessage: input.studentMessage,
        brainstormState: input.brainstormState,
        caseContext: input.caseContext ?? {},
        stage1Summary: input.stage1Summary ?? null,
        fodaSummary: input.fodaSummary ?? null,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function validateBrainstorm() {
    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/plans/brainstorm/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: chatIdRef.current }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }

  async function getIshikawaState(opts?: { ignoreChatId?: boolean }) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId = opts?.ignoreChatId ? null : chatIdRef.current;

    // ✅ chatId es opcional. Si existe, lo enviamos (mejor match). Si no, el backend hace fallback al último estado del periodo.
    const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

    const res = await fetch(`/api/plans/ishikawa/state${qs}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
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
    const res = await fetch("/api/plans/ishikawa/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId }),
    });

    const json = await res.json().catch(() => null);
    const payload = json?.data ?? json;

    // ✅ ok SOLO si valid === true
    const ok = res.ok && json?.ok !== false && payload?.valid === true;

    return { ok, payload };
  }

  async function getParetoState(chatIdArg?: string | null) {
    const authHeaders = await getAuthHeaders();

    const effectiveChatId =
      chatIdArg === undefined ? (chatIdRef.current ?? null) : chatIdArg;

    const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

    const res = await fetch(`/api/plans/pareto/state${qs}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
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

    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/plans/pareto/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ state, chatId: effectiveChatId }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;

    if (!ok) console.warn("[PARETO] save state failed", { status: res.status, json });
    return { ok };
  }

  async function callParetoAssistant(input: {
    studentMessage: string;
    paretoState: ParetoState;
    caseContext: Record<string, unknown> | null;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/pareto/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        studentMessage: input.studentMessage,
        paretoState: input.paretoState,
        caseContext: input.caseContext ?? null,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

    async function validatePareto(effectiveChatId?: string | null) {
      const authHeaders = await getAuthHeaders();
      const cid = effectiveChatId ?? chatIdRef.current ?? null;

      const res = await fetch("/api/plans/pareto/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ chatId: cid }),
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      return { ok, payload: json };
    }


    async function getGenericStageState(
      stage: number,
      args?: { chatId?: string | null; latest?: boolean }
    ) {
      const authHeaders = await getAuthHeaders();

      const qs = new URLSearchParams({ stage: String(stage) });
      if (args?.chatId) qs.set("chatId", args.chatId);
      if (args?.latest) qs.set("latest", "true");

      const res = await fetch(`/api/plans/stage-state?${qs.toString()}`, {
        headers: { ...authHeaders },
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      const payload = json?.data ?? json;
      return { ok, payload };
    }


    async function getResumeGate(targetStage: number, sourceChatId?: string | null) {
      const authHeaders = await getAuthHeaders();

      const qs = new URLSearchParams({
        targetStage: String(targetStage),
      });

      if (sourceChatId) qs.set("chatId", sourceChatId);

      const res = await fetch(`/api/plans/resume-gate?${qs.toString()}`, {
        headers: { ...authHeaders },
      });

      const json = await res.json().catch(() => null);
      const ok = res.ok && json?.ok !== false;
      return { ok, payload: json };
    }


  async function clearStageState(stage: number, effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    if (!cid) return { ok: false as const, payload: null };

    const res = await fetch("/api/plans/stage-state", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: cid,
        stage,
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }



  async function getObjectivesState(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };

    const res = await fetch(`/api/plans/objectives/state?chatId=${encodeURIComponent(cid)}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function saveObjectivesState(state: ObjectivesState, effectiveChatId?: string | null) {
    if (!accessToken) {
      console.warn("[OBJECTIVES] Guardado sin accessToken. Se omite.");
      return { ok: false as const };
    }

    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) {
      console.warn("[OBJECTIVES] No hay chatId para guardar state. Se omite.");
      return { ok: false as const };
    }

    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/plans/objectives/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid, stateJson: state }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    if (!ok) console.error("[OBJECTIVES] save state failed", { status: res.status, json });
    return { ok: ok as boolean };
  }

  async function callObjectivesAssistant(input: {
    studentMessage: string;
    objectivesState: ObjectivesState;
    caseContext: Record<string, unknown> | null;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();
    const cid = input.effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/objectives/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: cid,
        studentMessage: input.studentMessage,
        objectivesState: input.objectivesState,
        caseContext: input.caseContext ?? null,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function validateObjectives(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/objectives/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }

  async function getImprovementState(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };

    const res = await fetch(`/api/plans/improvement/state?chatId=${encodeURIComponent(cid)}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function saveImprovementState(state: ImprovementState, effectiveChatId?: string | null) {
    if (!accessToken) {
      console.warn("[IMPROVEMENT] Guardado sin accessToken. Se omite.");
      return { ok: false as const };
    }

    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) {
      console.warn("[IMPROVEMENT] No hay chatId para guardar state. Se omite.");
      return { ok: false as const };
    }

    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/plans/improvement/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid, stateJson: state }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    if (!ok) console.error("[IMPROVEMENT] save state failed", { status: res.status, json });
    return { ok: ok as boolean };
  }

  async function callImprovementAssistant(input: {
    studentMessage: string;
    improvementState: ImprovementState;
    caseContext: Record<string, unknown> | null;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();
    const cid = input.effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/improvement/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: cid,
        studentMessage: input.studentMessage,
        improvementState: input.improvementState,
        caseContext: input.caseContext ?? null,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function validateImprovement(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/improvement/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }

  async function getPlanningState(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;
    if (!cid) return { ok: false as const, payload: null };

    const res = await fetch(`/api/plans/planning/state?chatId=${encodeURIComponent(cid)}`, {
      headers: { ...authHeaders },
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function savePlanningState(state: PlanningState, effectiveChatId?: string | null) {
    if (!accessToken) {
      console.warn("[PLANNING] Guardado sin accessToken. Se omite.");
      return { ok: false as const };
    }

    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/planning/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid, stateJson: state }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }

  async function callPlanningAssistant(args: {
    studentMessage: string;
    planningState: PlanningState;
    caseContext: any;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/planning/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: args.effectiveChatId ?? chatIdRef.current,
        studentMessage: args.studentMessage,
        planningState: args.planningState as any,
        caseContext: args.caseContext ?? null,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    const payload = json?.data ?? json;
    return { ok, payload };
  }

  async function validatePlanning(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/planning/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid }),
    });

    const json = await res.json().catch(() => null);
    const ok = res.ok && json?.ok !== false;
    return { ok, payload: json };
  }

  async function saveProgressState(state: ProgressState, effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/progress/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid, stateJson: state }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json };
  }

  async function callProgressAssistant(args: {
    studentMessage: string;
    progressState: ProgressState;
    effectiveChatId?: string | null;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/progress/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: args.effectiveChatId ?? chatIdRef.current,
        studentMessage: args.studentMessage,
        progressState: args.progressState as any,
        recentHistory: buildRecentHistoryForAssistant(10),
      }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json };
  }

  async function validateProgress(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/progress/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json };
  }

  // ================================
  // ETAPA 10: helpers API
  // ================================
  async function saveFinalDocState(state: FinalDocState, effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/final_doc/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid, stateJson: state }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json };
  }

  async function callFinalDocAssistant(args: {
    effectiveChatId?: string | null;
    fileName: string;
    storagePath: string;
    extractedText: string;
    versionNumber: 1 | 2;
  }) {
    const authHeaders = await getAuthHeaders();

    const res = await fetch("/api/plans/final_doc/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        chatId: args.effectiveChatId ?? chatIdRef.current,
        fileName: args.fileName,
        storagePath: args.storagePath,
        extractedText: args.extractedText,
        versionNumber: args.versionNumber,
        recentHistory: buildRecentHistoryForAssistant(12),
      }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json?.data ?? json };
  }

  async function validateFinalDoc(effectiveChatId?: string | null) {
    const authHeaders = await getAuthHeaders();
    const cid = effectiveChatId ?? chatIdRef.current ?? null;

    const res = await fetch("/api/plans/final_doc/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ chatId: cid }),
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok && json?.ok !== false, payload: json };
  }


  async function callIshikawaAssistant(args: {
    studentMessage: string;
    ishikawaState: IshikawaState;
    caseContext: any;
    stage1Summary: any;
    brainstormState: any;
  }) {
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
      return { ok: false as const, assistantMessage: "⚠️ No pude procesar tu mensaje en Ishikawa.", nextState: args.ishikawaState };
    }

    const data = json?.data ?? json?.payload ?? json ?? null;

    const assistantMessage =
      data?.assistantMessage ?? null;

    const nextState =
      data?.updates?.nextState ?? null;


    if (!assistantMessage || !nextState) {
      return { ok: true as const, assistantMessage: "⚠️ No pude ubicar tu respuesta. ¿Puedes describir una causa concreta?", nextState: args.ishikawaState };
    }

    return { ok: true as const, assistantMessage, nextState: nextState as IshikawaState };
  }

  // -----------------------------
  // Enviar mensaje
  // -----------------------------

  async function restoreLatestAdvisorStageToNewChat(effectiveChatId: string) {

    // 10
    const s10 = await getGenericStageState(10, { latest: true });
    const s10Row = s10.ok ? s10.payload?.row ?? null : null;
    const s10ChatId =
      s10Row && typeof s10Row.chat_id === "string" ? (s10Row.chat_id as string) : null;
    const prog = s10Row?.state_json ? (s10Row.state_json as ProgressState) : null;

    if (prog && s10ChatId) {
      const resumeGate10 = await getResumeGate(10, s10ChatId);

      if (resumeGate10.ok && resumeGate10.payload?.allowed) {
        setProgressState(prog);
        await saveProgressState(prog, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 10 (Reporte de Avances)**.\n\n" +
          "👉 Continúa registrando avances, evidencias y resultados parciales/finales.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 9
    const s9 = await getGenericStageState(9, { latest: true });
    const s9Row = s9.ok ? s9.payload?.row ?? null : null;
    const s9ChatId =
      s9Row && typeof s9Row.chat_id === "string" ? (s9Row.chat_id as string) : null;
    const plan9 = s9Row?.state_json ? (s9Row.state_json as PlanningState) : null;

    if (plan9 && s9ChatId) {
      const resumeGate9 = await getResumeGate(9, s9ChatId);

      if (resumeGate9.ok && resumeGate9.payload?.allowed) {
        setPlanningState(plan9);
        await savePlanningState(plan9, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 9 (Planificación / Cronograma)**.\n\n" +
          "👉 Continúa armando el cronograma, responsables, recursos y tiempos.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 8
    const s8 = await getGenericStageState(8, { latest: true });
    const s8Row = s8.ok ? s8.payload?.row ?? null : null;
    const s8ChatId =
      s8Row && typeof s8Row.chat_id === "string" ? (s8Row.chat_id as string) : null;
    const impl = s8Row?.state_json ? (s8Row.state_json as ImprovementState) : null;

    if (impl && s8ChatId) {
      const resumeGate8 = await getResumeGate(8, s8ChatId);

      if (resumeGate8.ok && resumeGate8.payload?.allowed) {
        setImprovementState(impl);
        await saveImprovementState(impl, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 8 (Plan de Mejora)**.\n\n" +
          "👉 Continúa desarrollando acciones, responsables, recursos y KPIs.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 7
    const s7 = await getGenericStageState(7, { latest: true });
    const s7Row = s7.ok ? s7.payload?.row ?? null : null;
    const s7ChatId =
      s7Row && typeof s7Row.chat_id === "string" ? (s7Row.chat_id as string) : null;
    const imp = s7Row?.state_json ? (s7Row.state_json as ImprovementState) : null;

    if (imp && s7ChatId) {
      const resumeGate7 = await getResumeGate(7, s7ChatId);

      if (resumeGate7.ok && resumeGate7.payload?.allowed) {
        setImprovementState(imp);
        await saveImprovementState(imp, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 7 (Plan de Mejora)**.\n\n" +
          "👉 Continúa estructurando la propuesta de mejora.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 6
    const s6 = await getGenericStageState(6, { latest: true });
    const s6Row = s6.ok ? s6.payload?.row ?? null : null;
    const s6ChatId =
      s6Row && typeof s6Row.chat_id === "string" ? (s6Row.chat_id as string) : null;
    const obj = s6Row?.state_json ? (s6Row.state_json as ObjectivesState) : null;

    if (obj && s6ChatId) {
      const resumeGate6 = await getResumeGate(6, s6ChatId);

      if (resumeGate6.ok && resumeGate6.payload?.allowed) {
        setObjectivesState(obj);
        await saveObjectivesState(obj, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 6 (Objetivos)**.\n\n" +
          "👉 Continúa trabajando el objetivo general y los objetivos específicos.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }


    // 5
    const s5 = await getParetoState(null);
    const s5ChatId =
      s5.ok && typeof s5.payload?.chatId === "string" ? (s5.payload.chatId as string) : null;
    const pareto = s5.ok ? (s5.payload?.state as ParetoState | null) : null;

    if (pareto && s5ChatId) {
      const resumeGate5 = await getResumeGate(5, s5ChatId);

      if (resumeGate5.ok && resumeGate5.payload?.allowed) {
        setParetoState(pareto);
        await saveParetoState(pareto, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 5 (Pareto)**.\n\n" +
          "👉 Continúa seleccionando, ponderando y cerrando tus causas críticas.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 4
    const s4 = await getIshikawaState({ ignoreChatId: true });
    const s4ChatId =
      s4.ok && typeof s4.payload?.chatId === "string" ? (s4.payload.chatId as string) : null;
    const ishi = s4.ok ? (s4.payload?.state as IshikawaState | null) : null;

    if (ishi && s4ChatId) {
      const resumeGate4 = await getResumeGate(4, s4ChatId);

      if (resumeGate4.ok && resumeGate4.payload?.allowed) {
        setIshikawaState(ishi);
        setIshikawaClosePending(isIshikawaReadyToClose(ishi));
        await saveIshikawaState(ishi, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 4 (Ishikawa)**.\n\n" +
          "👉 Continúa bajando desde causa principal hasta causa raíz.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 3
    const s3 = await getBrainstormState(null);
    const s3ChatId =
      s3.ok && typeof s3.payload?.chatId === "string" ? (s3.payload.chatId as string) : null;
    const bs = s3.ok ? (s3.payload?.state as BrainstormState | null) : null;

    if (bs && s3ChatId) {
      const resumeGate3 = await getResumeGate(3, s3ChatId);

      if (resumeGate3.ok && resumeGate3.payload?.allowed) {
        const clean = sanitizeBrainstormState(bs);
        setBrainstormState(clean);
        await saveBrainstormState(clean, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 3 (Lluvia de ideas)**.\n\n" +
          "👉 Continúa con la siguiente causa concreta.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
    }

    // 2
    const s2 = await getFodaState(null);
    const s2ChatId =
      s2.ok && typeof s2.payload?.chatId === "string" ? (s2.payload.chatId as string) : null;
    const foda = s2.ok ? (s2.payload?.state as FodaState | null) : null;

    if (foda && s2ChatId) {
      const resumeGate2 = await getResumeGate(2, s2ChatId);

      if (resumeGate2.ok && resumeGate2.payload?.allowed) {
        setFodaState(foda);
        await saveFodaState(foda, effectiveChatId);

        const msg =
          "📌 Abrí un nuevo chat, pero mantendremos tu avance.\n\n" +
          "Estabas en **Etapa 2 (FODA)**.\n\n" +
          "👉 Continúa con el siguiente punto de tu cuadrante actual.";
        setMessages([createMessage("assistant", msg)]);
        await persistMessageDB({ chatId: effectiveChatId, role: "assistant", content: msg });
        return true;
      }
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
        let skipCtxSync = false;

        if (mustStartFresh && !effectiveChatId) {
          const resNew = await fetch("/api/plans/context", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            // ✅ Evita isChatOnly: contextText debe ser string (""), no null
            body: JSON.stringify({ forceNew: true, contextJson: {}, contextText: "" }),
          });

          const jsonNew = await resNew.json().catch(() => null);
          const payloadNew = jsonNew?.data ?? jsonNew;
          const newChatId = payloadNew?.chatId as string | undefined;

          if (resNew.ok && jsonNew?.ok !== false && typeof newChatId === "string") {
            effectiveChatId = newChatId;
            chatIdRef.current = newChatId;
        
            setChatId(newChatId);
            try {
              window.sessionStorage.setItem(`optia-chat-id-${clientId}-plan_mejora`, newChatId);
            } catch {}
            setPlanFresh(clientId, false);
          } else {
            setPlanFresh(clientId, false);
            setMessages((prev) => [
              ...prev,
              createMessage("assistant", "⚠️ No pude crear un chat nuevo del Asesor. Intenta otra vez."),
            ]);
            return;
          }
        }
        
        if (effectiveChatId) {
          await persistMessageDB({ chatId: effectiveChatId, role: "user", content: text });
        }

        const ctx = await getPlanContextStatusCached();
        const confirmedLike = ctx.status === "confirmed" || isContextComplete(ctx.contextJson);
        const intentC = detectStage0Intent(text);
        const lastReport = await getLastProductivityReportCached();
        const lastStatus = lastReport.ok ? lastReport.payload?.status : null;
        const isStage1Validated = lastStatus === "validated";

        // ✅ Etapa 1 (Productividad) NO bloquea el avance a FODA y siguientes.
        // La productividad se puede completar cuando el estudiante tenga datos del mes.
        const allowSkipProductivity = true;
        const diagUnlocked = isStage1Validated || allowSkipProductivity;

        // ================================
        // ETAPA 9: Reporte de avances (fluido con assistant)
        // ================================
        if (progressState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callProgressAssistant({
            studentMessage: text,
            progressState,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant(
              "⚠️ No pude procesar tu reporte. Cuéntame brevemente qué lograste implementar hasta hoy."
            );
            return;
          }

          const nextState = assistant.payload.updates.nextState as ProgressState;

          setProgressState(nextState);
          await saveProgressState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          if (nextState.step === "review" && isProgressReadyForValidation(nextState)) {
            const v = await validateProgress(effectiveChatId);

            if (!v.ok) {
              await appendAssistant("⚠️ No se pudo cerrar el reporte de avances.");
              return;
            }

            if (v.payload?.valid) {
              await appendAssistant(
                "✅ **Etapa 9 (Reporte de avances) finalizada.**"
              );

              setProgressState(null);

              // Iniciar Etapa 10: documento final (v1)
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

              setFinalDocState(initialFinalDoc);
              await saveFinalDocState(initialFinalDoc, effectiveChatId);

              await appendAssistant(
                "📄 **Etapa 10 (Documento final)**\n\n" +
                  "En esta etapa podemos trabajar de forma **conversacional**: si tienes dudas sobre tu plan final, pregúntame.\n\n" +
                  "Cuando quieras, **sube tu Word/PDF** con el botón de adjuntar y haré una revisión crítica cruzando con tus **etapas validadas** y tu **registro de horas**.\n\n" +
                  "✅ Máximo **2 versiones**:\n" +
                  "• **Versión 1:** te doy feedback.\n" +
                  "• **Versión 2:** es la **definitiva** y luego se cierra el Asesor."
              );
            }
          }

          return;
        }

        // ================================
        // ETAPA 8: Planificación (fluido con assistant)
        // ================================
        if (planningState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callPlanningAssistant({
            studentMessage: text,
            planningState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant(
              "⚠️ No pude procesar tu Planificación. Dime en 1 línea: ¿cuántas semanas te quedan para aplicar la mejora (aprox.)?"
            );
            return;
          }

          const nextState = assistant.payload.updates.nextState as PlanningState;

          setPlanningState(nextState);
          await savePlanningState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);




          if (nextState.step === "review" && isPlanningReadyForValidation(nextState)) {
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
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            await appendAssistant(
              "✅ **Etapa 8 (Planificación) finalizada**.\n\n" +
              "Con esto completaste el **Avance 2**.\n\n" +
              "Luego sigue el **Avance 3 (Etapa 9)**: ahí solo reportarás cómo va la implementación y, si ya lo tienes, podrás subir un archivo."
            );

            setPlanningState(null);

            const initialProgress: ProgressState = {
              step: "intro",
              reportText: null,
              progressPercent: null,
              measurementNote: null,
              summary: null,
              updatedAtLocal: null,
            };

            setProgressState(initialProgress);
            await saveProgressState(initialProgress, effectiveChatId);
            setPlanningState(null);
            await clearStageState(9, effectiveChatId);
          }

          return;
        }

        // ================================
        // ETAPA 7: Plan de mejora (fluido con assistant)
        // ================================
        if (improvementState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callImprovementAssistant({
            studentMessage: text,
            improvementState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant("⚠️ No pude procesar tu Plan de Mejora. ¿Me resumes en 1–2 líneas qué mejora quieres implementar o qué duda tienes?");
            return;
          }

          const nextState = assistant.payload.updates.nextState as ImprovementState;

          setImprovementState(nextState);
          await saveImprovementState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          // Cierre: si llega a review y está listo, validamos Etapa 7
          if (nextState.step === "review" && isImprovementReadyForValidation(nextState)) {
            const v = await validateImprovement(effectiveChatId);

            if (!v.ok) {
              const msg = v.payload?.message ?? "No se pudo cerrar Etapa 7 (Plan de Mejora).";
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            if (v.payload?.valid) {
              await appendAssistant(
                "✅ **Etapa 7 (Plan de Mejora) finalizada**.\n\n" +
                "Ahora pasamos a la **Etapa 8 (Planificación)** para definir tiempos, secuencia y un cronograma realista."
              );

              // Importante: dejamos de capturar Etapa 7
              setImprovementState(null);
              await clearStageState(7, effectiveChatId);

              // Iniciar PlanningState (vacío) y guardarlo
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

              setPlanningState(initialPlanning);
              await savePlanningState(initialPlanning, effectiveChatId);
              setImprovementState(null);
              await clearStageState(8, effectiveChatId);

            }
          }

          return;
        }

        // ================================
        // ETAPA 6: Objetivos (en progreso)
        // ================================
        if (objectivesState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callObjectivesAssistant({
            studentMessage: text,
            objectivesState,
            caseContext: (ctx.contextJson ?? null) as any,
            effectiveChatId,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            const backendMessage =
              assistant.payload?.message ??
              assistant.payload?.detail?.message ??
              null;

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

          // Si llega a review, intentamos validar y cerrar la etapa 6
          if (nextState.step === "review" && isObjectivesReadyForValidation(nextState)) {
            const v = await validateObjectives(effectiveChatId);
            if (!v.ok) {
              const msg = v.payload?.message ?? "No se pudo cerrar Etapa 6 (Objetivos).";
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            if (v.payload?.valid) {
              await appendAssistant(
                "✅ **Etapa 6 (Objetivos) finalizada**.\n\n" +
                "Ahora entramos a la **Etapa 7: Plan de Mejora**.\n" +
                "Cuéntame lo primero que se te viene a la mente como mejora (aunque no estés seguro). Si no tienes nada aún, lo construimos juntos."
              );

              // Iniciar ImprovementState y guardarlo
              const initialImprovement: ImprovementState = {
                stageIntroDone: true,
                step: "discover",
                focus: { chosenRoot: null, chosenObjective: null },
                initiatives: [],
                lastSummary: null,
              };

              setImprovementState(initialImprovement);
              await saveImprovementState(initialImprovement, effectiveChatId);

              // Cerrar y limpiar Etapa 6 para que no se reanude por error
              setObjectivesState(null);
              await clearStageState(6, effectiveChatId);
            }
          }
          return;
        }

        // ================================
        // ETAPA 5: Pareto (en progreso)
        // ================================
        if (paretoState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callParetoAssistant({
            studentMessage: text,
            paretoState,
            caseContext: (ctx.contextJson ?? null) as any,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant("⚠️ No pude procesar tu avance en Pareto. ¿Puedes reformular en 1–2 líneas lo que hiciste?");
            return;
          }

          const nextState = assistant.payload.updates.nextState as ParetoState;

          setParetoState(nextState);
          await saveParetoState(nextState, effectiveChatId);

          await appendAssistant(assistant.payload.assistantMessage);

          // Si el assistant marcó done, intentamos validar y cerrar Etapa 5
          if (nextState.step === "done") {
            const v = await validatePareto(effectiveChatId);

            if (!v.ok) {
              const msg =
                v.payload?.message ??
                "No se pudo cerrar Etapa 5 (Pareto). Revisa que hayas enviado el top 20%.";
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            if (!v.payload?.valid) {
              const msg =
                v.payload?.message ??
                "Pareto aún no quedó validado. Revisa tus causas críticas (top 20%) antes de pasar a Objetivos.";
              await appendAssistant(`⚠️ ${msg}`);
              return;
            }

            await appendAssistant(
              "✅ **Etapa 5 (Pareto) finalizada**.\n\n" +
                "Ahora iniciamos la **Etapa 6: Objetivos del Plan de Mejora**.\n\n" +
                "👉 Primero redactemos el **Objetivo General** (1 sola oración):\n" +
                "¿Qué vas a lograr atacando esas causas críticas?"
            );

            const initialObjectives: ObjectivesState = {
              generalObjective: "",
              specificObjectives: [],
              linkedCriticalRoots: [],
              step: "general",
            };

            setObjectivesState(initialObjectives);
            await saveObjectivesState(initialObjectives, effectiveChatId);

            setParetoState(null);
            await clearStageState(5, effectiveChatId);

          }

          return;
        }

        // ================================
        // ETAPA 4: Ishikawa (fluido con assistant)
        // ================================

        let effectiveIshikawaState: IshikawaState | null = ishikawaState;

        // ✅ Si el usuario viene de "Nuevo chat" y el state aún no cargó en React,
        // lo buscamos directo del backend (chatId opcional, fallback por periodo).
        if (!effectiveIshikawaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const resIsh = await getIshikawaState({ ignoreChatId: true });
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

        if (effectiveIshikawaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
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
              const resIshFresh = await getIshikawaState({ ignoreChatId: false });
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
                  ishikawaState: freshState,
                  caseContext: ctx?.contextJson ?? null,
                  stage1Summary: null,
                  brainstormState: null,
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
              problem: { text: text.trim().slice(0, 240) },
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

              const roots = Array.isArray(v.payload?.roots) ? (v.payload.roots as string[]) : [];
              const selected = roots.slice(0, 15);

              const initialPareto: ParetoState = {
                roots,
                selectedRoots: selected,
                criteria: [
                  { id: crypto.randomUUID(), name: "Impacto" },
                  { id: crypto.randomUUID(), name: "Frecuencia" },
                  { id: crypto.randomUUID(), name: "Controlabilidad" },
                ],
                criticalRoots: [],
                minSelected: 10,
                maxSelected: 15,
                step: "select_roots",
              };

              setIshikawaClosePending(false);
              setParetoState(initialPareto);
              await saveParetoState(initialPareto, effectiveChatId);

              setIshikawaState(null);
              await clearStageState(4, effectiveChatId);

              const list = selected.map((r, i) => `${i + 1}) ${r}`).join("\n");

              await appendAssistant(
                "✅ Listo, cerramos **Etapa 4 (Ishikawa)** y pasamos a **Etapa 5 (Pareto)**.\n\n" +
                  "Primero trabajaremos con tus **causas raíz** (10–15). Aquí tienes una lista inicial:\n\n" +
                  list +
                  "\n\n" +
                  "👉 Si quieres **quitar/combinar** alguna, dime cuáles. Si está bien, responde **OK** y pasamos a definir **pesos (1–10)** para los 3 criterios."
              );

              return;
            }

            if (wantsKeepAdding(text)) {
              setIshikawaClosePending(false);
              // seguimos normal para refinar
            } else {
              await appendAssistant("¿Quieres **pasar a Pareto (Etapa 5)** o **seguir refinando** Ishikawa?");
              return;
            }
          }

          // 2) Ya hay problema: delegamos al assistant para clasificar + guiar + 5 porqués
          const assistant = await callIshikawaAssistant({
            studentMessage: text,
            ishikawaState,
            caseContext: ctx.contextJson ?? null,
            stage1Summary: lastReport.ok ? lastReport.payload ?? null : null,
            brainstormState: brainstormState ?? null,
          });

          const nextState = assistant.nextState ?? ishikawaState;
          setIshikawaState(nextState);
          await saveIshikawaState(nextState, effectiveChatId);

          await appendAssistant(assistant.assistantMessage);

          // ✅ Si ya cumple mínimos, pedimos confirmación natural para pasar a Pareto
          if (isIshikawaReadyToClose(nextState)) {
            setIshikawaClosePending(true);
            await appendAssistant(
              "✅ Ya tienes una estructura suficiente en Ishikawa. " +
                "¿Quieres **pasar a la Etapa 5 (Pareto)** o **seguir refinando** causas?"
            );
          }
          return;
        }

        // ================================
        // ETAPA 3: Lluvia de ideas (en progreso)
        // ================================

        if (brainstormState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const readyToClose = isBrainstormReadyToClose(brainstormState);
          const isNewIdea = looksLikeNewCause(text);

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

              const problemFromContext = (ctx?.contextJson?.problem?.text ?? ctx?.contextJson?.problem ?? "").toString().trim();

              const finalProblem = (problemFromBrainstorm || problemFromFoda || problemFromContext).trim();

              const initialIshikawa: IshikawaState = {
                problem: finalProblem ? { text: finalProblem } : null,
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
                maxWhyDepth: 3,
                minRootCandidates: 6,
                cursor: null,
              };

              const initialProblemText =
                typeof initialIshikawa.problem === "string"
                  ? initialIshikawa.problem
                  : (typeof (initialIshikawa.problem as any)?.text === "string"
                      ? (initialIshikawa.problem as any).text
                      : "");

              setBrainstormClosePending(false);
              setIshikawaState(initialIshikawa);
              await saveIshikawaState(initialIshikawa, effectiveChatId);

              setBrainstormState(null);
              await clearStageState(3, effectiveChatId);

              // ✅ Un solo mensaje natural (sin duplicados)
              await appendAssistant(
                "✅ Listo, cerramos la lluvia de ideas y pasamos a **Etapa 4 (Ishikawa)**.\n\n" +
                (initialProblemText.trim()
                  ? `🎯 **Problema (cabeza):** ${initialProblemText.trim()}\n\n` +
                    "Respóndeme **OK** si así queda bien, o escríbelo en 1 línea si quieres ajustarlo.\n\n" +
                    "Luego me dices **una causa** y la vamos bajando con **porqués** (causa → subcausa → raíz)."
                  : "Escríbeme el **problema principal** en **1 línea** (la cabeza del Ishikawa).\n\n" +
                    "Después me dices **una causa** y la vamos bajando con **porqués**."
                )
              );

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
            await appendAssistant("⚠️ No pude procesar tu idea con claridad. ¿Puedes reformularla en una causa concreta y entendible?");
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
        if (ctx.ok && ctx.status === "confirmed" && isStage1Validated && !brainstormState) {
          // Si el usuario escribe "etapa 3" o "lluvia" o "ideas", iniciamos.
          const t = text.toLowerCase();
          const wantsE3 = t.includes("etapa 3") || t.includes("lluvia") || t.includes("ideas") || t.includes("brainstorm");

          if (wantsE3) {
            const resBS = await getBrainstormState();
            const exists = resBS.ok && resBS.payload?.exists;

            if (!exists) {
              const initial: BrainstormState = {
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

            const existing = (resBS.payload?.state ?? null) as BrainstormState | null;
            if (existing) {
              setBrainstormState(existing);
              const n = Array.isArray(existing.ideas) ? existing.ideas.length : 0;

              await appendAssistant(
                `📌 Retomemos tu **Etapa 3 (Lluvia de ideas)**.\n\n` +
                  `Problema: ${existing.problem?.text ? `**${existing.problem.text}**` : "**(aún no definido)**"}\n` +
                  `Ideas registradas: **${n}**.\n\n` +
                  "👉 Continúa con la siguiente idea (causa) o escribe **\"validar\"** cuando cumplas el mínimo."
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

            await appendAssistant(
              "✅ **Etapa 2 (FODA) validada**. Pasamos a la **Etapa 3: Lluvia de ideas (causas)**.\n\n" +
              "✅ Primero elige tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
              "👉 Escribe por ejemplo: **FO** y dime por qué en 1–2 líneas."
            );

            const resBS = await getBrainstormState();
            const exists = resBS.ok && resBS.payload?.exists;

            if (!exists) {
              const initial: BrainstormState = { strategy: null, problem: null, ideas: [], minIdeas: 10 };
              setBrainstormState(initial);
              await saveBrainstormState(initial, effectiveChatId);
            } else {
              const existing = (resBS.payload?.state ?? null) as BrainstormState | null;
              if (existing) setBrainstormState(existing);
            }

            setFodaState(null);
            await clearStageState(2, effectiveChatId);

            return;
          }
        }

        // ETAPA 2: FODA en progreso (con IA)
        if (fodaState && ctx.ok && ctx.status === "confirmed" && diagUnlocked) {
          const assistant = await callFodaAssistant({
            studentMessage: text,
            fodaState,
            caseContext: ctx.contextJson,
          });

          if (!assistant.ok || !assistant.payload?.assistantMessage || !assistant.payload?.updates?.nextState) {
            await appendAssistant(
              "⚠️ No pude evaluar tu respuesta con claridad. ¿Puedes reformularla con un ejemplo concreto del proceso?"
            );
            return;
          }

          const nextState = assistant.payload.updates.nextState as FodaState;
          const action = assistant.payload.updates?.action as string | undefined;

          // 1) mostrar respuesta “docente”
          await appendAssistant(assistant.payload.assistantMessage);

          // 2) aplicar estado y guardar
          setFodaState(nextState);
          await saveFodaState(nextState);

          // 3) ✅ Si ya está completo (o el LLM lo marca como complete) → VALIDAR y saltar a Etapa 3
          const completed = action === "complete" || isFodaComplete(nextState);

          if (completed) {
            const v = await validateFoda();

            if (!v?.ok) {
              // Si no valida, NO avanzamos. Pedimos completar lo faltante.
              const msg =
                v?.payload?.message ??
                "⚠️ Aún no puedo validar el FODA. Revisa que haya 3 puntos en cada cuadrante y sustento en O/A.";
              await appendAssistant(msg);
              return;
            }

            await appendAssistant(
              "✅ **Etapa 2 (FODA) validada**.\n\n" +
              "Ahora pasamos automáticamente a la **Etapa 3: Lluvia de ideas (causas)**.\n\n" +
              "✅ Primero elige tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
              "👉 Escribe por ejemplo: **FO** y dime por qué en 1–2 líneas."
            );

            // Iniciar o retomar Brainstorm
            const resBS = await getBrainstormState();
            const exists = resBS.ok && resBS.payload?.exists;

            if (!exists) {
              const initial: BrainstormState = {
                strategy: null,
                problem: null,
                ideas: [],
                minIdeas: 10,
              };

              setBrainstormState(initial);
              await saveBrainstormState(initial, effectiveChatId);

              setFodaState(null);
              await clearStageState(2, effectiveChatId);

              await appendAssistant(
                "✅ Antes de definir la problemática, dime tu **estrategia obligatoria**: **FO / DO / FA / DA**.\n" +
                "👉 Escribe por ejemplo: **FO** y dime por qué en 1–2 líneas."
              );

              return;
            }

            const existing = (resBS.payload?.state ?? null) as BrainstormState | null;
            if (existing) {
              setBrainstormState(existing);
              const n = Array.isArray(existing.ideas) ? existing.ideas.length : 0;

              setFodaState(null);
              await clearStageState(2, effectiveChatId);

              await appendAssistant(
                `📌 Retomemos tu **Etapa 3 (Lluvia de ideas)**.\n\n` +
                  `Problema: ${existing.problem?.text ? `**${existing.problem.text}**` : "**(aún no definido)**"}\n` +
                  `Ideas registradas: **${n}**.\n\n` +
                  "👉 Continúa con la siguiente causa."
              );

              return;
            }
          }

          return; // importante: ya atendimos FODA
        }


        if (ctx.ok && ctx.status === "confirmed" && effectiveChatId) {
          const restored = await restoreLatestAdvisorStageToNewChat(effectiveChatId);
          if (restored) return;
        }


        // 1) Si ya está confirmado: recién llamamos /api/plans/review
        const body: any = { text };
        if (effectiveChatId) body.chatId = effectiveChatId;

        // Si está confirmado pero el usuario solo saluda, NO revisamos plan
        if (isGreetingOrSmallTalk(text)) {
          setMessages((prev) => [
            ...prev,
            createMessage(
              "assistant",
              "¡Hola! 👋 Ya tengo tu **Contexto del Caso** registrado.\n\n👉 Cuéntame: ¿quieres continuar con el **Diagnóstico (Etapa 1)** o revisar tu **Avance 1**?"
            ),
          ]);
          return;
        }

        const intent = detectStage0Intent(text);

        const st = await getProductivityState(chatIdRef.current);
        const hasWizard = st.ok && st.payload?.exists && st.payload?.state?.prodStep > 0;


        // ✅ Si acabamos de confirmar Etapa 0: arrancar Productividad (Etapa 1) sin /review
        if (ctx.ok && ctx.status === "confirmed" && !hasWizard && isAwaitingStage1Start(clientId)) {
          // si el usuario pregunta (no robótico), respondemos y re-preguntamos el paso actual
          if (isProdQuestion(text) && !isReadyIntent(text)) {
            // Aquí puedes contestar “manual” (sin LLM) o si quieres,
            // puedes llamar /api/chat para explicación. Por ahora lo dejamos manual:
            setMessages((prev) => [
              ...prev,
              createMessage(
                "assistant",
                "Claro 🙂 En esta parte solo validamos **ingresos del mes** y **costos del mes** " +
                  "para una línea específica (ej: Yogurt). Productividad se puede completar más adelante; ahora podemos continuar con FODA.\n\n" +
                  "Sigamos:"
              ),
              createMessage("assistant", promptProd(1, ctx.contextJson, prodDraft)),
            ]);
            setProdStep(1);
            return;
          }

          // Si escribe "productividad", iniciar Etapa 1
          if (text.toLowerCase().includes("productividad")) {
            setAwaitingStage1Start(clientId, false);

            const products = Array.isArray(ctx.contextJson?.products)
              ? ctx.contextJson.products.filter(Boolean)
              : [];
            const autoLine = products.length === 1 ? String(products[0]) : undefined;

            setProdDraft({ line: autoLine, required_costs: 3 });
            setProdStep(1);

            setMessages((prev) => [
              ...prev,
              createMessage("assistant", promptProd(1, ctx.contextJson, { line: autoLine })),
            ]);
            return;
          }

          // Si escribe "ok / listo / vamos" iniciar FODA (Etapa 2)
          if (isReadyIntent(text)) {
            setAwaitingStage1Start(clientId, false);

            const initial: FodaState = {
              currentQuadrant: "F",
              items: {
                F: [],
                D: [],
                O: [],
                A: [],
              },
            };

            setFodaState(initial);
            await saveFodaState(initial, effectiveChatId);

            await appendAssistant(
              "Perfecto 👍 Iniciamos **Etapa 2: Análisis FODA**.\n\n" +
              "Empezamos con **Fortalezas (internas)**.\n\n" +
              "Dime una fortaleza real del proceso o área que analizas."
            );
            return;
          }

          // si no confirmó, pedimos confirmación para iniciar productividad
          setMessages((prev) => [
            ...prev,
            createMessage(
              "assistant",
              "Antes de avanzar necesito tu confirmación para iniciar **Productividad mensual**.\n\n" +
                "Responde **ok / listo / vamos**."
            ),
          ]);
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
              const issues = validated?.data?.details?.issues;
              const score = validated?.data?.details?.score;

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

            const score = validated?.data?.score;

            await appendAssistant(
              "✅ **Reporte de Productividad validado**\n\n" +
                "Cumple coherencia y claridad de datos.\n" +
                "\n👉 Ahora sí puedes continuar con el Diagnóstico (Etapa 2)."
            );

            await clearProductivityState();

            setProdStep(0);
            setProdDraft({});
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
        setStage0Step(0);
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
        if (saveBrainstormTimerRef.current) window.clearTimeout(saveBrainstormTimerRef.current);
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
      window.sessionStorage.removeItem(`optia-chat-id-${clientId}-${m}`);
      window.sessionStorage.removeItem(`optia-messages-${clientId}-${m}`);
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

    // Solo se permite upload en Etapa 10 cuando está esperando documento (v1) o pidiendo v2
    if (!finalDocState || !isFinalDocReadyForUpload(finalDocState)) {
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
      const versionNumber = finalDocState.versionNumber;

      const a = await callFinalDocAssistant({
        effectiveChatId,
        fileName: file.name,
        storagePath,
        extractedText,
        versionNumber,
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
          onSelectChat={(id, pickedMode) => {
            // 1) set modo del chat seleccionado
            const m = (pickedMode === "plan_mejora" ? "plan_mejora" : "general");
            modeRef.current = m;
            chatIdRef.current = id;
            setMode(m);
            setChatId(id);
            setShowHoursInline(false);
            setStage0Step(0);
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
      <div className="flex items-center justify-between mb-3 text-[11px] text-[color:var(--muted)]">
        {/* Bloque: 3 rayas + logo + título */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-1 rounded-full p-2 text-base transition-colors
            text-[color:var(--foreground)] hover:bg-[color:var(--surface)]"
          >
            ☰
          </button>

          <Image src="/logo-opt.png" alt="Logo OPT-IA" width={28} height={28} className="rounded-full" />

          <div className="flex flex-col">
            <span className="text-xs font-semibold text-[color:var(--foreground)]">OPT-IA</span>
            <span className="text-[11px] text-[color:var(--muted)]">Asistente para estudiantes</span>
          </div>
        </div>

        {/* Usuario + logout + theme */}
        <div className="flex items-center gap-2 mr-4">
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-full p-2 hover:bg-[color:var(--surface)] transition-colors"
            title={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
            aria-label="Cambiar tema"
          >
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>

          <span className="hidden sm:inline text-[14px] text-[color:var(--muted)]">{displayName}</span>
        </div>

      </div>

      {/* Selector de modo */}
      <div className="mb-0 flex flex-wrap gap-2 text-[11px]">
        <span className="mt-1 mr-2 text-[color:var(--muted)]">Modo:</span>

        <button
          type="button"
          onClick={() => {
            if (mode === "general") return;
            setShowHoursInline(false);
            modeRef.current = "general";
            setMode("general");
          }}
          className={`px-3 py-1 rounded-full border text-xs transition ${
            mode === "general"
              ? "bg-[color:var(--primary)] border-[color:var(--primary)] text-[color:var(--primary-foreground)]"
              : "bg-transparent border-[color:var(--border)] text-[color:var(--muted)] hover:bg-[color:var(--surface)]"
          }`}
        >
          Asistente general
        </button>

        <button
          type="button"
          onClick={() => {
            if (mode === "plan_mejora") return;
            setShowHoursInline(false);
            modeRef.current = "plan_mejora";
            setMode("plan_mejora");
          }}
          className={`px-3 py-1 rounded-full border text-xs transition ${
            mode === "plan_mejora"
              ? "bg-[color:var(--primary)] border-[color:var(--primary)] text-[color:var(--primary-foreground)]"
              : "bg-transparent border-[color:var(--border)] text-[color:var(--muted)] hover:bg-[color:var(--surface)]"
          }`}
        >
          Asesor de Plan de Mejora
        </button>
      </div>

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
                mode === "plan_mejora" &&
                canInteract &&
                finalDocState &&
                isFinalDocReadyForUpload(finalDocState)
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
