// src/app/api/integrations/google-calendar/callback/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const BodySchema = z.object({
  code: z.string().min(5),
  state: z.string().optional().nullable(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(10),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
});

function base64UrlDecode(input: string) {
  const b64 =
    input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function safeReturnTo(rt: string | undefined, fallback: string) {
  if (!rt) return fallback;
  if (!rt.startsWith("/")) return fallback;
  if (rt.startsWith("//")) return fallback;
  return rt;
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        fail("INTERNAL", "Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en env."),
        { status: 500 }
      );
    }

    // leer cookie gc_csrf
    const cookieCsrf = req.headers
      .get("cookie")
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("gc_csrf="))
      ?.split("=")[1];

    let returnTo = "/chat";
    let stateCsrf: string | undefined;

    if (parsed.data.state) {
      try {
        const raw = base64UrlDecode(parsed.data.state);
        const obj = JSON.parse(raw) as { rt?: string; csrf?: string };
        returnTo = safeReturnTo(obj?.rt, "/chat");
        stateCsrf = obj?.csrf;
      } catch {
        returnTo = "/chat";
      }
    }

    if (stateCsrf && cookieCsrf && stateCsrf !== cookieCsrf) {
      return NextResponse.json(fail("FORBIDDEN", "State inválido (CSRF)."), { status: 403 });
    }

    const origin = new URL(req.url).origin;
    const redirectUri = `${origin}/auth/calendar-callback`;

    const form = new URLSearchParams();
    form.set("code", parsed.data.code);
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
    form.set("redirect_uri", redirectUri);
    form.set("grant_type", "authorization_code");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const tokenJson = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenJson) {
      return NextResponse.json(fail("INTERNAL", "No se pudo intercambiar el code por tokens."), {
        status: 500,
      });
    }

    const tokenParsed = TokenResponseSchema.safeParse(tokenJson);
    if (!tokenParsed.success) {
      return NextResponse.json(fail("INTERNAL", "Respuesta de Google inválida (token)."), {
        status: 500,
      });
    }

    const refreshToken = tokenParsed.data.refresh_token;
    if (!refreshToken) {
      return NextResponse.json(
        fail(
          "CONFLICT",
          "Google no devolvió refresh_token. Revoca el acceso de OPT-IA en tu cuenta de Google y vuelve a conectar."
        ),
        { status: 409 }
      );
    }

    const { error } = await supabaseServer
      .from("user_google_calendar_tokens")
      .upsert(
        {
          user_id: authed.userId,
          email: authed.email ?? null,
          calendar_id: "primary",
          provider: "google",
          scope: tokenParsed.data.scope ?? null,
          refresh_token: refreshToken,
        },
        { onConflict: "user_id" }
      );

    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar token de calendario.", error), {
        status: 500,
      });
    }

    const res = NextResponse.json(ok({ connected: true, returnTo }));
    res.cookies.set("gc_csrf", "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
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