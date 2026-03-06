// src/app/api/plans/ishikawa/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

const STAGE = 4;
const DraftType = "ishikawa_wizard_state";
const PERIOD_KEY = getPeriodKeyLaPaz();

// ✅ Reglas globales nuevas (tu pantalla)
const RULES = {
  minCategories: 3,
  minMainCausesPerCategory: 2,
  minSubCausesPerMain: 1,
  maxWhyDepth: 3,
  minRootCandidates: 3 * 2,
};

function applyStage4Rules(out: any) {
  if (!out || typeof out !== "object") return out;
  out.minCategories = RULES.minCategories;
  out.minRootCandidates = RULES.minRootCandidates;
  out.minMainCausesPerCategory = RULES.minMainCausesPerCategory;
  out.minSubCausesPerMain = RULES.minSubCausesPerMain;
  out.maxWhyDepth = RULES.maxWhyDepth;
  return out;
}

const BodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  state: z.any(),
});

const QuerySchema = z.object({
  // chatId es opcional: si no coincide (por ejemplo, nuevo chat), retomamos el último estado del periodo.
  chatId: z.string().uuid().optional(),
});

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

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", message: gate.message }, { status: 403 });
    }

    const parsed = QuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    const requestedChatId = parsed.chatId ?? null;

    if (requestedChatId) {
      const access = await assertChatOwner(user.userId, requestedChatId);
      if (!access.ok) {
        return NextResponse.json(
          { ok: false, code: access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: access.message },
          { status: access.status }
        );
      }
    }

    // 1) Fuente principal: plan_stage_states
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

      if (direct.error) {
        return NextResponse.json(fail("BAD_REQUEST", direct.error.message), { status: 400 });
      }

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

      if (latest.error) {
        return NextResponse.json(fail("BAD_REQUEST", latest.error.message), { status: 400 });
      }

      stateRow = latest.data ?? null;
    }

    if (stateRow?.state_json) {
      const compacted = compactIshikawaState(stateRow.state_json);
      return ok({
        exists: true,
        state: compacted,
        updatedAt: stateRow.updated_at,
        chatId: stateRow.chat_id ?? null,
        source: "stage_state",
      });
    }

    // 2) Compatibilidad temporal: fallback legacy
    let legacyRow: {
      payload: Record<string, unknown> | null;
      chat_id: string | null;
      updated_at: string | null;
      status?: string | null;
    } | null = null;

    if (requestedChatId) {
      const legacyDirect = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at, status")
        .eq("user_id", user.userId)
        .eq("chat_id", requestedChatId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .maybeSingle();

      if (legacyDirect.error) {
        return NextResponse.json(fail("BAD_REQUEST", legacyDirect.error.message), { status: 400 });
      }

      legacyRow = legacyDirect.data ?? null;
    }

    if (!legacyRow && !requestedChatId) {
      const legacyLatest = await supabaseServer
        .from("plan_stage_artifacts")
        .select("payload, chat_id, updated_at, status")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (legacyLatest.error) {
        return NextResponse.json(fail("BAD_REQUEST", legacyLatest.error.message), { status: 400 });
      }

      legacyRow = legacyLatest.data ?? null;
    }

    if (!legacyRow?.payload) return ok({ exists: false });

    const compacted = compactIshikawaState(legacyRow.payload);

    return ok({
      exists: true,
      state: compacted,
      updatedAt: legacyRow.updated_at,
      chatId: legacyRow.chat_id ?? null,
      status: legacyRow.status ?? null,
      source: "legacy_artifact",
    });
  } catch (e: any) {
    return NextResponse.json(fail("INTERNAL", e?.message ?? "Error"), { status: 500 });
  }
}


function mergeById<T extends { id: string }>(base: T[] = [], incoming: T[] = []): T[] {
  const map = new Map<string, T>();
  for (const b of base) map.set(b.id, b);

  for (const inc of incoming) {
    const prev = map.get(inc.id);
    map.set(inc.id, prev ? ({ ...prev, ...inc } as T) : inc);
  }

  return Array.from(map.values());
}

