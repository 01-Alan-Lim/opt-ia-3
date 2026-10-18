// src/app/chat/_lib/advisorApi.ts
//
// Transporte HTTP del chat y del Asesor de Plan de Mejora (src/app/chat/page.tsx): un wrapper por
// endpoint, con la misma URL, método, headers, body y lectura de la respuesta que tenía cada
// función de page.tsx. No decide nada: page.tsx resuelve antes los headers (getAuthHeaders), el
// chat activo y el historial reciente, y decide qué hacer con la respuesta. La identidad la
// resuelve el servidor con el Bearer; aquí no se envía ni se confía en ningún userId.

import type { BrainstormState } from "@/lib/plan/brainstormFlow";
import {
  normalizeParetoStateClient,
  type FodaState,
  type ImprovementState,
  type ObjectivesState,
  type ParetoState,
  type PlanningState,
  type ProdAssistantResponse,
  type ProductivityDraft,
  type ProgressState,
} from "@/lib/plan/advisorStates";
import { readSignedAssistantReply } from "@/lib/chat/signedAssistantReply";

type AuthHeaders = Record<string, string>;
export async function getActiveAdvisorStage(authHeaders: AuthHeaders) {
  const res = await fetch("/api/plans/active-stage", {
    headers: { ...authHeaders },
  });

  const json = await res.json().catch(() => null);
  const isOk = res.ok && json?.ok !== false;
  const payload = json?.data ?? null;
  const error = !isOk && json && json.ok === false ? json : null;

  return {
    ok: isOk,
    status: res.status,
    payload,
    error,
  };
}

