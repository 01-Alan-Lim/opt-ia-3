// src/app/api/plans/productivity/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { supabaseServer } from "@/lib/supabaseServer";
import { PLAN_STAGE_ARTIFACTS_ON_CONFLICT } from "@/lib/db/planArtifacts";

export const runtime = "nodejs";

type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN_DOMAIN"
  | "AUTH_UPSTREAM_TIMEOUT"
  | "BAD_REQUEST"
  | "DB_ERROR"
  | "FORBIDDEN";

function err(status: number, code: ApiErrorCode, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

function ok<T>(data: T) {
  return NextResponse.json({ ok: true, data }, { status: 200 });
}

const PeriodKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "period debe tener formato YYYY-MM");

const GetQuerySchema = z.object({
  period: PeriodKeySchema.optional(),
  chatId: z.string().uuid().optional(),
});

const CostItemSchema = z.object({
  name: z.string().min(1).max(80),
  amount_bs: z.number().finite().nonnegative(),
  // explicación corta de qué incluye / por qué se eligió
  note: z.string().min(1).max(400).optional(),
});

const PayloadSchema = z.object({
  type: z.enum(["monetaria", "fisica"]),
  period_key: PeriodKeySchema,
  line: z.string().min(1).max(120).optional(),
  income_bs: z.number().finite().nonnegative().optional(),
  costs: z.array(CostItemSchema).max(30).optional(),
  cost_total_bs: z.number().finite().nonnegative().optional(),
  productivity: z.number().finite().nonnegative().optional(),
  notes: z.string().max(600).optional(),
});

const PostBodySchema = z.object({
  chatId: z.string().uuid().optional(),
  payload: PayloadSchema,
});

const TABLE = "plan_stage_artifacts";
const ARTIFACT_TYPE = "productivity_report";
const STAGE = 1;

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) {
      return err(403, "FORBIDDEN", gate.message);
    }

    const url = new URL(req.url);
    const parsed = GetQuerySchema.safeParse({
      period: url.searchParams.get("period") ?? undefined,
      chatId: url.searchParams.get("chatId") ?? undefined,
    });
    if (!parsed.success) {
      return err(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida.");
    }

    const { period, chatId } = parsed.data;

    let query = supabaseServer
      .from(TABLE)
      .select("id,user_id,chat_id,stage,artifact_type,period_key,status,payload,score,created_at,updated_at")
      .eq("user_id", authed.userId)
      .eq("stage", STAGE)
      .eq("artifact_type", ARTIFACT_TYPE)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (period) query = query.eq("period_key", period);
    if (chatId) query = query.eq("chat_id", chatId);

    const { data, error } = await query.maybeSingle();

    if (error) return err(500, "DB_ERROR", `DB error: ${error.message}`);

    if (!data) {
      return ok({
        exists: false,
        period_key: period ?? null,
        chat_id: chatId ?? null,
        report: null,
      });
    }

    return ok(data);
  } catch (errValue: unknown) {
    const authCode = getAuthErrorCode(errValue);

    if (authCode === "UNAUTHORIZED") {
      return err(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return err(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return err(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por timeout de autenticación."
      );
    }

    return err(500, "DB_ERROR", "Error interno.");
  }
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req, authed);
    if (!gate.ok) {
      return err(403, "FORBIDDEN", gate.message);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return err(400, "BAD_REQUEST", "Body inválido (JSON).");
    }

    const parsed = PostBodySchema.safeParse(body);
    if (!parsed.success) {
      return err(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Body inválido.");
    }

    const { chatId, payload } = parsed.data;

    const costs = payload.costs ?? [];
    const costTotal =
      payload.cost_total_bs ??
      (costs.length ? costs.reduce((acc, c) => acc + c.amount_bs, 0) : undefined);

    const productivity =
      payload.productivity ??
      (payload.type === "monetaria" &&
      typeof payload.income_bs === "number" &&
      typeof costTotal === "number" &&
      costTotal > 0
        ? payload.income_bs / costTotal
        : undefined);

    const mergedPayload = {
      ...payload,
      costs: costs.length ? costs : undefined,
      cost_total_bs: costTotal,
      productivity,
    };

    const { data, error } = await supabaseServer
      .from(TABLE)
      .upsert(
        {
          user_id: authed.userId,
          chat_id: chatId ?? null,
          stage: STAGE,
          artifact_type: ARTIFACT_TYPE,
          period_key: payload.period_key,
          status: "draft",
          payload: mergedPayload,
        },
        { onConflict: PLAN_STAGE_ARTIFACTS_ON_CONFLICT }
      )
      .select("id,user_id,chat_id,stage,artifact_type,period_key,status,payload,score,created_at,updated_at")
      .single();

    if (error) return err(500, "DB_ERROR", `DB error: ${error.message}`);

    return ok(data);
  } catch (errValue: unknown) {
    const authCode = getAuthErrorCode(errValue);

    if (authCode === "UNAUTHORIZED") {
      return err(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return err(403, "FORBIDDEN_DOMAIN", "Correo no permitido.");
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return err(
        503,
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por timeout de autenticación."
      );
    }

    return err(500, "DB_ERROR", "Error interno.");
  }
}
