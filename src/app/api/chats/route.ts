// src/app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json(
      { error: "Falta el parámetro userId" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("chats")
    .select("id, title, created_at")
    .eq("client_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error obteniendo chats:", error);
    return NextResponse.json(
      { error: "No se pudieron obtener los chats" },
      { status: 500 }
    );
  }

  const chats = (data || []).map((c) => ({
    id: c.id as string,
    title: (c.title as string) || "Chat sin título",
    createdAt: c.created_at as string,
  }));

  return NextResponse.json({ chats });
}
