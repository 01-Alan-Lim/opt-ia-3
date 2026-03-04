// src/app/api/integrations/google-calendar/start/route.ts

import { NextResponse } from "next/server";
import { z } from "zod";
import { ok, failResponse } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";

export const runtime = "nodejs";

const QuerySchema = z.object({
  returnTo: z
    .string()
    .optional()
    .transform((v) => v ?? "/chat")
    .refine((v) => v.startsWith("/") && !v.startsWith("//"), {
      message: "returnTo inválido.",
    }),
});

function base64UrlEncode(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function GET(req: Request) {
  try {
    await requireUser(req);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({ returnTo: url.searchParams.get("returnTo") });
    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Query inválida.",
        400,
        parsed.error.issues
      );
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) {
      return failResponse("INTERNAL", "Falta GOOGLE_OAUTH_CLIENT_ID en env.", 500);
    }

    const origin = new URL(req.url).origin;
    const redirectUri = `${origin}/auth/calendar-callback`;

    const csrf = crypto.randomUUID();
    const state = base64UrlEncode(JSON.stringify({ rt: parsed.data.returnTo, csrf }));

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);

    const res = ok({ url: authUrl.toString() });
    res.cookies.set("gc_csrf", csrf, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    });

    return res;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    if (msg === "FORBIDDEN_DOMAIN") return failResponse("FORBIDDEN", "Acceso restringido.", 403);
    return failResponse("INTERNAL", "Error interno.", 500, { msg });
  }
}