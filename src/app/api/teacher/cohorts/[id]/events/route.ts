// src/app/api/teacher/cohorts/[id]/events/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

const KindSchema = z.enum(["FORM_INITIAL", "FORM_MONTHLY", "FORM_FINAL", "ADVANCE"]);

const EventInputSchema = z
  .object({
    event_kind: KindSchema,
    event_index: z.number().int().min(1).max(3).nullable().optional(),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
    remind_before_days: z.number().int().min(0).max(30).optional(),
    is_enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const kind = v.event_kind;
    const idx = v.event_index ?? null;

    if ((kind === "FORM_INITIAL" || kind === "FORM_FINAL") && idx !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["event_index"],
        message: "event_index debe ser null para FORM_INITIAL/FORM_FINAL.",
      });
    }
    if ((kind === "FORM_MONTHLY" || kind === "ADVANCE") && (idx === null || idx < 1 || idx > 3)) {
      ctx.addIssue({
        code: "custom",
        path: ["event_index"],
        message: "event_index debe ser 1..3 para FORM_MONTHLY/ADVANCE.",
      });
    }
  });

const PutBodySchema = z.object({
  events: z.array(EventInputSchema).min(1).max(20),
});

function decodeId(raw: string) {
  return decodeURIComponent(String(raw)).trim();
}

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/teacher/cohorts/[id]/events">
) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(
        fail("FORBIDDEN", "Solo docentes pueden ver eventos de cohortes."),
        { status: 403 }
      );
    }

    // Next 16: params es Promise => await
    const { id } = ParamsSchema.parse(await ctx.params);
    const cohortId = decodeId(id);

    const { data, error } = await supabaseServer
      .from("cohort_events")
      .select("id, cohort_id, event_kind, event_index, event_date, remind_before_days, is_enabled, updated_at")
      .eq("cohort_id", cohortId)
      .order("event_kind", { ascending: true })
      .order("event_index", { ascending: true });

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo leer eventos.", error), { status: 500 });
    }

    return ok({ events: data ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    if (e && typeof e === "object" && (e as any).name === "ZodError") {
      return NextResponse.json(fail("BAD_REQUEST", "ID de cohorte inválido."), { status: 400 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}

export async function PUT(
  req: Request,
  ctx: RouteContext<"/api/teacher/cohorts/[id]/events">
) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(
        fail("FORBIDDEN", "Solo docentes pueden editar eventos de cohortes."),
        { status: 403 }
      );
    }

    // Next 16: params es Promise => await
    const { id } = ParamsSchema.parse(await ctx.params);
    const cohortId = decodeId(id);

    const body = await req.json().catch(() => null);
    const parsed = PutBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    // Validar que la cohorte exista
    const { data: cohort, error: cohortErr } = await supabaseServer
      .from("cohorts")
      .select("id")
      .eq("id", cohortId)
      .single();

    if (cohortErr || !cohort) {
      return NextResponse.json(fail("NOT_FOUND", "Cohorte no encontrada."), { status: 404 });
    }

    const events = parsed.data.events.map((ev) => ({
      cohort_id: cohortId,
      event_kind: ev.event_kind,
      event_index: ev.event_index ?? null,
      event_date: ev.event_date,
      remind_before_days: ev.remind_before_days ?? 2,
      is_enabled: ev.is_enabled ?? true,
    }));

    // REPLACE TOTAL
    const { error: delErr } = await supabaseServer.from("cohort_events").delete().eq("cohort_id", cohortId);
    if (delErr) {
      return NextResponse.json(fail("INTERNAL", "No se pudo limpiar eventos previos.", delErr), { status: 500 });
    }

    const { data: inserted, error: insErr } = await supabaseServer
      .from("cohort_events")
      .insert(events)
      .select("id, cohort_id, event_kind, event_index, event_date, remind_before_days, is_enabled, updated_at");

    if (insErr) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar eventos.", insErr), { status: 500 });
    }

    return ok({ events: inserted ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), { status: 401 });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    if (e && typeof e === "object" && (e as any).name === "ZodError") {
      return NextResponse.json(fail("BAD_REQUEST", "ID de cohorte inválido."), { status: 400 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}
