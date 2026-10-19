// src/lib/auth/requireTeacher.ts
//
// Guarda común de las rutas solo para docentes: identidad y rol los resuelve requireUser en el
// servidor (TEACHER_EMAIL_ALLOWLIST), nunca el navegador. Devuelve el usuario o la respuesta de
// error lista para devolver.

import { failResponse } from "@/lib/api/response";
import { getAuthErrorCode, requireUser, type AuthedUser } from "@/lib/auth/supabase";

export async function requireTeacher(req: Request): Promise<{ ok: true; user: AuthedUser } | { ok: false; res: Response }> {
  try {
    const user = await requireUser(req);
    if (user.role !== "teacher") return { ok: false, res: failResponse("FORBIDDEN", "Solo docentes.", 403) };
    return { ok: true, user };
  } catch (err: unknown) {
    const code = getAuthErrorCode(err);
    if (code === "UNAUTHORIZED") return { ok: false, res: failResponse("UNAUTHORIZED", "Sesión inválida o ausente.", 401) };
    if (code === "FORBIDDEN_DOMAIN") return { ok: false, res: failResponse("FORBIDDEN", "Acceso restringido.", 403) };
    return { ok: false, res: failResponse("INTERNAL", "No se pudo validar la sesión.", 500) };
  }
}
