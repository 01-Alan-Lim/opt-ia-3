// src/app/api/plans/context/route.ts

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/supabase";
import { supabaseServer } from "@/lib/supabaseServer";
import { ok, fail } from "@/lib/api/response";
import { assertChatAccess } from "@/lib/auth/chatAccess";

export const runtime = "nodejs";

const ContextUpsertSchema = z.object({
  chatId: z.string().uuid().nullable().optional(),

  // ✅ nuevo: para forzar creación de chat
  forceNew: z.boolean().optional(),

  contextJson: z.record(z.string(), z.any()).optional(),

  // ✅ IMPORTANTE: permitir null para evitar el error "expected string, received null"
  contextText: z.string().max(5000).nullable().optional(),

  // ✅ nuevo: para que el backend guarde el diálogo del wizard en la tabla messages
  userMessage: z.string().min(1).optional(),
  assistantMessage: z.string().min(1).optional(),
});

async function getRow(userId: string) {
  return supabaseServer
    .from("plan_case_contexts")
    .select("id,user_id,chat_id,status,version,context_json,context_text,created_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
}

export async function GET(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    const { data, error } = await getRow(authed.userId);
    if (error) {
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el contexto del caso.", error), {
        status: 500,
      });
    }

    // Si no existe, devolvemos un default (sin crear nada todavía)
    return ok({
      status: data?.status ?? "draft",
      version: data?.version ?? 1,
      chatId: data?.chat_id ?? null,
      contextJson: data?.context_json ?? {},
      contextText: data?.context_text ?? null,
      exists: !!data,
    });
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

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);

    const gate = await assertChatAccess(req);
    if (!gate.ok) {
      return NextResponse.json(fail("FORBIDDEN", gate.message), { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(fail("BAD_REQUEST", "Body JSON inválido."), { status: 400 });
    }

    const parsed = ContextUpsertSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Payload inválido."),
        { status: 400 }
      );
    }

    const chatId = parsed.data.chatId ?? null;
    const forceNew = parsed.data.forceNew ?? false;

    const incomingJson = parsed.data.contextJson ?? {};
    const contextText = parsed.data.contextText ?? null;

    const userMessage = parsed.data.userMessage;
    const assistantMessage = parsed.data.assistantMessage;

    // 1) Leemos contexto actual (para merge)
    const { data: current, error: curErr } = await getRow(authed.userId);
    if (curErr) {
      return NextResponse.json(fail("INTERNAL", "No se pudo leer el contexto actual.", curErr), {
        status: 500,
      });
    }

    // 2) Detectar "solo crear chat"
    const isChatOnly =
      forceNew &&
      Object.keys(incomingJson).length === 0 &&
      contextText === null &&
      !userMessage &&
      !assistantMessage;

    // 3) Definir chatId efectivo (si forceNew => siempre crear nuevo)
    let effectiveChatId: string | null = null;

    if (!forceNew) {
      effectiveChatId = chatId ?? (current?.chat_id as string | null) ?? null;
    }

    if (!effectiveChatId) {
      const { data: createdChat, error: chatErr } = await supabaseServer
        .from("chats")
        .insert({
          client_id: authed.userId,
          title: "Asesor - Contexto del Caso",
          mode: "plan_mejora",
        })
        .select("id")
        .single();

      if (chatErr || !createdChat?.id) {
        return NextResponse.json(
          fail("INTERNAL", "No se pudo crear el chat para el asesor.", chatErr),
          { status: 500 }
        );
      }

      effectiveChatId = createdChat.id as string;
    }

    // 4) isChatOnly:
    // ✅ NO guardamos mensajes automáticos.
    // ✅ SÍ sincronizamos plan_case_contexts.chat_id al chat nuevo, manteniendo el progreso.
    if (isChatOnly) {
      const keptStatus = (current?.status ?? "draft") as "draft" | "confirmed";
      const keptVersion = current?.version ?? 1;
      const keptJson =
        current?.context_json && typeof current.context_json === "object"
          ? (current.context_json as any)
          : {};
      const keptText = current?.context_text ?? null;

      const { data: synced, error: syncErr } = await supabaseServer
        .from("plan_case_contexts")
        .upsert(
          {
            user_id: authed.userId,
            chat_id: effectiveChatId,
            status: keptStatus,
            version: keptVersion,
            context_json: keptJson,
            context_text: keptText,
          },
          { onConflict: "user_id" }
        )
        .select("status,version,chat_id,context_json,context_text")
        .single();

      if (syncErr || !synced) {
        return NextResponse.json(
          fail("INTERNAL", "No se pudo sincronizar el chat del asesor.", syncErr),
          { status: 500 }
        );
      }

      return ok({
        exists: true,
        status: synced.status,
        version: synced.version,
        chatId: synced.chat_id,
        contextJson: synced.context_json,
        contextText: synced.context_text,
      });
    }

    // 5) Merge JSON (si forceNew => limpio)
    const mergedJson =
      forceNew
        ? { ...incomingJson }
        : current?.context_json && typeof current.context_json === "object"
        ? { ...(current.context_json as any), ...incomingJson }
        : { ...incomingJson };

    // 6) Mejorar título por sector
    const sectorTitle =
      typeof (mergedJson as any)?.sector === "string" ? (mergedJson as any).sector.trim() : "";
    if (sectorTitle) {
      await supabaseServer
        .from("chats")
        .update({ title: `Asesor - ${sectorTitle}` })
        .eq("id", effectiveChatId);
    }

    // 7) Upsert plan_case_contexts
    const { data, error } = await supabaseServer
      .from("plan_case_contexts")
      .upsert(
        {
          user_id: authed.userId,
          chat_id: effectiveChatId,
          status: (forceNew ? "draft" : (current?.status ?? "draft")) as "draft" | "confirmed",
          version: current?.version ?? 1,
          context_json: mergedJson,
          context_text: contextText ?? current?.context_text ?? null,
        },
        { onConflict: "user_id" }
      )
      .select("status,version,chat_id,context_json,context_text")
      .single();

    if (error || !data) {
      return NextResponse.json(fail("INTERNAL", "No se pudo guardar el contexto del caso.", error), {
        status: 500,
      });
    }

    // 8) Guardar conversación del wizard (si vino)
    if (userMessage) {
      await supabaseServer.from("messages").insert({
        chat_id: effectiveChatId,
        role: "user",
        content: userMessage,
      });
    }

    if (assistantMessage) {
      await supabaseServer.from("messages").insert({
        chat_id: effectiveChatId,
        role: "assistant",
        content: assistantMessage,
      });
    }

    // 9) Importante: NO insertar prompts automáticos aquí.
    // El FE manda assistantMessage cuando corresponde, para evitar duplicados y estados inconsistentes.

    return ok({
      status: data.status,
      version: data.version,
      chatId: data.chat_id,
      contextJson: data.context_json,
      contextText: data.context_text,
    });
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