function mergeIshikawaState(base: any, incoming: any) {
  if (!base) return incoming;
  if (!incoming) return base;

  const out: any = { ...base, ...incoming };
  applyStage4Rules(out);

  // 1) NO permitir que el problema se pierda si incoming no lo trae
  const incomingProblemMissing =
    incoming.problem == null ||
    incoming.problem === "" ||
    (typeof incoming.problem === "object" && !incoming.problem?.text);

  if (incomingProblemMissing) out.problem = base.problem;

  // 2) merge categories -> mainCauses -> subCauses y preservar whys
  out.categories = mergeById(base.categories ?? [], incoming.categories ?? []).map((cat: any) => {
    const baseCat = (base.categories ?? []).find((c: any) => c.id === cat.id) ?? {};
    const incCat = (incoming.categories ?? []).find((c: any) => c.id === cat.id) ?? cat;

    const mergedCat: any = { ...baseCat, ...incCat };

    mergedCat.mainCauses = mergeById(baseCat.mainCauses ?? [], incCat.mainCauses ?? []).map((mc: any) => {
      const baseMc = (baseCat.mainCauses ?? []).find((m: any) => m.id === mc.id) ?? {};
      const incMc = (incCat.mainCauses ?? []).find((m: any) => m.id === mc.id) ?? mc;

      const mergedMc: any = { ...baseMc, ...incMc };

      mergedMc.subCauses = mergeById(baseMc.subCauses ?? [], incMc.subCauses ?? []).map((sc: any) => {
        const baseSc = (baseMc.subCauses ?? []).find((s: any) => s.id === sc.id) ?? {};
        const incSc = (incMc.subCauses ?? []).find((s: any) => s.id === sc.id) ?? sc;

        const mergedSc: any = { ...baseSc, ...incSc };

        const baseWhys = Array.isArray(baseSc.whys) ? baseSc.whys : [];
        const incWhys = Array.isArray(mergedSc.whys) ? mergedSc.whys : [];

        // ✅ dedupe POR TEXTO/ID, no por referencia
        // ✅ y cap duro para que no crezca infinito
        mergedSc.whys = dedupeWhys(baseWhys, incWhys, Math.min(out.maxWhyDepth ?? 3, 7));

        return mergedSc;
      });

      return mergedMc;
    });

    return mergedCat;
  });

  // ✅ Normalizar problema a { text } si viene como string
  if (typeof out.problem === "string") {
    const t = out.problem.trim();
    out.problem = t ? { text: t } : out.problem;
  }

  return applyStage4Rules(out);
}

function whyToKey(w: any): string {
  if (typeof w === "string") return w.trim();
  if (w && typeof w === "object") {
    const t = typeof w.text === "string" ? w.text.trim() : "";
    const id = typeof w.id === "string" ? w.id.trim() : "";
    return t || id || "";
  }
  return "";
}

function dedupeWhys(base: any[], incoming: any[], maxKeep: number) {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (w: any) => {
    const key = whyToKey(w);
    if (!key) return;
    const norm = key.toLowerCase();
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(key);
  };

  for (const w of base ?? []) push(w);
  for (const w of incoming ?? []) push(w);

  // ✅ cap duro para que JAMÁS explote
  if (out.length > maxKeep) return out.slice(0, maxKeep);
  return out;
}

function compactIshikawaState(state: any) {
  if (!state || typeof state !== "object") return state;

  const maxWhyDepth = RULES.maxWhyDepth;

  const out = { ...state };

  out.categories = (out.categories ?? []).map((cat: any) => {
    const cat2 = { ...cat };

    cat2.mainCauses = (cat2.mainCauses ?? []).map((mc: any) => {
      const mc2 = { ...mc };

      mc2.subCauses = (mc2.subCauses ?? []).map((sc: any) => {
        const sc2 = { ...sc };

        // ✅ normalizar siempre a string[] y dedupe + cap
        const merged = dedupeWhys(sc2.whys ?? [], [], maxWhyDepth);
        sc2.whys = merged;

        return sc2;
      });

      return mc2;
    });

    return cat2;
  });

  // ✅ normalizar problema
  if (typeof out.problem === "string") {
    const t = out.problem.trim();
    out.problem = t ? { text: t } : out.problem;
  }

  applyStage4Rules(out);
  return out;
}


export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", message: gate.message }, { status: 403 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Payload inválido"), { status: 400 });
    }

    const { chatId, state } = parsed.data;

    if (!chatId) {
      return NextResponse.json(
        {
          ok: true,
          saved: false,
          skipped: true,
          message: "Ishikawa state skip: chatId aún no inicializado.",
        },
        { status: 200 }
      );
    }

    const access = await assertChatOwner(user.userId, chatId);
    if (!access.ok) {
      return NextResponse.json(
        { ok: false, code: access.status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: access.message },
        { status: access.status }
      );
    }

    const existing = await supabaseServer
      .from("plan_stage_states")
      .select("state_json")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .maybeSingle();

    if (existing.error) {
      return NextResponse.json(fail("BAD_REQUEST", existing.error.message), { status: 400 });
    }

    const mergedStateRaw = mergeIshikawaState(existing.data?.state_json ?? null, state);
    const mergedState = compactIshikawaState(mergedStateRaw);

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

    if (error) {
      return NextResponse.json(fail("BAD_REQUEST", error.message), { status: 400 });
    }

    return ok({ saved: true });
  } catch (e: any) {
    return NextResponse.json(fail("INTERNAL", e?.message ?? "Error"), { status: 500 });
  }
}