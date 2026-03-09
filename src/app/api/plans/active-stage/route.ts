// src/app/api/plans/active-stage/route.ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { ok, failResponse } from "@/lib/api/response";
import { resolveActivePlanStage } from "@/lib/plan/activeStage";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const resolved = await resolveActivePlanStage(user.userId);
    return ok(resolved);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }

    return failResponse(
      "INTERNAL",
      "No se pudo resolver la etapa activa del Asesor.",
      500
    );
  }
}