// src/app/api/plans/ishikawa/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";
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

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const parsed = QuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    // 1) Intento: leer por chatId si viene en query
    let q = supabaseServer
      .from("plan_stage_artifacts")
      .select("id, payload, status, updated_at, chat_id")
      .eq("user_id", user.userId)
      .eq("stage", STAGE)
      .eq("artifact_type", DraftType)
      .eq("period_key", PERIOD_KEY);

    if (parsed.chatId) q = q.eq("chat_id", parsed.chatId);

    let { data, error } = await q.maybeSingle();

    // 2) Fallback: si no existe para este chat (p.ej. abriste un chat nuevo),
    // retomamos el último estado del periodo (por updated_at).
    if (!error && parsed.chatId && !data) {
      const fallback = await supabaseServer
        .from("plan_stage_artifacts")
        .select("id, payload, status, updated_at, chat_id")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      data = fallback.data ?? null;
      error = fallback.error ?? null;
    }

    // 3) Fallback FINAL: si no existe en el periodo actual (ej: cambió el mes),
    // retomamos el último estado disponible (sin filtrar period_key).
    if (!error && !data) {
      const fallbackAnyPeriod = await supabaseServer
        .from("plan_stage_artifacts")
        .select("id, payload, status, updated_at, chat_id")
        .eq("user_id", user.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      data = fallbackAnyPeriod.data ?? null;
      error = fallbackAnyPeriod.error ?? null;
    }

    if (error) {
      return NextResponse.json(fail("BAD_REQUEST", error.message), { status: 400 });
    }

    if (!data) return ok({ exists: false });

    const compacted = compactIshikawaState(data.payload);

    return ok({
      exists: true,
      state: compacted,
      status: data.status,
      updatedAt: data.updated_at,
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

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Payload inválido"), { status: 400 });
    }
    const { chatId, state } = parsed.data;

    // ✅ Guard: no guardar si aún no existe chatId (evita registros con chat_id null)
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

    const existing = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", DraftType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    const mergedStateRaw = mergeIshikawaState(existing.data?.payload ?? null, state);
    const mergedState = compactIshikawaState(mergedStateRaw);

    const { error } = await supabaseServer
      .from("plan_stage_artifacts")
      .upsert(
        {
          user_id: user.userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: DraftType,
          period_key: PERIOD_KEY,
          status: "draft",
          payload: mergedState,
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      );
    if (error) {
      return NextResponse.json(fail("BAD_REQUEST", error.message), { status: 400 });
    }

    return ok({ saved: true });

  } catch (e: any) {
      return NextResponse.json(fail("INTERNAL", e?.message ?? "Error"), { status: 500 });
    }
}
