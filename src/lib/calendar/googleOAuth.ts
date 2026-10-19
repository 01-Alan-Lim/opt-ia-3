// src/lib/calendar/googleOAuth.ts
//
// OAuth de Google para la cuenta organizadora de Calendar (solo servidor). Usa el cliente OAuth
// que ya tenía Calendar (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) y su URI de retorno
// registrada, /auth/calendar-callback. Pide calendar.events (crear y actualizar los eventos del
// organizador) y openid email (saber qué cuenta se conectó). fetch se inyecta para las pruebas.

import { z } from "zod";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const ORGANIZER_SCOPES = ["openid", "email", CALENDAR_EVENTS_SCOPE] as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OAuthClientConfig = { clientId: string; clientSecret: string };

export function readOAuthClientConfig(env: Readonly<Record<string, string | undefined>> = process.env): OAuthClientConfig | null {
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function organizerRedirectUri(origin: string): string {
  return `${origin}/auth/calendar-callback`;
}

export function buildOrganizerAuthUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ORGANIZER_SCOPES.join(" "));
  // offline + consent: Google entrega un refresh token aunque la cuenta ya hubiera autorizado.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

// state = base64url de { p: "organizer", csrf }. El csrf también va en una cookie httpOnly y el
// callback exige que coincidan.
export function encodeOrganizerState(csrf: string): string {
  return Buffer.from(JSON.stringify({ p: "organizer", csrf }), "utf8").toString("base64url");
}

export function decodeOrganizerState(state: unknown): { csrf: string } | null {
  if (typeof state !== "string" || state.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    const result = z.object({ p: z.literal("organizer"), csrf: z.string().min(16).max(128) }).safeParse(parsed);
    return result.success ? { csrf: result.data.csrf } : null;
  } catch {
    return null;
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
});

const IdTokenClaimsSchema = z.object({ email: z.string().email(), email_verified: z.boolean().optional() });

// Claims del id_token que acaba de entregar el endpoint de tokens de Google por TLS (no viene
// del navegador), así que basta con leerlas.
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = IdTokenClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!claims.success || claims.data.email_verified === false) return null;
    return claims.data.email.toLowerCase();
  } catch {
    return null;
  }
}

export type OrganizerCodeExchange =
  | { ok: true; refreshToken: string; scope: string; googleEmail: string }
  | { ok: false; reason: "EXCHANGE_FAILED" | "MISSING_SCOPE" | "NO_REFRESH_TOKEN" | "NO_EMAIL" };

export async function exchangeOrganizerCode(params: {
  code: string;
  redirectUri: string;
  config: OAuthClientConfig;
  fetchImpl?: FetchLike;
}): Promise<OrganizerCodeExchange> {
  const doFetch = params.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    code: params.code,
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  let json: unknown = null;
  try {
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: "EXCHANGE_FAILED" };
  } catch {
    return { ok: false, reason: "EXCHANGE_FAILED" };
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "EXCHANGE_FAILED" };
  const scope = parsed.data.scope ?? "";
  if (!scope.split(/\s+/).includes(CALENDAR_EVENTS_SCOPE)) return { ok: false, reason: "MISSING_SCOPE" };
  if (!parsed.data.refresh_token) return { ok: false, reason: "NO_REFRESH_TOKEN" };
  const googleEmail = emailFromIdToken(parsed.data.id_token);
  if (!googleEmail) return { ok: false, reason: "NO_EMAIL" };
  return { ok: true, refreshToken: parsed.data.refresh_token, scope, googleEmail };
}

export type AccessTokenResult = { ok: true; accessToken: string } | { ok: false; reason: "REVOKED" | "FAILED" };

export async function refreshGoogleAccessToken(params: {
  refreshToken: string;
  config: OAuthClientConfig;
  fetchImpl?: FetchLike;
}): Promise<AccessTokenResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    refresh_token: params.refreshToken,
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    grant_type: "refresh_token",
  });
  try {
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = json && typeof json === "object" ? (json as Record<string, unknown>).error : null;
      // invalid_grant: revocado, caducado (app en Testing: 7 días) o cambio de contraseña.
      return { ok: false, reason: error === "invalid_grant" ? "REVOKED" : "FAILED" };
    }
    const parsed = TokenResponseSchema.safeParse(json);
    return parsed.success ? { ok: true, accessToken: parsed.data.access_token } : { ok: false, reason: "FAILED" };
  } catch {
    return { ok: false, reason: "FAILED" };
  }
}

// Revocación en Google al desconectar; si falla, la conexión se borra igual en OPT-IA.
export async function revokeGoogleToken(params: { token: string; fetchImpl?: FetchLike }): Promise<boolean> {
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: params.token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
