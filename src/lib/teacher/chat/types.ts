import { z } from "zod"

export type Intent =
  | "student_lookup"
  | "student_report"
  | "student_hours"
  | "student_stages"
  | "student_interactions"
  | "usage_summary"
  | "progress_summary"
  | "top_students"
  | "alerts"
  | "stage_analysis"
  | "clarify"

export type TeacherRouter = {
  intent: Intent
  confidence: number
  needsStudent: boolean
  studentTerm?: string
  stage?: number
  question?: string
}

export const TeacherRouterSchema = z.object({
  intent: z.enum([
    "student_lookup",
    "student_report",
    "student_hours",
    "student_stages",
    "student_interactions",
    "usage_summary",
    "progress_summary",
    "top_students",
    "alerts",
    "stage_analysis",
    "clarify",
  ]),
  confidence: z.number().min(0).max(1),
  needsStudent: z.boolean(),
  studentTerm: z.string().optional(),
  stage: z.number().optional(),
  question: z.string().optional(),
})

export type ProfileStudent = {
  user_id: string
  ru: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
}

export type TeacherChatContext = {
  studentId?: string
  studentName?: string
  ru?: string
  stage?: number
}