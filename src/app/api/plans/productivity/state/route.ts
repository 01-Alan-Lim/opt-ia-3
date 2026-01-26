// src/app/api/plans/productivity/state/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";

export const runtime = "nodejs";

const TABLE = "plan_stage_artifacts";
const ARTIFACT_TYPE = "productivity_wizard_state";
const STAGE = 1;
const PERIOD_KEY = new Date().toISOString().slice(0, 7); // "YYYY-MM"

// --- Schemas ---
const GetQuerySchema = z.object({
  chatId: z.string().uuid().optional(),
});

const ProdStepSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const DraftSchema = z.object({
  type: z.enum(["monetaria", "fisica"]).optional(),
  unit_reason: z.string().max(600).optional(),
  required_costs: z.number().int().min(1).max(10).optional(),
  period_key: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  line: z.string().min(1).max(120).optional(),
  income_bs: z.number().finite().nonnegative().optional(),
  costs: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        amount_bs: z.number().finite().nonnegative(),
        note: z.string().min(1).max(400).optional(),
      })
    )
    .max(30)
    .optional(),
  notes: z.string().max(600).optional(),
});

const PostBodySchema = z.object({
  chatId: z.string().uuid().nullable().optional(),
  clear: z.boolean().optional(),
  state: z
    .object({
      prodStep: ProdStepSchema,
      prodDraft: DraftSchema,
    })
    .optional(),
});

function unauthorized() {
  return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    const url = new URL(req.url);
    const parsed = GetQuerySchema.safeParse({
      chatId: url.searchParams.get("chatId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida."), {
        status: 400,
      });
    }

    const { data, error } = await supabaseServer
      .from(TABLE)
      .select("id,user_id,chat_id,stage,artifact_type,period_key,status,payload,created_at,updated_at")
      .eq("user_id", authed.userId)
      .eq("stage", STAGE)
      .eq("artifact_type", ARTIFACT_TYPE)
      .eq("period_key", PERIOD_KEY)
      .maybeSingle();

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el estado de Productividad.", error), {
        status: 500,
      });
    }

    // Si no existe, devolvemos vacío (no error)
    if (!data) {
      return ok({ exists: false, chatId: null, state: null });
    }

    // Si el cliente mandó chatId, devolvemos también si coincide
    const requestedChatId = parsed.data.chatId ?? null;
    const matchesChat = requestedChatId ? data.chat_id === requestedChatId : true;

    return ok({
      exists: true,
      chatId: data.chat_id ?? null,
      matchesChat,
      state: data.payload ?? null,
      updatedAt: data.updated_at ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") return unauthorized();
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(fail("BAD_REQUEST", "Body JSON inválido."), { status: 400 });
    }

    const parsed = PostBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const clear = parsed.data.clear ?? false;

    if (clear) {
      const { error } = await supabaseServer
        .from(TABLE)
        .delete()
        .eq("user_id", authed.userId)
        .eq("stage", STAGE)
        .eq("artifact_type", ARTIFACT_TYPE)
        .eq("period_key", PERIOD_KEY);

      if (error) {
        return NextResponse.json(fail("INTERNAL", "No se pudo limpiar el estado.", error), {
          status: 500,
        });
      }

      return ok({ cleared: true });
    }

    if (!parsed.data.state) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Falta 'state' o 'clear=true'."),
        { status: 400 }
      );
    }

    const { state } = parsed.data;

    const { data, error } = await supabaseServer
      .from(TABLE)
      .upsert(
        {
          user_id: authed.userId,
          chat_id: parsed.data.chatId ?? null,
          stage: STAGE,
          artifact_type: ARTIFACT_TYPE,
          period_key: PERIOD_KEY,
          status: "draft",
          payload: state,
        },
        { onConflict: "user_id,stage,artifact_type,period_key" }
      )
      .select("id,chat_id,payload,updated_at")
      .single();

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar el estado.", error), {
        status: 500,
      });
    }

    return ok({
      saved: true,
      chatId: data.chat_id ?? null,
      state: data.payload ?? null,
      updatedAt: data.updated_at ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") return unauthorized();
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
