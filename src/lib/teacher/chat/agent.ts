import { getGeminiModel } from "@/lib/geminiClient"
import {
  findStudentsByTerm,
  getChatsCount,
  getMessagesCount,
  getHoursTotal,
} from "./tools"
import type { TeacherChatContext, TeacherRouter } from "./types"

export async function runTeacherChatAgent(
  message: string,
  context: TeacherChatContext
) {
  const model = getGeminiModel()

  const routerPrompt = `
Eres un asistente académico para docentes de Ingeniería de Métodos.

Analiza la consulta del docente y devuelve SOLO un JSON válido.

Tipos de intención posibles:
- student_report
- student_hours
- student_stages
- usage_summary
- progress_summary
- top_students
- alerts
- clarify

Devuelve este formato exacto:
{
  "intent": "clarify",
  "confidence": 0.0,
  "needsStudent": false,
  "studentTerm": ""
}

Reglas:
- Si el docente pide reporte, análisis o revisión de un estudiante, needsStudent=true.
- Si menciona un nombre, RU o email, colócalo en studentTerm.
- Si no estás seguro, usa intent="clarify".

Consulta:
${message}
`

  const routerResult = await model.generateContent(routerPrompt)
  const text = routerResult.response.text().trim()

  let router: TeacherRouter

  try {
    router = JSON.parse(text) as TeacherRouter
  } catch {
    return {
      message:
        "No pude interpretar bien la consulta del docente. Reformúlala indicando estudiante, RU o tipo de reporte.",
      context,
    }
  }

  if (router.needsStudent && router.studentTerm) {
    const matches = await findStudentsByTerm(router.studentTerm)

    if (matches.length === 0) {
      return {
        message:
          "No encontré coincidencias para ese estudiante. Envíame el RU, el email institucional o el nombre completo.",
        context,
      }
    }

    if (matches.length > 1) {
      const list = matches
        .map((student) => `• ${student.full_name ?? "Sin nombre"} (RU ${student.ru ?? "s/d"})`)
        .join("\n")

      return {
        message: `Encontré varios estudiantes posibles:\n\n${list}\n\nIndícame cuál deseas analizar.`,
        context,
      }
    }

    const student = matches[0]

    const chats = await getChatsCount(student.id)
    const messages = await getMessagesCount(student.id)
    const hours = await getHoursTotal(student.id)

    const responsePrompt = `
Eres un asistente académico para docentes.

Redacta una respuesta breve, clara y útil con tono profesional.

Datos del estudiante:
- Nombre: ${student.full_name ?? "Sin nombre"}
- RU: ${student.ru ?? "Sin RU"}
- Chats: ${chats}
- Mensajes: ${messages}
- Horas registradas: ${hours}

La respuesta debe:
1. resumir el estado del estudiante,
2. interpretar brevemente qué significa,
3. sugerir el siguiente dato útil que el docente podría pedir.
`

    const response = await model.generateContent(responsePrompt)

    return {
      message: response.response.text().trim(),
      context: {
        studentId: student.id,
        studentName: student.full_name ?? undefined,
        ru: student.ru ?? undefined,
        stage: context.stage,
      },
    }
  }

  return {
    message:
      "Puedo ayudarte con reportes, actividad, horas o progreso de un estudiante. Indícame su nombre, RU o email institucional.",
    context,
  }
}