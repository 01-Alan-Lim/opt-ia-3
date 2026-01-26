// src/app/api/teacher/cohorts/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

function parseDateOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDateOnlyOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed; // columna DATE
}

function isSaturdayUtc(dateOnly: string): boolean {
  const d = new Date(dateOnly); // YYYY-MM-DD => UTC 00:00
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCDay() === 6;
}

function normalizeUrlOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t;
}

const CreateCohortSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    is_active: z.boolean().optional().default(true),

    registration_opens_at: z.string().datetime().nullable().optional(),
    access_starts_at: z.string().datetime().nullable().optional(),
    access_ends_at: z.string().datetime().nullable().optional(),

    // Seguimiento (config docente)
    hours_start_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    form_initial_url: z.string().url().nullable().optional(),
    form_monthly_url: z.string().url().nullable().optional(),
    form_final_url: z.string().url().nullable().optional(),
    reminder_hour: z.number().int().min(0).max(23).optional().default(11),
    reminder_minute: z.number().int().min(0).max(59).optional().default(0),
  })
  .superRefine((val, ctx) => {
    const start = val.access_starts_at ? new Date(val.access_starts_at) : null;
    const end = val.access_ends_at ? new Date(val.access_ends_at) : null;

    if (start && Number.isNaN(start.getTime())) {
      ctx.addIssue({ code: "custom", path: ["access_starts_at"], message: "Fecha access_starts_at inválida." });
    }
    if (end && Number.isNaN(end.getTime())) {
      ctx.addIssue({ code: "custom", path: ["access_ends_at"], message: "Fecha access_ends_at inválida." });
    }
    if (start && end && end <= start) {
      ctx.addIssue({
        code: "custom",
        path: ["access_ends_at"],
        message: "access_ends_at debe ser posterior a access_starts_at.",
      });
    }

    if (val.hours_start_at && !isSaturdayUtc(val.hours_start_at)) {
      ctx.addIssue({
        code: "custom",
        path: ["hours_start_at"],
        message: "hours_start_at debe caer en sábado (UTC).",
      });
    }
  });

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes pueden crear cohortes."), { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const parsed = CreateCohortSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const input = parsed.data;

    // Si la nueva cohorte es activa, desactivamos las demás (MVP).
    if (input.is_active) {
      await supabaseServer.from("cohorts").update({ is_active: false }).neq("is_active", false);
    }

    const insertPayload = {
      name: input.name,
      is_active: input.is_active,
      registration_opens_at: parseDateOrNull(input.registration_opens_at ?? null),
      access_starts_at: parseDateOrNull(input.access_starts_at ?? null),
      access_ends_at: parseDateOrNull(input.access_ends_at ?? null),

      hours_start_at: parseDateOnlyOrNull(input.hours_start_at ?? null),
      form_initial_url: normalizeUrlOrNull(input.form_initial_url ?? null),
      form_monthly_url: normalizeUrlOrNull(input.form_monthly_url ?? null),
      form_final_url: normalizeUrlOrNull(input.form_final_url ?? null),
      reminder_hour: input.reminder_hour,
      reminder_minute: input.reminder_minute,
    };

    const { data, error } = await supabaseServer.from("cohorts").insert(insertPayload).select("*").single();

    if (error || !data) {
      return NextResponse.json(fail("INTERNAL", "No se pudo crear la cohorte.", error), { status: 500 });
    }

    return ok({ cohort: data });
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
