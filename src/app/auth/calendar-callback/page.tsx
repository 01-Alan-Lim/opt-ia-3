// src/app/auth/calendar-callback/page.tsx

import { Suspense } from "react";
import CalendarCallbackClient from "./CalendarCallbackClient";

// Evita que Next intente render estático en esta ruta
export const dynamic = "force-dynamic";

export default function CalendarCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CalendarCallbackClient />
    </Suspense>
  );
}