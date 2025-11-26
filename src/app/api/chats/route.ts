import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function GET() {
  const clientId = "demo-client";

  const { data, error } = await supabase
    .from("chats")
    .select("id, title, created_at")
    .eq("client_id", clientId)
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
