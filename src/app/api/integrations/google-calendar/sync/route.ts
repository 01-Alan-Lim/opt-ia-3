// src/app/api/integrations/google-calendar/sync/route.ts
import { failResponse } from "@/lib/api/response";

export const runtime = "nodejs";

// Retirada: los estudiantes ya no conectan su propio Google Calendar. Las fechas de la cohorte
// les llegan como invitaciones del calendario organizador de OPT-IA (src/lib/calendar), que
// configura un docente. Se responde 410 sin tocar la base ni Google, para cualquier usuario.
// La tabla user_google_calendar_tokens no tenía filas y M3 retira su escritura desde el cliente.
export async function POST() {
  return failResponse("GONE", "La conexión individual de Google Calendar ya no está disponible.", 410);
}
