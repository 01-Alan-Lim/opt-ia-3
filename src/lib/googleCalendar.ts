// src/lib/googleCalendar.ts
import { z } from "zod";

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

export type CalendarEventInput = {
  summary: string;
  description?: string;
  // ISO strings
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  reminders: {
    minutesBefore: number; // ej: 1440 (= 1 día)
    alsoAtStart: boolean;  // si true agrega reminder en 0 min
  };
};

export async function exchangeRefreshTokenForAccessToken(params: {
  refreshToken: string;
}): Promise<string> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_MISSING");
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", params.refreshToken);
  body.set("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new Error("GOOGLE_TOKEN_EXCHANGE_FAILED");
  }

  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("GOOGLE_TOKEN_EXCHANGE_INVALID");
  }

  return parsed.data.access_token;
}

export async function createCalendarEvent(params: {
  accessToken: string;
  calendarId: string;
  event: CalendarEventInput;
}): Promise<{ id: string }> {
  const { accessToken, calendarId, event } = params;

  const payload = {
    summary: event.summary,
    description: event.description ?? "",
    start: { dateTime: event.startDateTime, timeZone: event.timeZone },
    end: { dateTime: event.endDateTime, timeZone: event.timeZone },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: Math.max(0, event.reminders.minutesBefore) },
        ...(event.reminders.alsoAtStart ? [{ method: "popup", minutes: 0 }] : []),
      ],
    },
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.id) {
    throw new Error("GOOGLE_CALENDAR_CREATE_FAILED");
  }

  return { id: String(json.id) };
}

export async function patchCalendarEvent(params: {
  accessToken: string;
  calendarId: string;
  eventId: string;
  event: CalendarEventInput;
}): Promise<void> {
  const { accessToken, calendarId, eventId, event } = params;

  const payload = {
    summary: event.summary,
    description: event.description ?? "",
    start: { dateTime: event.startDateTime, timeZone: event.timeZone },
    end: { dateTime: event.endDateTime, timeZone: event.timeZone },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: Math.max(0, event.reminders.minutesBefore) },
        ...(event.reminders.alsoAtStart ? [{ method: "popup", minutes: 0 }] : []),
      ],
    },
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    throw new Error("GOOGLE_CALENDAR_PATCH_FAILED");
  }
}
