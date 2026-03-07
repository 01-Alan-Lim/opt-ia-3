// src/app/api/plans/resume-gate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { loadLatestValidatedArtifact } from "@/lib/plan/stageValidation";
import { getPeriodKeyLaPaz } from "@/lib/time/periodKey";

export const runtime = "nodejs";

const QuerySchema = z.object({
  targetStage: z.coerce.number().int().min(2).max(10),
  chatId: z.string().uuid().optional(),
});

function fail(status: number, code: string, message: string, detail?: unknown) {
  return NextResponse.json({ ok: false, code, message, detail }, { status });
}

const GATE_BY_STAGE: Record<
  number,
  { requiredStage: number; artifactType: string; label: string }
> = {
  2: {
    requiredStage: 1,
    artifactType: "productivity_report",
    label: "Productividad validada",
  },
  3: {
    requiredStage: 2,
    artifactType: "foda_analysis",
    label: "FODA final",
  },
  4: {
    requiredStage: 3,
    artifactType: "brainstorm_ideas",
    label: "Lluvia de ideas final",
  },
  5: {
    requiredStage: 4,
    artifactType: "ishikawa_final",
    label: "Ishikawa final",
  },
  6: {
    requiredStage: 5,
    artifactType: "pareto_final",
    label: "Pareto final",
  },
  7: {
    requiredStage: 6,
    artifactType: "objectives_final",
    label: "Objetivos final",
  },
  8: {
    requiredStage: 7,
    artifactType: "improvement_final",
    label: "Plan de Mejora final",
  },
  9: {
    requiredStage: 8,
    artifactType: "planning_final",
    label: "Planificación final",
  },
  10: {
    requiredStage: 9,
    artifactType: "progress_final",
    label: "Reporte de avances final",
  },
};

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const parsed = QuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams)
    );

    if (!parsed.success) {
      return fail(
        400,
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Query inválida."
      );
    }

    const { targetStage, chatId } = parsed.data;
    const gateConfig = GATE_BY_STAGE[targetStage];

    if (!gateConfig) {
      return fail(400, "BAD_REQUEST", "Etapa no soportada para resume gate.");
    }

    const periodKey = getPeriodKeyLaPaz();

    const result = await loadLatestValidatedArtifact({
      userId: user.userId,
      preferredChatId: chatId ?? null,
      stage: gateConfig.requiredStage,
      artifactType: gateConfig.artifactType,
      periodKey,
    });

    if (!result.ok) {
      return fail(
        500,
        "DB_ERROR",
        "No se pudo resolver el prerequisito de reanudación.",
        result.error
      );
    }

    const row = result.row;

    return NextResponse.json(
      {
        ok: true,
        allowed: !!row,
        targetStage,
        requiredStage: gateConfig.requiredStage,
        artifactType: gateConfig.artifactType,
        label: gateConfig.label,
        sourceChatId: row?.chat_id ?? null,
        updatedAt: row?.updated_at ?? null,
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "INTERNAL";

    if (msg === "UNAUTHORIZED") {
      return fail(401, "UNAUTHORIZED", "Sesión inválida o ausente.");
    }

    return fail(500, "INTERNAL", "Error interno.", msg);
  }
}
