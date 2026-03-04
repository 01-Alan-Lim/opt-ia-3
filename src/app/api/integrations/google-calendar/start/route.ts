// src/app/api/integrations/google-calendar/start/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/response";
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
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Query inválida."),
        { status: 400 }
      );
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json(fail("INTERNAL", "Falta GOOGLE_OAUTH_CLIENT_ID en env."), {
        status: 500,
      });
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

    const res = NextResponse.json(ok({ url: authUrl.toString() }));
    res.cookies.set("gc_csrf", csrf, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "INTERNAL";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json(fail("UNAUTHORIZED", "Sesión inválida o ausente."), {
        status: 401,
      });
    }
    if (msg === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(fail("FORBIDDEN", "Acceso restringido."), { status: 403 });
    }
    return NextResponse.json(fail("INTERNAL", "Error interno."), { status: 500 });
  }
}