// src/app/api/plans/pareto/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import {
  mergeParetoCriteriaMonotonic,
  mergeParetoStringListMonotonic,
} from "@/lib/plan/paretoParsing";

export const runtime = "nodejs";

const STAGE = 5;
const LEGACY_ARTIFACT_TYPE = "pareto_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

const PARETO_STEP_VALUES = [
  "select_roots",
  "define_criteria",
  "set_weights",
  "excel_work",
  "collect_critical",
  "done",
] as const;

type ParetoStep = (typeof PARETO_STEP_VALUES)[number];

type ParetoCriterion = {
  id: string;
  name: string;
  weight?: number;
};

type ParetoState = {
  roots: string[];
  selectedRoots: string[];
  criteria: ParetoCriterion[];
  criticalRoots: string[];
  minSelected: number;
  maxSelected: number;
  step: ParetoStep;
};

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: z.unknown(),
});

const QuerySchema = z.object({
  chatId: z.string().uuid().optional(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  if (detail !== undefined && detail !== null) {
    console.error(`[plans] ${code}: ${message}`, detail);
  }
  return NextResponse.json({ ok: false, code, message, detail: null }, { status });
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function normalizeWeight(input: unknown): number | undefined {
  const n = Number(input);
  if (!Number.isFinite(n)) return undefined;
  if (n < 1 || n > 10) return undefined;
  return n;
}

const LEGACY_AUTO_CRITERIA_KEYS = [
  "impacto",
  "frecuencia",
  "controlabilidad",
] as const;

function normalizeCriterionKey(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLegacyAutoCriteria(criteria: ParetoCriterion[]) {
  if (criteria.length !== 3) return false;

  const names = criteria.map((item) => normalizeCriterionKey(item.name)).sort();
  const expected = [...LEGACY_AUTO_CRITERIA_KEYS].sort();

  const sameNames = names.every((value, index) => value === expected[index]);

  const hasAnyWeight = criteria.some((item) => {
    const weight = Number(item.weight);
    return Number.isFinite(weight) && weight >= 1 && weight <= 10;
  });

  return sameNames && !hasAnyWeight;
}

function normalizeCriteria(input: unknown): ParetoCriterion[] {
  const raw = Array.isArray(input) ? input : [];

  const criteria = raw
    .map((item) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};

      const name = String(record.name ?? "").trim();
      const id = String(record.id ?? "").trim() || crypto.randomUUID();
      const weight = normalizeWeight(record.weight);

      if (!name) return null;

      return {
        id,
        name,
        ...(weight !== undefined ? { weight } : {}),
      };
    })
    .filter((item): item is ParetoCriterion => Boolean(item))
    .slice(0, 3);

  return isLegacyAutoCriteria(criteria) ? [] : criteria;
}

function hasThreeCriteria(state: ParetoState) {
  return (
    Array.isArray(state.criteria) &&
    state.criteria.length >= 3 &&
    state.criteria.slice(0, 3).every((criterion) => criterion.name.trim().length > 3)
  );
}

function hasWeights(state: ParetoState) {
  return (
    hasThreeCriteria(state) &&
    state.criteria.slice(0, 3).every((criterion) => {
      const weight = Number(criterion.weight);
      return Number.isFinite(weight) && weight >= 1 && weight <= 10;
    })
  );
}

function ceil20Percent(n: number) {
  return Math.max(1, Math.ceil(n * 0.2));
}

function resolveParetoStepFromState(state: ParetoState): ParetoStep {
  const selectedCount = Array.isArray(state.selectedRoots) ? state.selectedRoots.length : 0;
  const minSelected =
    Number.isFinite(state.minSelected) && state.minSelected > 0 ? state.minSelected : 10;
  const maxSelected =
    Number.isFinite(state.maxSelected) && state.maxSelected >= minSelected
      ? state.maxSelected
      : 15;

  if (selectedCount < minSelected || selectedCount > maxSelected) return "select_roots";
  if (!hasThreeCriteria(state)) return "define_criteria";
  if (!hasWeights(state)) return "set_weights";

  const minCritical = ceil20Percent(selectedCount);
  if (state.criticalRoots.length >= minCritical) return "done";
  if (state.criticalRoots.length > 0) return "collect_critical";

  return state.step === "collect_critical" || state.step === "excel_work"
    ? state.step
    : "excel_work";
}

function normalizeStep(input: unknown): ParetoStep {
  const raw = String(input ?? "").trim();

  if ((PARETO_STEP_VALUES as readonly string[]).includes(raw)) {
    return raw as ParetoStep;
  }

  const legacyMap: Record<string, ParetoStep> = {
    init: "select_roots",
    start: "select_roots",
    roots: "select_roots",
    select: "select_roots",
    criteria: "define_criteria",
    define: "define_criteria",
    weights: "set_weights",
    weight: "set_weights",
    excel: "excel_work",
    critical: "collect_critical",
    critical_roots: "collect_critical",
    review: "collect_critical",
    finished: "done",
    final: "done",
  };

  return legacyMap[raw] ?? "select_roots";
}

function normalizePositiveInt(input: unknown, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : fallback;
}

function normalizeParetoState(input: unknown): ParetoState {
  const source =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const roots = dedupeStrings(asStringArray(source.roots));
  const minSelected = normalizePositiveInt(source.minSelected, 10);
  const maxSelectedRaw = normalizePositiveInt(source.maxSelected, 15);
  const maxSelected = Math.max(minSelected, maxSelectedRaw);

  const selectedRootsRaw = asStringArray(source.selectedRoots);
  const selectedRootsBase =
    selectedRootsRaw.length > 0 ? selectedRootsRaw : roots.slice(0, maxSelected);

  const rootsSet = new Set(roots.map((item) => item.toLowerCase()));
  const selectedRoots = dedupeStrings(
    selectedRootsBase.filter((item) => rootsSet.size === 0 || rootsSet.has(item.toLowerCase()))
  ).slice(0, maxSelected);

  const selectedSet = new Set(selectedRoots.map((item) => item.toLowerCase()));
  const criticalRoots = dedupeStrings(asStringArray(source.criticalRoots)).filter((item) =>
    selectedSet.size === 0 ? true : selectedSet.has(item.toLowerCase())
  );

  return {
    roots,
    selectedRoots,
    criteria: normalizeCriteria(source.criteria),
    criticalRoots,
    minSelected,
    maxSelected,
    step: normalizeStep(source.step),
  };
}

function normalizeRootKey(input: string) {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadOfficialIshikawaRoots(
  userId: string,
  preferredChatId: string | null
) {
  const result = await loadLatestValidatedArtifact({
    userId,
    preferredChatId,
    stage: 4,
    artifactType: "ishikawa_final",
    periodKey: PERIOD_KEY,
  });

  if (!result.ok) {
    throw new Error("No se pudo leer Ishikawa final para sanear Pareto.");
  }

  const rawRoots = Array.isArray(result.row?.payload?.roots)
    ? result.row?.payload?.roots
    : [];

  return dedupeStrings(
    rawRoots.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
  );
}

function sanitizeParetoStateWithOfficialRoots(
  state: ParetoState,
  officialRoots: string[]
): ParetoState {
  if (officialRoots.length === 0) return state;

  const officialSet = new Set(officialRoots.map((item) => normalizeRootKey(item)));

  const selectedRoots = dedupeStrings(
    state.selectedRoots.filter((item) => officialSet.has(normalizeRootKey(item)))
  ).slice(0, state.maxSelected);

  const selectedSet = new Set(selectedRoots.map((item) => normalizeRootKey(item)));

  const criticalRoots = dedupeStrings(
    state.criticalRoots.filter((item) => selectedSet.has(normalizeRootKey(item)))
  );

  return {
    ...state,
    roots: officialRoots,
    selectedRoots,
    criticalRoots,
    step: resolveParetoStepFromState({
      ...state,
      roots: officialRoots,
      selectedRoots,
      criticalRoots,
    }),
  };
}

function mergeParetoState(baseRaw: unknown, incomingRaw: unknown): ParetoState {
  const base = normalizeParetoState(baseRaw);
  const incoming =
    typeof incomingRaw === "object" && incomingRaw !== null
      ? (incomingRaw as Record<string, unknown>)
      : {};

  const incomingState = normalizeParetoState(incoming);
  const merged = normalizeParetoState({
    roots: mergeParetoStringListMonotonic(base.roots, incomingState.roots),
    selectedRoots: mergeParetoStringListMonotonic(base.selectedRoots, incomingState.selectedRoots),
    criteria: mergeParetoCriteriaMonotonic(base.criteria, incomingState.criteria, {
      createId: () => crypto.randomUUID(),
    }),
    criticalRoots: mergeParetoStringListMonotonic(base.criticalRoots, incomingState.criticalRoots),
    minSelected: hasOwn(incoming, "minSelected") ? incoming.minSelected : base.minSelected,
    maxSelected: hasOwn(incoming, "maxSelected") ? incoming.maxSelected : base.maxSelected,
    step: hasOwn(incoming, "step") ? incoming.step : base.step,
  });

  return {
    ...merged,
    step: resolveParetoStepFromState(merged),
  };
}

async function assertChatOwner(userId: string, chatId: string) {
  const { data: chatRow, error: chatErr } = await supabaseServer
    .from("chats")
    .select("id, client_id")
    .eq("id", chatId)
    .single();

  if (chatErr || !chatRow) {
    return { ok: false as const, status: 404, message: "Chat no encontrado." };
  }

  if (chatRow.client_id !== userId) {
    return { ok: false as const, status: 403, message: "No tienes acceso a este chat." };
  }

  return { ok: true as const };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const parsed = QuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams)
    );
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", "Query inválida.");
    }

    const requestedChatId = parsed.data.chatId ?? null;

    if (requestedChatId) {
      const access = await assertChatOwner(user.userId, requestedChatId);
      if (!access.ok) {
        return fail(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message);
      }
    }

    let stateRow: {
      state_json: Record<string, unknown> | null;
      chat_id: string | null;
      updated_at: string | null;
    } | null = null;

    if (requestedChatId) {
      const direct = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .maybeSingle();

      if (direct.error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto.", direct.error);
      stateRow = direct.data ?? null;
    }

    if (!stateRow && !requestedChatId) {
      const latest = await supabaseServer
        .from("plan_stage_states")
        .select("state_json, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) return fail(500, "DB_ERROR", "No se pudo leer el estado de Pareto.", latest.error);
      stateRow = latest.data ?? null;
    }

    if (stateRow?.state_json) {
      return NextResponse.json(
        {
          ok: true,
          exists: true,
          chatId: stateRow.chat_id ?? null,
          state: sanitizeParetoStateWithOfficialRoots(
            normalizeParetoState(stateRow.state_json),
            await loadOfficialIshikawaRoots(user.userId, stateRow.chat_id ?? requestedChatId ?? null)
          ),
          updatedAt: stateRow.updated_at ?? null,
          source: "stage_state",
        },
        { status: 200 }
      );
    }

    let legacyRow: {
      payload: Record<string, unknown> | null;
      chat_id: string | null;
      updated_at: string | null;
    } | null = null;

    if (requestedChatId) {
      const legacyDirect = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .eq("artifact_type", LEGACY_ARTIFACT_TYPE)
        .eq("period_key", PERIOD_KEY)
        .maybeSingle();

      if (legacyDirect.error) return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Pareto.", legacyDirect.error);
      legacyRow = legacyDirect.data ?? null;
    }

    if (!legacyRow && !requestedChatId) {
      const legacyLatest = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", LEGACY_ARTIFACT_TYPE)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (legacyLatest.error) return fail(500, "DB_ERROR", "No se pudo leer el estado legacy de Pareto.", legacyLatest.error);
      legacyRow = legacyLatest.data ?? null;
    }

    if (!legacyRow?.payload) {
      return NextResponse.json({ ok: true, exists: false }, { status: 200 });
    }

    return NextResponse.json(
      {
        ok: true,
        exists: true,
        chatId: legacyRow.chat_id ?? null,
        state: sanitizeParetoStateWithOfficialRoots(
          normalizeParetoState(legacyRow.payload),
          await loadOfficialIshikawaRoots(user.userId, legacyRow.chat_id ?? requestedChatId ?? null)
        ),
        updatedAt: legacyRow.updated_at ?? null,
        source: "legacy_artifact",
      },
      { status: 200 }
    );
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return fail(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
      );
    }

    if (err instanceof z.ZodError) {
      return fail(400, "BAD_REQUEST", "Payload inválido.", err.flatten());
    }

    return fail(500, "INTERNAL", "Error interno.");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) return fail(403, "FORBIDDEN", gate.message);

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, "BAD_REQUEST", "Payload inválido.");
    }

    const { chatId, state } = parsed.data;

    if (!chatId) return NextResponse.json({ ok: true, skipped: true }, { status: 200 });

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return fail(access.status, access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", access.message);
    }

    const existing = await supabaseServer
      .from("plan_stage_states")
      .select("state_json")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (existing.error) {
      return fail(500, "DB_ERROR", "No se pudo leer el estado actual de Pareto.", existing.error);
    }

    const officialRoots = await loadOfficialIshikawaRoots(user.userId, chatId);

    const mergedState = sanitizeParetoStateWithOfficialRoots(
      mergeParetoState(existing.data?.state_json ?? null, state),
      officialRoots
    );

    const { error } = await supabaseServer
      .from("plan_stage_states")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          state_json: mergedState,
        },
        { onConflict: "user_id,chat_id,stage" }
      );

    if (error) return fail(500, "DB_ERROR", "No se pudo guardar el estado de Pareto (Etapa 5).", error);

    return NextResponse.json({ ok: true, saved: true, state: mergedState }, { status: 200 });
    } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return fail(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return fail(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación."
      );
    }

    if (err instanceof z.ZodError) {
      return fail(400, "BAD_REQUEST", "Payload inválido.", err.flatten());
    }

    return fail(500, "INTERNAL", "Error interno.");
  }
}
