// src/lib/calendar/organizerCsrf.ts
//
// CSRF del OAuth del organizador. /start genera un valor aleatorio que viaja en el state de Google
// y en una cookie httpOnly limitada a las rutas del organizador; /callback exige los dos y que
// coincidan. Así nadie puede hacer que un docente conecte una cuenta de Google ajena con un
// enlace preparado. Solo servidor.

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { NextResponse } from "next/server";

import { decodeOrganizerState } from "./googleOAuth";

export const ORGANIZER_CSRF_COOKIE = "gc_org_csrf";
const COOKIE_PATH = "/api/teacher/calendar-organizer";
const MAX_AGE_SECONDS = 600;

export function newOrganizerCsrf(): string {
  return randomBytes(24).toString("base64url");
}

function cookieOptions(req: Request, maxAge: number) {
  return {
    httpOnly: true,
    secure: new URL(req.url).protocol === "https:",
    sameSite: "strict" as const,
    path: COOKIE_PATH,
    maxAge,
  };
}

export function setOrganizerCsrfCookie(res: NextResponse, req: Request, csrf: string): void {
  res.cookies.set(ORGANIZER_CSRF_COOKIE, csrf, cookieOptions(req, MAX_AGE_SECONDS));
}

export function clearOrganizerCsrfCookie(res: NextResponse, req: Request): void {
  res.cookies.set(ORGANIZER_CSRF_COOKIE, "", cookieOptions(req, 0));
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

export function organizerCsrfMatches(req: Request, state: unknown): boolean {
  const decoded = decodeOrganizerState(state);
  const cookie = readCookie(req, ORGANIZER_CSRF_COOKIE);
  if (!decoded || !cookie) return false;
  const a = Buffer.from(decoded.csrf, "utf8");
  const b = Buffer.from(cookie, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
