// src/app/api/plans/context/confirm/route.ts
// Etapa 0: Confirmar contexto (habilita Avance 1)

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";

export const runtime = "nodejs";

const ConfirmSchema = z.object({
  contextJson: z.record(z.string(), z.any()).optional(),
  contextText: z.string().max(5000).optional(),
});

function hasMinimum(contextJson: any): boolean {
  const sector =
    typeof contextJson?.sector === "string"
      ? contextJson.sector
      : typeof contextJson?.sector?.value === "string"
      ? contextJson.sector.value
      : "";

  const products =
    Array.isArray(contextJson?.products)
      ? contextJson.products
      : Array.isArray(contextJson?.products?.value)
      ? contextJson.products.value
      : [];

  const processFocus =
    Array.isArray(contextJson?.process_focus)
      ? contextJson.process_focus
      : Array.isArray(contextJson?.process_focus?.value)
      ? contextJson.process_focus.value
      : Array.isArray(contextJson?.process_scope?.value?.focus_processes)
      ? contextJson.process_scope.value.focus_processes
      : Array.isArray(contextJson?.process_scope?.focus_processes)
      ? contextJson.process_scope.focus_processes
      : [];

  return sector.trim().length > 0 && products.length > 0 && processFocus.length > 0;
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(
        fail("FORBIDDEN", gate.message, { reason: gate.reason }),
        { status: 403 }
      );
    }

    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }

    const parsed = ConfirmSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const { data: current, error: curErr } = await supabaseServer
      .from("plan_case_contexts")
      .select("id,status,version,chat_id,context_json,context_text")
      .eq("user_id", authed.userId)
      .maybeSingle();

    if (curErr) {
      return NextResponse.json(
        fail("INTERNAL", "No se pudo leer el contexto del caso.", curErr),
        { status: 500 }
      );
    }

    if (!current) {
      return NextResponse.json(
        fail("BAD_REQUEST", "No existe un borrador de contexto para confirmar."),
        { status: 400 }
      );
    }

    const baseJson = (current.context_json as any) ?? {};
    const mergedJson = { ...baseJson, ...(parsed.data.contextJson ?? {}) };
    const mergedText = parsed.data.contextText ?? current.context_text ?? null;

    if (!hasMinimum(mergedJson)) {
      return NextResponse.json(
        fail(
          "BAD_REQUEST",
          "Aún falta información mínima para confirmar el contexto (sector, producto/servicio, proceso/área)."
        ),
        { status: 400 }
      );
    }

    const nextVersion = current.version ?? 1;

    const { data: saved, error: saveErr } = await supabaseServer
      .from("plan_case_contexts")
      .upsert(
        {
          user_id: authed.userId,
          chat_id: current.chat_id ?? null,
          status: "confirmed",
          version: nextVersion,
          context_json: mergedJson,
          context_text: mergedText,
        },
        { onConflict: "user_id" }
      )
      .select("status,version,chat_id,context_json,context_text")
      .single();

    if (saveErr || !saved) {
      return NextResponse.json(
        fail("INTERNAL", "No se pudo confirmar el contexto del caso.", saveErr),
        { status: 500 }
      );
    }

    return ok({
      status: saved.status,
      version: saved.version,
      chatId: saved.chat_id,
      contextJson: saved.context_json,
      contextText: saved.context_text,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
