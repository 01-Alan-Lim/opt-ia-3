// src/app/api/teacher/cohorts/[id]/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

function toIsoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// DATE column (YYYY-MM-DD)
function parseDateOnlyOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
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

const PatchSchema = z
  .object({
    name: z.string().trim().min(3).max(120).optional(),
    is_active: z.boolean().optional(),

    registration_opens_at: z.string().datetime().nullable().optional(),
    access_starts_at: z.string().datetime().nullable().optional(),
    access_ends_at: z.string().datetime().nullable().optional(),

    // ✅ nuevos campos (config cohorte)
    hours_start_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    form_initial_url: z.string().url().nullable().optional(),
    form_monthly_url: z.string().url().nullable().optional(),
    form_final_url: z.string().url().nullable().optional(),
    reminder_hour: z.number().int().min(0).max(23).optional(),
    reminder_minute: z.number().int().min(0).max(59).optional(),
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

    if (val.hours_start_at) {
      const d = parseDateOnlyOrNull(val.hours_start_at);
      if (!d) {
        ctx.addIssue({ code: "custom", path: ["hours_start_at"], message: "hours_start_at inválida." });
      } else if (!isSaturdayUtc(d)) {
        ctx.addIssue({
          code: "custom",
          path: ["hours_start_at"],
          message: "hours_start_at debe caer en sábado (UTC).",
        });
      }
    }
  });

export async function PATCH(req: Request, ctx: RouteContext<"/api/teacher/cohorts/[id]">) {
  try {
    const authed = await requireUser(req);
    if (authed.role !== "teacher") {
      return NextResponse.json(fail("FORBIDDEN", "Solo docentes pueden editar cohortes."), { status: 403 });
    }

    // Next 16: params es Promise => await
    const { id } = await ctx.params;
    const cohortId = decodeURIComponent(String(id)).trim();

    const isUuid = z.string().uuid().safeParse(cohortId);
    if (!isUuid.success) {
      return NextResponse.json(fail("BAD_REQUEST", "ID de cohorte inválido."), { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    // 1) Leer cohorte actual (para comparar si cambiaron fechas)
    const { data: before, error: beforeErr } = await supabaseServer
      .from("cohorts")
      .select("*")
      .eq("id", cohortId)
      .single();

    if (beforeErr || !before) {
      return NextResponse.json(fail("NOT_FOUND", "Cohorte no encontrada."), { status: 404 });
    }

    const input = parsed.data;

    // 2) Si se marca activa, desactivar otras
    if (input.is_active === true) {
      await supabaseServer.from("cohorts").update({ is_active: false }).neq("id", cohortId);
    }

    const patchPayload: Record<string, unknown> = {};
    if (input.name !== undefined) patchPayload.name = input.name;
    if (input.is_active !== undefined) patchPayload.is_active = input.is_active;

    if (input.registration_opens_at !== undefined) {
      patchPayload.registration_opens_at = toIsoOrNull(input.registration_opens_at);
    }
    if (input.access_starts_at !== undefined) {
      patchPayload.access_starts_at = toIsoOrNull(input.access_starts_at);
    }
    if (input.access_ends_at !== undefined) {
      patchPayload.access_ends_at = toIsoOrNull(input.access_ends_at);
    }

    // ✅ nuevos campos
    if (input.hours_start_at !== undefined) {
      patchPayload.hours_start_at = parseDateOnlyOrNull(input.hours_start_at);
    }
    if (input.form_initial_url !== undefined) {
      patchPayload.form_initial_url = normalizeUrlOrNull(input.form_initial_url);
    }
    if (input.form_monthly_url !== undefined) {
      patchPayload.form_monthly_url = normalizeUrlOrNull(input.form_monthly_url);
    }
    if (input.form_final_url !== undefined) {
      patchPayload.form_final_url = normalizeUrlOrNull(input.form_final_url);
    }
    if (input.reminder_hour !== undefined) patchPayload.reminder_hour = input.reminder_hour;
    if (input.reminder_minute !== undefined) patchPayload.reminder_minute = input.reminder_minute;

    const { data: updated, error: updErr } = await supabaseServer
      .from("cohorts")
      .update(patchPayload)
      .eq("id", cohortId)
      .select("*")
      .single();

    if (updErr || !updated) {
      return NextResponse.json(fail("INTERNAL", "No se pudo actualizar la cohorte.", updErr), { status: 500 });
    }

    // 3) Si cambió la ventana de acceso, PROPAGAR a profiles (clave para /api/me)
    const accessStartsChanged =
      input.access_starts_at !== undefined &&
      (toIsoOrNull(input.access_starts_at) ?? null) !== (before.access_starts_at ?? null);

    const accessEndsChanged =
      input.access_ends_at !== undefined &&
      (toIsoOrNull(input.access_ends_at) ?? null) !== (before.access_ends_at ?? null);

    if (accessStartsChanged || accessEndsChanged) {
      const profilePatch: Record<string, unknown> = {};
      if (input.access_starts_at !== undefined) profilePatch.access_starts_at = toIsoOrNull(input.access_starts_at);
      if (input.access_ends_at !== undefined) profilePatch.access_ends_at = toIsoOrNull(input.access_ends_at);

      await supabaseServer.from("profiles").update(profilePatch).eq("cohort_id", cohortId);
    }

    return ok({ cohort: updated });
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
