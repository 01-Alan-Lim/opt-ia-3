import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";

export const runtime = "nodejs";

// Semestre: SOLO 1 o 2 (como pediste)
const SemesterEnum = z.enum(["1", "2"]);

const SubmitSchema = z.object({
  // RU: solo dígitos. Ajusta {8,10} si tu RU real tiene otra longitud.
  ru: z
    .string()
    .trim()
    .regex(/^\d{5,10}$/, "RU debe tener solo números (5 a 10 dígitos)."),

  first_name: z.string().trim().min(2).max(60),
  last_name: z.string().trim().min(2).max(60),

  semester: SemesterEnum,

  // empresa opcional: si viene vacío => null
  company_name: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .optional()
    .nullable()
    .transform((v) => {
      if (v == null) return null;
      const t = v.trim();
      return t.length ? t : null;
    }),

  cohort_id: z.string().uuid(),
});

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const body = await req.json().catch(() => null);
    const parsed = SubmitSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Datos inválidos para registro.", parsed.error.flatten()),
        { status: 400 }
      );
    }

    const input = parsed.data;

    // 1) Validar cohorte activa y si registro está abierto
    const { data: cohort, error: cohortErr } = await supabaseServer
      .from("cohorts")
      .select("id,is_active,registration_opens_at,access_starts_at,access_ends_at")
      .eq("id", input.cohort_id)
      .single();

    if (cohortErr || !cohort) {
      return NextResponse.json(fail("NOT_FOUND", "Cohorte no encontrada."), { status: 404 });
    }
    if (!cohort.is_active) {
      return NextResponse.json(fail("FORBIDDEN", "La cohorte está cerrada."), { status: 403 });
    }

    const now = new Date();
    if (cohort.registration_opens_at) {
      const opensAt = new Date(cohort.registration_opens_at);
      if (now < opensAt) {
        return NextResponse.json(
          fail("FORBIDDEN", "El registro aún no está habilitado para esta cohorte.", {
            registration_opens_at: cohort.registration_opens_at,
          }),
          { status: 403 }
        );
      }
    }

    // 2) Calcular ventana de acceso
    const startsAt = cohort.access_starts_at ? new Date(cohort.access_starts_at) : now;

    // fallback 120 días (~4 meses) si no hay access_ends_at
    const endsAt = cohort.access_ends_at
      ? new Date(cohort.access_ends_at)
      : new Date(startsAt.getTime() + 120 * 24 * 60 * 60 * 1000);

    // 3) Upsert del perfil (registro queda pending hasta aprobación docente)
    const { data: saved, error: upsertErr } = await supabaseServer
      .from("profiles")
      .upsert(
        {
          user_id: authed.userId,
          email: authed.email?.toLowerCase() ?? null,
          role: "student",
          ru: input.ru,
          first_name: input.first_name,
          last_name: input.last_name,
          semester: input.semester,
          company_name: input.company_name,
          cohort_id: input.cohort_id,
          registration_status: "pending",
          access_starts_at: startsAt.toISOString(),
          access_ends_at: endsAt.toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select(
        "ru,first_name,last_name,semester,company_name,cohort_id,registration_status,access_starts_at,access_ends_at"
      )
      .single();

    if (upsertErr) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar el registro.", upsertErr), {
        status: 500,
      });
    }

    return ok({ profile: saved });
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
