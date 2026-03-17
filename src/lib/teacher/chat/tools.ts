import { supabaseServer } from "@/lib/supabaseServer"
import type { ProfileStudent } from "./types"

type WeeklyHourRow = {
  hours: number | null
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
  const supabase = supabaseServer

  const { count, error } = await supabase
    .from("chats")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)

  if (error) {
    throw error
  }

  return count ?? 0
}

export async function getMessagesCount(userId: string): Promise<number> {
  const supabase = supabaseServer

  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)

  if (error) {
    throw error
  }

  return count ?? 0
}

export async function getHoursTotal(userId: string): Promise<number> {
  const supabase = supabaseServer

  const { data, error } = await supabase
    .from("weekly_hours")
    .select("hours")
    .eq("user_id", userId)

  if (error) {
    throw error
  }

  const rows = (data ?? []) as WeeklyHourRow[]

  return rows.reduce((sum: number, row: WeeklyHourRow) => {
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