export async function persistMessageDB(authHeaders: AuthHeaders, input: { chatId: string; role: "user" | "assistant" | "system"; content: string }) {
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

export async function interpretStage0WithLLM(authHeaders: AuthHeaders, step: 1 | 2 | 3, userText: string, ctxJson: unknown) {
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

export async function getPlanContextStatus(authHeaders: AuthHeaders) {
  const res = await fetch("/api/plans/context", { headers: { ...authHeaders } });

  const json = await res.json().catch(() => null);
  const ctxOk = res.ok && json?.ok !== false;
  const ctxPayload = json?.data ?? json;
  const message =
    typeof ctxPayload?.message === "string"
      ? ctxPayload.message
      : typeof ctxPayload?.error === "string"
        ? ctxPayload.error
        : null;

  return {
    ok: ctxOk,
    status: (ctxPayload?.status ?? "draft") as "draft" | "confirmed",
    exists: Boolean(ctxPayload?.exists),
    chatId: (ctxPayload?.chatId ?? null) as string | null,
    contextJson: (ctxPayload?.contextJson ?? {}) as any,
    contextText: (ctxPayload?.contextText ?? null) as string | null,
    message,
  };
}

export async function getProductivityState(authHeaders: AuthHeaders, currentChatId?: string | null) {
  const qs = currentChatId ? `?chatId=${encodeURIComponent(currentChatId)}` : "";
  const res = await fetch(`/api/plans/productivity/state${qs}`, {
    headers: { ...authHeaders },
  });

  const json = await res.json().catch(() => null);
  const okk = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok: okk, payload };
}

export async function saveProductivityState(authHeaders: AuthHeaders, state: { prodStep: number; prodDraft: unknown }, currentChatId?: string | null) {
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

export async function clearProductivityState(authHeaders: AuthHeaders) {
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

export async function getLastProductivityReport(authHeaders: AuthHeaders) {
  const res = await fetch("/api/plans/productivity", {
    method: "GET",
    headers: { ...authHeaders },
  });

  const data = await res.json().catch(() => null);
  const ok = res.ok && data?.ok === true;

  const payload = ok && data?.data?.exists === false ? null : (ok ? data.data : null);

  return { ok, payload };
}

export async function confirmPlanContext(authHeaders: AuthHeaders) {
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

export async function saveProductivity(authHeaders: AuthHeaders, payload: unknown, chatId?: string | null) {
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

export async function validateProductivity(authHeaders: AuthHeaders, period: string) {
  const res = await fetch("/api/plans/productivity/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ period }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;

  return {
    ok,
    status: res.status,
    ...(json ?? {}),
  };
}

export async function callProductivityAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; prodStep: number; prodDraft: ProductivityDraft; caseContext: unknown }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/productivity/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: input.studentMessage,
      prodStep: input.prodStep,
      prodDraft: input.prodDraft,
      caseContext: input.caseContext ?? {},
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const okk = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;

  return { ok: okk, payload: payload as ProdAssistantResponse, signedReply: readSignedAssistantReply(okk, payload, chatId) };
}

export async function getFodaState(authHeaders: AuthHeaders, effectiveChatId: string | null) {
  const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

  const res = await fetch(`/api/plans/foda/state${qs}`, {
    headers: { ...authHeaders },
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function saveFodaState(authHeaders: AuthHeaders, state: FodaState, effectiveChatId: string) {
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

export async function callFodaAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; fodaState: FodaState; caseContext: unknown }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/foda/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: input.studentMessage,
      fodaState: input.fodaState,
      caseContext: input.caseContext ?? {},
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;

  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function getBrainstormState(authHeaders: AuthHeaders, effectiveChatId: string | null) {
  const qs = effectiveChatId ? `?chatId=${encodeURIComponent(effectiveChatId)}` : "";

  const res = await fetch(`/api/plans/brainstorm/state${qs}`, {
    headers: { ...authHeaders },
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload };
}

export async function saveBrainstormState(authHeaders: AuthHeaders, state: BrainstormState, effectiveChatId: string) {
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

export async function validateFoda(authHeaders: AuthHeaders, effectiveChatId: string | null) {
  const res = await fetch("/api/plans/foda/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: effectiveChatId }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function callBrainstormAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; brainstormState: BrainstormState; caseContext: unknown; stage1Summary: unknown; fodaSummary: unknown }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/brainstorm/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: input.studentMessage,
      brainstormState: input.brainstormState,
      caseContext: input.caseContext ?? {},
      stage1Summary: input.stage1Summary ?? null,
      fodaSummary: input.fodaSummary ?? null,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function validateBrainstorm(authHeaders: AuthHeaders, chatId: string | null) {
  const res = await fetch("/api/plans/brainstorm/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function getIshikawaState(authHeaders: AuthHeaders, effectiveChatId: string) {
  const qs = `?chatId=${encodeURIComponent(effectiveChatId)}`;

  const res = await fetch(`/api/plans/ishikawa/state${qs}`, {
    headers: { ...authHeaders },
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload };
}

export async function validateIshikawa(authHeaders: AuthHeaders, chatId: string | null) {
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

export async function saveParetoState(authHeaders: AuthHeaders, normalizedState: ParetoState, effectiveChatId: string) {
  const res = await fetch("/api/plans/pareto/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ state: normalizedState, chatId: effectiveChatId }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;

  if (!ok) console.warn("[PARETO] save state failed", { status: res.status, json });
  return { ok };
}

export async function callParetoAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; paretoState: ParetoState; caseContext: Record<string, unknown> | null }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/pareto/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: input.studentMessage,
      paretoState: normalizeParetoStateClient(input.paretoState),
      caseContext: input.caseContext ?? null,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function validatePareto(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/pareto/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function getGenericStageState(authHeaders: AuthHeaders, stage: number, args?: { chatId?: string | null; latest?: boolean }) {
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

export async function saveGenericStageState(authHeaders: AuthHeaders, stage: number, stateJson: Record<string, unknown>, cid: string) {
  const res = await fetch("/api/plans/stage-state", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId: cid,
      stage,
      stateJson,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;

  if (!ok) {
    console.error(`[STAGE ${stage}] save state failed`, { status: res.status, json });
  }

  return { ok, payload };
}

export async function clearStageState(authHeaders: AuthHeaders, stage: number, cid: string) {
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

export async function callObjectivesAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; objectivesState: ObjectivesState; caseContext: Record<string, unknown> | null }, cid: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/objectives/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId: cid,
      studentMessage: input.studentMessage,
      objectivesState: input.objectivesState,
      caseContext: input.caseContext ?? null,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, cid) };
}

export async function validateObjectives(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/objectives/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function callImprovementAssistant(authHeaders: AuthHeaders, input: { studentMessage: string; improvementState: ImprovementState; caseContext: Record<string, unknown> | null }, cid: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/improvement/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId: cid,
      studentMessage: input.studentMessage,
      improvementState: input.improvementState,
      caseContext: input.caseContext ?? null,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, cid) };
}

export async function validateImprovement(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/improvement/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function callPlanningAssistant(authHeaders: AuthHeaders, args: { studentMessage: string; planningState: PlanningState; caseContext: unknown }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/planning/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: args.studentMessage,
      planningState: args.planningState as any,
      caseContext: args.caseContext ?? null,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function validatePlanning(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/planning/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  return { ok, payload: json };
}

export async function callProgressAssistant(authHeaders: AuthHeaders, args: { studentMessage: string; progressState: ProgressState }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/progress/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      studentMessage: args.studentMessage,
      progressState: args.progressState,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;

  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function validateProgress(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/progress/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.ok !== false, payload: json };
}

export async function callFinalDocAssistant(authHeaders: AuthHeaders, args: { fileName: string; storagePath: string; extractedText: string }, chatId: string | null, recentHistory: string) {
  const res = await fetch("/api/plans/final_doc/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      chatId,
      fileName: args.fileName,
      storagePath: args.storagePath,
      extractedText: args.extractedText,
      recentHistory,
    }),
  });

  const json = await res.json().catch(() => null);
  const ok = res.ok && json?.ok !== false;
  const payload = json?.data ?? json;
  return { ok, payload, signedReply: readSignedAssistantReply(ok, payload, chatId) };
}

export async function validateFinalDoc(authHeaders: AuthHeaders, cid: string | null) {
  const res = await fetch("/api/plans/final_doc/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ chatId: cid }),
  });

  const json = await res.json().catch(() => null);
  return { ok: res.ok && json?.ok !== false, payload: json };
}
