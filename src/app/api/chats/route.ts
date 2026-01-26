// src/app/api/chats/route.ts
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, failResponse } from "@/lib/api/response";


const QuerySchema = z.object({
  // no necesitamos userId; lo ignoramos para no confiar en el cliente
});

export async function GET(req: NextRequest) {
  try {
    QuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));

    const user = await requireUser(req);

    const { data, error } = await supabaseServer
      .from("chats")
      .select("id, title, created_at, mode, pinned, hidden")
      .eq("client_id", user.userId)
      .eq("hidden", false)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      return failResponse("INTERNAL", "No se pudieron obtener los chats", 500);
    }

    const chats = (data || []).map((c) => ({
      id: c.id as string,
      title: (c.title as string) || "Chat sin título",
      createdAt: c.created_at as string,
      mode: (c.mode as string) ?? "general",
      pinned: Boolean((c as any).pinned),
    }));

    return ok({ chats });
  } catch (err: any) {
    if (err?.message === "UNAUTHORIZED") {
      return failResponse("UNAUTHORIZED", "No autenticado", 401);
    }
    if (err?.message === "FORBIDDEN_DOMAIN") {
      return failResponse("FORBIDDEN_DOMAIN", "Correo no permitido", 403);
    }
    if (err?.name === "ZodError") {
      return failResponse("BAD_REQUEST", "Parámetros inválidos", 400);
    }
    return failResponse("INTERNAL", "Error interno", 500);
  }

}
