// src/lib/calendar/organizer.ts
//
// Cuenta organizadora de Google Calendar (calendar_organizer, M3, una sola fila). Solo servidor,
// con service_role. El refresh token entra y sale de aquí cifrado (tokenCipher); hacia fuera solo
// se expone el estado público (cuenta, estado, última sincronización y último error), nunca el
// token ni el texto cifrado.

import { supabaseServer } from "@/lib/supabaseServer";

import {
  readOAuthClientConfig,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  type OAuthClientConfig,
} from "./googleOAuth";
import { decryptRefreshToken, encryptRefreshToken, getCalendarTokenKey, type CalendarTokenKey } from "./tokenCipher";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TABLE = "calendar_organizer";
const MAX_ERROR = 300;

// Mensajes que se guardan en last_error y ve el docente. Fijos: nunca incluyen respuestas de
// Google ni tokens.
export const ORGANIZER_ERRORS = {
  revoked: "Google revocó o caducó el acceso de la cuenta organizadora. Vuelve a conectarla.",
} as const;

export type OrganizerConfig = { oauth: boolean; encryptionKey: boolean };

export type OrganizerPublicStatus = {
  available: boolean;
  configured: OrganizerConfig;
  status: "connected" | "disconnected" | "not_connected";
  googleEmail: string | null;
  calendarId: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

type OrganizerRow = {
  google_email: string;
  calendar_id: string;
  status: "connected" | "disconnected";
  connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  refresh_token_ciphertext?: string;
};

const PUBLIC_SELECT = "google_email, calendar_id, status, connected_at, last_synced_at, last_error, last_error_at";

export function organizerConfig(): OrganizerConfig {
  return { oauth: readOAuthClientConfig() !== null, encryptionKey: getCalendarTokenKey().ok };
}

export async function readOrganizerStatus(): Promise<OrganizerPublicStatus> {
  const configured = organizerConfig();
  const { data, error } = await supabaseServer.from(TABLE).select(PUBLIC_SELECT).eq("id", true).maybeSingle();
  const empty = { googleEmail: null, calendarId: null, connectedAt: null, lastSyncedAt: null, lastError: null, lastErrorAt: null };
  if (error) return { available: false, configured, status: "not_connected", ...empty };
  const row = data as OrganizerRow | null;
  if (!row) return { available: true, configured, status: "not_connected", ...empty };
  return {
    available: true,
    configured,
    status: row.status,
    googleEmail: row.google_email,
    calendarId: row.calendar_id,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
  };
}

export async function readOrganizerEmail(): Promise<{ ok: true; email: string | null } | { ok: false }> {
  const { data, error } = await supabaseServer.from(TABLE).select("google_email").eq("id", true).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, email: (data as { google_email: string } | null)?.google_email ?? null };
}

async function readSealedToken(): Promise<string | null> {
  const { data } = await supabaseServer.from(TABLE).select("refresh_token_ciphertext").eq("id", true).maybeSingle();
  return (data as { refresh_token_ciphertext: string } | null)?.refresh_token_ciphertext ?? null;
}

