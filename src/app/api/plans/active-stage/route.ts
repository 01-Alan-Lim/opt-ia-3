// src/app/api/plans/active-stage/route.ts
import { NextRequest } from "next/server";
import { getAuthErrorCode, requireUser } from "@/lib/auth/supabase";
import { assertChatAccess } from "@/lib/auth/chatAccess";
import { ok, failResponse } from "@/lib/api/response";
import { resolveActivePlanStage } from "@/lib/plan/activeStage";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    const gate = await assertChatAccess(req, user);
    if (!gate.ok) {
      return failResponse(gate.reason, gate.message, 403);
    }

    const resolved = await resolveActivePlanStage(user.userId);
    return ok(resolved);
  } catch (err: unknown) {
    const authCode = getAuthErrorCode(err);

    if (authCode === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }

    if (authCode === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    }

    if (authCode === "AUTH_UPSTREAM_TIMEOUT") {
      return failResponse(
        "AUTH_UPSTREAM_TIMEOUT",
        "No se pudo validar tu sesión por un timeout temporal con el servicio de autenticación.",
        503
      );
    }

    return failResponse(
      "INTERNAL",
      "No se pudo resolver la etapa activa del Asesor.",
      500
    );
  }
}