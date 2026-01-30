// src/app/api/plans/ishikawa/state/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";

const STAGE = 4;
const DraftType = "ishikawa_wizard_state";
const PERIOD_KEY = new Date().toISOString().slice(0, 7);

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

    return ok({
    exists: true,
    state: data.payload,
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

        const mergedWhys = [...baseWhys];
        for (const w of incWhys) {
          if (!mergedWhys.includes(w)) mergedWhys.push(w);
        }
        mergedSc.whys = mergedWhys;

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

    const existing = await supabaseServer
      .from("plan_stage_artifacts")
      .select("payload")
      .eq("user_id", user.userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", DraftType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    const mergedState = mergeIshikawaState(existing.data?.payload ?? null, state);


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
          // Nota: no forzamos updated_at aquí; Supabase/DB puede manejarlo.
          // Si tu tabla no tiene trigger, igual el upsert funciona; el updated_at del select no es crítico.
        },
        { onConflict: "user_id,stage,artifact_type,period_key" }
      );

    if (error) {
      return NextResponse.json(fail("BAD_REQUEST", error.message), { status: 400 });
    }

    return ok({ saved: true });


} catch (e: any) {
    return NextResponse.json(fail("INTERNAL", e?.message ?? "Error"), { status: 500 });
  }
}
