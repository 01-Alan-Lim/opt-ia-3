import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export async function POST(req: Request) {
  try {
    const { userId, email } = await req.json();

    if (!userId) {
      return NextResponse.json(
        { error: "Falta userId" },
        { status: 400 }
      );
    }

    // Lista de correos de docentes desde env
    const teacherEmails =
      process.env.NEXT_PUBLIC_TEACHER_EMAILS
        ?.split(",")
        .map((e) => e.trim().toLowerCase()) ?? [];

    let role: "student" | "teacher" = "student";

    if (email && teacherEmails.includes(email.toLowerCase())) {
      role = "teacher";
    }

    // Upsert del perfil
    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        {
          user_id: userId,
          email,
          role,
        },
        { onConflict: "user_id" }
      )
      .select("role")
      .single();

    if (error) {
      console.error("Error upserting profile:", error);
      return NextResponse.json(
        { error: "No se pudo guardar perfil" },
        { status: 500 }
      );
    }

    const finalRole = (data?.role as "student" | "teacher") ?? role;

    return NextResponse.json({ role: finalRole });
  } catch (err) {
    console.error("Error en /api/auth/after-login:", err);
    return NextResponse.json(
      { error: "Error interno" },
      { status: 500 }
    );
  }
}
