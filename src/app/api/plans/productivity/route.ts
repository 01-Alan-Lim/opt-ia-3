// src/app/api/plans/productivity/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type ApiErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
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
  const authed = await requireUser(req).catch(() => null);
  if (!authed) return err(401, "UNAUTHORIZED", "No autenticado.");

  const url = new URL(req.url);
  const parsed = GetQuerySchema.safeParse({
    period: url.searchParams.get("period") ?? undefined,
    chatId: url.searchParams.get("chatId") ?? undefined,
  });
  if (!parsed.success) {
    return err(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida.");
  }

  const { period, chatId } = parsed.data;

  // Si no mandan period, devolvemos el último (más reciente) por updated_at
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
  if (!data) return err(404, "NOT_FOUND", "No existe reporte para ese periodo.");

  return ok(data);
}

export async function POST(req: Request) {
  const authed = await requireUser(req).catch(() => null);
  if (!authed) return err(401, "UNAUTHORIZED", "No autenticado.");

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

  // Normalización mínima en server para evitar inconsistencias
  const costs = payload.costs ?? [];
  const costTotal =
    payload.cost_total_bs ??
    (costs.length ? costs.reduce((acc, c) => acc + c.amount_bs, 0) : undefined);

  const productivity =
    payload.productivity ??
    (payload.type === "monetaria" && typeof payload.income_bs === "number" && typeof costTotal === "number" && costTotal > 0
      ? payload.income_bs / costTotal
      : undefined);

  const mergedPayload = {
    ...payload,
    costs: costs.length ? costs : undefined,
    cost_total_bs: costTotal,
    productivity,
  };

  // Upsert por (user_id, artifact_type, period_key) usando el índice único parcial que creaste.
  // Nota: Supabase upsert requiere onConflict con columnas existentes. Como el unique es índice parcial,
  // igual puede funcionar con onConflict en (user_id, artifact_type, period_key).
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
      { onConflict: "user_id,stage,artifact_type,period_key" }
    )
    .select("id,user_id,chat_id,stage,artifact_type,period_key,status,payload,score,created_at,updated_at")
    .single();

  if (error) return err(500, "DB_ERROR", `DB error: ${error.message}`);

  return ok(data);
}