export async function saveOrganizerConnection(params: {
  key: CalendarTokenKey;
  googleEmail: string;
  refreshToken: string;
  scope: string;
  connectedBy: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const previousSealed = await readSealedToken();
  const now = new Date().toISOString();
  const { error } = await supabaseServer.from(TABLE).upsert(
    {
      id: true,
      google_email: params.googleEmail,
      calendar_id: "primary",
      refresh_token_ciphertext: encryptRefreshToken(params.key, params.refreshToken),
      scope: params.scope,
      status: "connected",
      connected_by: params.connectedBy,
      connected_at: now,
      last_error: null,
      last_error_at: null,
      updated_at: now,
    },
    { onConflict: "id" },
  );
  if (error) return false;

  // El token anterior ya no se usa: se revoca en Google (sin bloquear si falla).
  const previous = previousSealed ? decryptRefreshToken(params.key, previousSealed) : null;
  if (previous && previous !== params.refreshToken) await revokeGoogleToken({ token: previous, fetchImpl: params.fetchImpl });
  return true;
}

// Desconectar: se revoca el token en Google (si se puede) y se borra la fila. Las invitaciones ya
// enviadas siguen en los calendarios de los estudiantes; reconectar la misma cuenta las retoma.
export async function disconnectOrganizer(params: { fetchImpl?: FetchLike } = {}): Promise<{ ok: boolean; revokedAtGoogle: boolean }> {
  const sealed = await readSealedToken();
  const key = getCalendarTokenKey();
  const token = sealed && key.ok ? decryptRefreshToken(key.key, sealed) : null;
  const revokedAtGoogle = token ? await revokeGoogleToken({ token, fetchImpl: params.fetchImpl }) : false;
  const { error } = await supabaseServer.from(TABLE).delete().eq("id", true);
  return { ok: !error, revokedAtGoogle };
}

async function recordOrganizerError(message: string, disconnect: boolean): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_error: message.slice(0, MAX_ERROR), last_error_at: now, updated_at: now };
  if (disconnect) patch.status = "disconnected";
  await supabaseServer.from(TABLE).update(patch).eq("id", true);
}

// Resultado de una sincronización, para el panel docente.
export async function recordOrganizerSync(error: string | null): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = error
    ? { last_error: error.slice(0, MAX_ERROR), last_error_at: now, updated_at: now }
    : { last_synced_at: now, last_error: null, last_error_at: null, updated_at: now };
  await supabaseServer.from(TABLE).update(patch).eq("id", true);
}

export type OrganizerAccess =
  | { ok: true; accessToken: string; calendarId: string; googleEmail: string }
  | {
      ok: false;
      reason: "UNAVAILABLE" | "NOT_CONFIGURED" | "NOT_CONNECTED" | "TOKEN_UNREADABLE" | "REVOKED" | "GOOGLE_UNAVAILABLE";
    };

// Token de acceso de corta duración para llamar a Calendar como organizador. Si Google responde
// invalid_grant la conexión queda desconectada y el panel lo muestra.
export async function getOrganizerAccess(params: { fetchImpl?: FetchLike; config?: OAuthClientConfig | null } = {}): Promise<OrganizerAccess> {
  const config = params.config === undefined ? readOAuthClientConfig() : params.config;
  const key = getCalendarTokenKey();
  if (!config || !key.ok) return { ok: false, reason: "NOT_CONFIGURED" };

  const { data, error } = await supabaseServer
    .from(TABLE)
    .select("google_email, calendar_id, status, refresh_token_ciphertext")
    .eq("id", true)
    .maybeSingle();
  if (error) return { ok: false, reason: "UNAVAILABLE" };
  const row = data as Pick<OrganizerRow, "google_email" | "calendar_id" | "status" | "refresh_token_ciphertext"> | null;
  if (!row || row.status !== "connected") return { ok: false, reason: "NOT_CONNECTED" };

  // Ilegible con la clave de este entorno: no se toca la fila. Preview y local pueden compartir la
  // base con Production; un entorno con otra clave no debe desconectar la cuenta de Production.
  const refreshToken = decryptRefreshToken(key.key, row.refresh_token_ciphertext);
  if (!refreshToken) return { ok: false, reason: "TOKEN_UNREADABLE" };

  const access = await refreshGoogleAccessToken({ refreshToken, config, fetchImpl: params.fetchImpl });
  if (!access.ok) {
    if (access.reason === "REVOKED") {
      await recordOrganizerError(ORGANIZER_ERRORS.revoked, true);
      return { ok: false, reason: "REVOKED" };
    }
    return { ok: false, reason: "GOOGLE_UNAVAILABLE" };
  }
  return { ok: true, accessToken: access.accessToken, calendarId: row.calendar_id, googleEmail: row.google_email };
}
