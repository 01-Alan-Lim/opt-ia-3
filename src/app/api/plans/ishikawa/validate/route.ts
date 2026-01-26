// src/app/api/plans/ishikawa/validate/route.ts
import { NextResponse } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { z } from "zod";

const STAGE = 4;
const DraftType = "ishikawa_wizard_state";
const FinalType = "ishikawa_final";
const PERIOD_KEY = new Date().toISOString().slice(0, 7);

const BodySchema = z.object({
  chatId: z.string().uuid(),
});

function countRootCandidates(state: any) {
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  const roots: string[] = [];
  for (const c of cats) {
    const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
    for (const m of mains) {
      const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];
      for (const s of subs) {
        const t = (s?.text ?? "").toString().trim();
        if (t) roots.push(t);
      }
    }
  }
  return roots;
}

function buildScore(state: any, roots: string[]) {
  // Score simple y explicable (sin cambiar tu lógica):
  // - base: 40 si hay problemática
  // - +15 si cumple min categorías
  // - +15 si cumple min main/sub (si llega aquí, cumple)
  // - +30 proporcional por raíces (10 → 30 pts, 15+ → 30 pts)
  const problemText =
    typeof state?.problem === "string"
      ? state.problem
      : (typeof state?.problem?.text === "string" ? state.problem.text : "");

  const hasProblem = Boolean(problemText?.trim());
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  const minCats = typeof state?.minCategories === "number" ? state.minCategories : 4;

  const total =
    (hasProblem ? 40 : 0) +
    (cats.length >= minCats ? 15 : 0) +
    15 +
    Math.min(30, Math.round((Math.min(roots.length, 15) / 10) * 30));

  return {
    total: Math.min(100, Math.max(0, total)),
    rootsCount: roots.length,
    categoriesCount: cats.length,
    period_key: PERIOD_KEY,
    stage: STAGE,
  };
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    const userId = authed.userId;

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", "Falta chatId"), { status: 400 });
    }
    const { chatId } = parsed.data;

    // 1) leer draft (payload)
    const { data, error } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id, payload, chat_id, updated_at")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", DraftType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (error) return NextResponse.json(fail("BAD_REQUEST", error.message), { status: 400 });

    let draft = data;

    // ✅ Fallback: si el draft no está en este chat (abriste chat nuevo), retomamos el último draft del periodo
    if (!draft?.payload) {
    const fb = await supabaseServer
        .from("plan_stage_artifacts")
        .select("id, payload, chat_id, updated_at")
        .eq("user_id", userId)
        .eq("stage", STAGE)
        .eq("artifact_type", DraftType)
        .eq("period_key", PERIOD_KEY)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (fb.error) return NextResponse.json(fail("BAD_REQUEST", fb.error.message), { status: 400 });
    draft = fb.data ?? null;
    }

    if (!draft?.payload) {
    return NextResponse.json(fail("BAD_REQUEST", "No hay estado de Etapa 4"), { status: 400 });
    }

    const s: any = draft.payload;

    // 2) validaciones (las mismas que ya tenías)
    const problemText =
      typeof s?.problem === "string"
        ? s.problem
        : (typeof s?.problem?.text === "string" ? s.problem.text : "");

    if (!problemText.trim()) {
      return ok({ valid: false, message: "Falta la problemática (cabeza del Ishikawa)." });
    }

    const cats = Array.isArray(s?.categories) ? s.categories : [];
    const minCats = typeof s?.minCategories === "number" ? s.minCategories : 4;

    if (cats.length < minCats) {
      return NextResponse.json(
        ok({ valid: false, message: `Faltan categorías: tienes ${cats.length}, mínimo ${minCats}.` })
      );
    }

    const minMain = typeof s?.minMainCausesPerCategory === "number" ? s.minMainCausesPerCategory : 2;
    const minSub = typeof s?.minSubCausesPerMain === "number" ? s.minSubCausesPerMain : 2;

    for (const c of cats) {
      const mains = Array.isArray(c?.mainCauses) ? c.mainCauses : [];
      if (mains.length < minMain) {
        return NextResponse.json(
          ok({ valid: false, message: `En la categoría "${c?.name ?? "sin nombre"}" faltan causas principales (mín ${minMain}).` })
        );
      }
      for (const m of mains) {
        const subs = Array.isArray(m?.subCauses) ? m.subCauses : [];
        if (subs.length < minSub) {
          return NextResponse.json(
            ok({ valid: false, message: `En "${c?.name ?? "categoría"}" > "${m?.text ?? "causa"}" faltan subcausas (mín ${minSub}).` })
          );
        }
      }
    }

    const roots = countRootCandidates(s);
    if (roots.length < 10) {
      return NextResponse.json(
        ok({ valid: false, message: `Aún hay pocas causas raíz/candidatas (${roots.length}). Apunta a 10–15 para pasar a Pareto.` })
      );
    }

    // 3) preparar payload final + score
    const finalPayload = {
      ...s,
      validatedAt: new Date().toISOString(),
      roots,
    };
    const score = buildScore(s, roots);

    // 4) upsert final artifact
    const { data: existingFinal, error: exFinalErr } = await supabaseServer
      .from("plan_stage_artifacts")
      .select("id")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .eq("stage", STAGE)
      .eq("artifact_type", FinalType)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (exFinalErr) {
      return NextResponse.json(fail("BAD_REQUEST", exFinalErr.message), { status: 400 });
    }

    let finalArtifactId: string | null = null;

    if (!existingFinal) {
      const { data: created, error: insErr } = await supabaseServer
        .from("plan_stage_artifacts")
        .insert({
          user_id: userId,
          chat_id: chatId,
          stage: STAGE,
          artifact_type: FinalType,
          period_key: PERIOD_KEY,
          status: "validated",
          payload: finalPayload,
          score,
        })
        .select("id")
        .single();

      if (insErr || !created) {
        return NextResponse.json(fail("BAD_REQUEST", insErr?.message ?? "No se pudo crear final"), { status: 400 });
      }

      finalArtifactId = created.id as string;
    } else {
      finalArtifactId = existingFinal.id as string;

      const { error: updErr } = await supabaseServer
        .from("plan_stage_artifacts")
        .update({
          chat_id: chatId,
          status: "validated",
          payload: finalPayload,
          score,
          updated_at: new Date().toISOString(),
        })
        .eq("id", finalArtifactId);

      if (updErr) {
        return NextResponse.json(fail("BAD_REQUEST", updErr.message), { status: 400 });
      }
    }

    // 5) insertar evaluación (ahora con chat_id y artifact_id)
    const payloadEval = { status: "validated", rootsCount: roots.length };
    const { error: evalErr } = await supabaseServer.from("plan_stage_evaluations").insert({
      user_id: userId,
      chat_id: chatId,            // ✅ ya no queda null
      stage: STAGE,
      artifact_type: FinalType,
      artifact_id: finalArtifactId, // ✅ link al artifact final
      period_key: PERIOD_KEY,
      status: "validated",
      payload_json: payloadEval,
    });

    if (evalErr) {
      return NextResponse.json(fail("BAD_REQUEST", evalErr.message), { status: 400 });
    }

    return ok({ valid: true, message: "Etapa 4 validada.", roots, score });
  } catch (e: any) {
    return NextResponse.json(fail("BAD_REQUEST", e?.message ?? "Error"), { status: 500 });
  }
}
