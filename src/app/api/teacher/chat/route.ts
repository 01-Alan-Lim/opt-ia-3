import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { ok, fail } from "@/lib/api/response"
import { requireUser } from "@/lib/auth/supabase"
import { runTeacherChatAgent } from "@/lib/teacher/chat/agent"

export const runtime = "nodejs"

const BodySchema = z.object({
  message: z.string().min(1, "El mensaje es obligatorio."),
  context: z
    .object({
      studentId: z.string().optional(),
      studentName: z.string().optional(),
      ru: z.string().optional(),
      stage: z.number().optional(),
    })
    .optional(),
})

export async function POST(req: NextRequest) {
  try {
    const authed = await requireUser(req)

    if (authed.role !== "teacher") {
      return NextResponse.json(
        fail("FORBIDDEN", "Solo docentes pueden usar este chat."),
        { status: 403 }
      )
    }

    const body = await req.json()
    const parsed = BodySchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        fail("BAD_REQUEST", "Payload inválido.", parsed.error.flatten()),
        { status: 400 }
      )
    }

    const { message, context } = parsed.data

    const result = await runTeacherChatAgent(message, context ?? {})

    return ok(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN"

    if (message === "UNAUTHORIZED") {
      return NextResponse.json(
        fail("UNAUTHORIZED", "Sesión inválida o ausente."),
        { status: 401 }
      )
    }

    if (message === "FORBIDDEN_DOMAIN") {
      return NextResponse.json(
        fail("FORBIDDEN", "Acceso restringido."),
        { status: 403 }
      )
    }

    return NextResponse.json(
      fail("INTERNAL", "Error interno en chat docente.", error),
      { status: 500 }
    )
  }
}