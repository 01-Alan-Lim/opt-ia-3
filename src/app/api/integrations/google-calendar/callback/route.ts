// src/app/api/integrations/google-calendar/callback/route.ts
import { z } from "zod";
import { ok, failResponse } from "@/lib/api/response";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";

export const runtime = "nodejs";

const BodySchema = z.object({
  code: z.string().min(5),
  state: z.string().optional().nullable(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

function base64UrlDecode(input: string) {
  const b64 =
    input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(b64, "base64").toString("utf8");
}

function safeReturnTo(rt: unknown, fallback: string) {
  if (typeof rt !== "string") return fallback;
  if (!rt.startsWith("/")) return fallback;
  if (rt.startsWith("//")) return fallback;
  return rt;
}

function getCookie(req: Request, name: string) {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  const part = raw
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`));
  return part ? part.split("=").slice(1).join("=") : null;
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const body = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return failResponse(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Payload inválido.",
        400,
        parsed.error.issues
      );
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return failResponse(
        "INTERNAL",
        "Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en env.",
        500
      );
    }

    // Validación CSRF state vs cookie
    const cookieCsrf = getCookie(req, "gc_csrf");
    let returnTo = "/chat";
    let stateCsrf: string | undefined;

    if (parsed.data.state) {
      try {
        const obj = JSON.parse(base64UrlDecode(parsed.data.state)) as { rt?: unknown; csrf?: unknown };
        returnTo = safeReturnTo(obj.rt, "/chat");
        if (typeof obj.csrf === "string") stateCsrf = obj.csrf;
      } catch {
        // si state es inválido, igual seguimos pero con returnTo seguro
        returnTo = "/chat";
      }
    }

    if (stateCsrf && cookieCsrf && stateCsrf !== cookieCsrf) {
      return failResponse("FORBIDDEN", "State inválido (CSRF).", 403);
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
      return failResponse("INTERNAL", "No se pudo intercambiar el code por tokens.", 500, tokenJson);
    }

    const tokenParsed = TokenResponseSchema.safeParse(tokenJson);
    if (!tokenParsed.success) {
      return failResponse("INTERNAL", "Respuesta de Google inválida (token).", 500, tokenParsed.error.issues);
    }

    const refreshToken = tokenParsed.data.refresh_token;
    if (!refreshToken) {
      return failResponse(
        "CONFLICT",
        "Google no devolvió refresh_token. Revoca el acceso de OPT-IA en tu cuenta Google y vuelve a conectar.",
        409
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
      return failResponse("INTERNAL", "No se pudo guardar token de calendario.", 500, error);
    }

    const res = ok({ connected: true, returnTo });
    res.cookies.set("gc_csrf", "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === "UNAUTHORIZED") return failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401);
    if (msg === "FORBIDDEN_DOMAIN") return failResponse("FORBIDDEN", "Acceso restringido.", 403);
    return failResponse("INTERNAL", "Error interno.", 500, { msg });
  }
}