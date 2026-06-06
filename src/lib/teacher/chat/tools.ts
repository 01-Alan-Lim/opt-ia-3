import { supabaseServer } from "@/lib/supabaseServer"
import type { ProfileStudent } from "./types"

type HoursEntryRow = {
  hours: number | null
}

type ChatIdRow = {
  id: string
}

/**
 * Valida que un identificador recibido (p. ej. el studentId del contexto del
 * chat docente) sea un string no vacío antes de usarlo en consultas
 * server-side. Evita lanzar consultas con valores vacíos/whitespace.
 */
function isNonEmptyId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0
}

export function getStudentDisplayName(student: {
  first_name: string | null
  last_name: string | null
  email: string | null
}) {
  const fullName = [student.first_name, student.last_name]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim()

  if (fullName) return fullName
  return student.email ?? "Sin nombre"
}

export async function findStudentsByTerm(term: string): Promise<ProfileStudent[]> {
  const cleanTerm = term.trim()
  const supabase = supabaseServer

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, ru, first_name, last_name, email")
    .eq("role", "student")
    .or(
      `ru.ilike.%${cleanTerm}%,first_name.ilike.%${cleanTerm}%,last_name.ilike.%${cleanTerm}%,email.ilike.%${cleanTerm}%`
    )
    .limit(5)

  if (error) {
    throw error
  }

  return (data ?? []) as ProfileStudent[]
}

export async function loadStudentById(userId: string): Promise<ProfileStudent | null> {
  if (!isNonEmptyId(userId)) return null

  const supabase = supabaseServer

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, ru, first_name, last_name, email")
    .eq("user_id", userId)
    .eq("role", "student")
    .maybeSingle()

  if (error) {
    throw error
  }

  return (data as ProfileStudent | null) ?? null
}

export async function getChatsCount(userId: string): Promise<number> {
  if (!isNonEmptyId(userId)) return 0

  const supabase = supabaseServer

  // La tabla `chats` identifica al estudiante por `client_id` (text), no por
  // `user_id`. `client_id` coincide con `profiles.user_id`.
  const { count, error } = await supabase
    .from("chats")
    .select("*", { count: "exact", head: true })
    .eq("client_id", userId)

  if (error) {
    throw error
  }

  return count ?? 0
}

export async function getMessagesCount(userId: string): Promise<number> {
  if (!isNonEmptyId(userId)) return 0

  const supabase = supabaseServer

  // `messages` no tiene `user_id`: se relaciona con el estudiante vía
  // `messages.chat_id` -> `chats.id`, y `chats.client_id` = profiles.user_id.
  const { data: chatRows, error: chatErr } = await supabase
    .from("chats")
    .select("id")
    .eq("client_id", userId)

  if (chatErr) {
    throw chatErr
  }

  const chatIds = (chatRows ?? []).map((row: ChatIdRow) => row.id)
  if (chatIds.length === 0) {
    return 0
  }

  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .in("chat_id", chatIds)

  if (error) {
    throw error
  }

  return count ?? 0
}

export async function getHoursTotal(userId: string): Promise<number> {
  if (!isNonEmptyId(userId)) return 0

  const supabase = supabaseServer

  // La tabla real de horas es `hours_entries` (no existe `weekly_hours`).
  // Identifica al estudiante por `user_id` y suma la columna numérica `hours`.
  const { data, error } = await supabase
    .from("hours_entries")
    .select("hours")
    .eq("user_id", userId)

  if (error) {
    throw error
  }

  const rows = (data ?? []) as HoursEntryRow[]

  return rows.reduce((sum: number, row: HoursEntryRow) => {
    return sum + (row.hours ?? 0)
  }, 0)
}

export async function getStudentsUsingAgent() {
  const supabase = supabaseServer

  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, ru, first_name, last_name, email")
    .eq("role", "student")
    .order("created_at", { ascending: false })

  if (error) {
    throw error
  }

  const students = (data ?? []) as ProfileStudent[]

  const rows = await Promise.all(
    students.map(async (student) => {
      const [chats, messages, hours] = await Promise.all([
        getChatsCount(student.user_id),
        getMessagesCount(student.user_id),
        getHoursTotal(student.user_id),
      ])

      return {
        ...student,
        displayName: getStudentDisplayName(student),
        chats,
        messages,
        hours,
      }
    })
  )

  return rows.filter((row) => row.chats > 0 || row.messages > 0 || row.hours > 0)
}

export async function getTopStudentsByMessages(limit = 5) {
  const rows = await getStudentsUsingAgent()

  return rows
    .sort((a, b) => {
      if (b.messages !== a.messages) return b.messages - a.messages
      if (b.chats !== a.chats) return b.chats - a.chats
      return b.hours - a.hours
    })
    .slice(0, limit)
}

export async function getUsageSnapshot() {
  const rows = await getStudentsUsingAgent()

  const totalStudents = rows.length
  const totalChats = rows.reduce((sum, row) => sum + row.chats, 0)
  const totalMessages = rows.reduce((sum, row) => sum + row.messages, 0)
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0)

  return {
    totalStudents,
    totalChats,
    totalMessages,
    totalHours,
    students: rows,
  }
}