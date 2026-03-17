import { getGeminiModel } from "@/lib/geminiClient"
import {
  findStudentsByTerm,
  getChatsCount,
  getMessagesCount,
  getHoursTotal,
  getTopStudentsByMessages,
  getUsageSnapshot,
  loadStudentById,
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
  const raw = routerResult.response.text().trim()

  let router: TeacherRouter | null = null

  try {
    // intenta parse directo
    router = JSON.parse(raw)
  } catch {
    // intenta extraer JSON dentro del texto
    const match = raw.match(/\{[\s\S]*\}/)

    if (match) {
      try {
        router = JSON.parse(match[0])
      } catch {
        router = null
      }
    }
  }

  if (!router) {
    return {
      message:
        "No logré interpretar la consulta. Puedes pedirme por ejemplo:\n\n• reporte de un estudiante\n• progreso de un estudiante\n• actividad del agente\n• horas registradas",
      context,
    }
  }

  if (!router.needsStudent && router.intent === "usage_summary") {
  const snapshot = await getUsageSnapshot()

  if (snapshot.totalStudents === 0) {
    return {
      message:
        "Aún no veo estudiantes con actividad registrada en el agente. Cuando existan chats, mensajes u horas cargadas, te podré resumir el uso.",
      context,
    }
  }

  const sample = snapshot.students
    .slice(0, 8)
    .map(
      (student) =>
        `• ${student.full_name ?? "Sin nombre"} (RU ${student.ru ?? "s/d"}) — ${student.messages} mensajes, ${student.chats} chats, ${student.hours} horas`
    )
    .join("\n")

  return {
    message:
      `Claro, Inge. Hasta ahora veo actividad de ${snapshot.totalStudents} estudiante(s).\n\n` +
      `Resumen general:\n` +
      `• Chats: ${snapshot.totalChats}\n` +
      `• Mensajes: ${snapshot.totalMessages}\n` +
      `• Horas registradas: ${snapshot.totalHours}\n\n` +
      `Estudiantes con actividad:\n${sample}\n\n` +
      `Si quieres, ahora puedo darte el detalle de uno en particular o mostrarte quiénes son los que más uso han tenido.`,
    context,
  }
}

if (!router.needsStudent && router.intent === "top_students") {
  const top = await getTopStudentsByMessages(5)

  if (top.length === 0) {
    return {
      message:
        "Todavía no encuentro actividad suficiente para elaborar un ranking de uso del agente.",
      context,
    }
  }

  const list = top
    .map(
      (student, index) =>
        `${index + 1}. ${student.full_name ?? "Sin nombre"} (RU ${student.ru ?? "s/d"}) — ${student.messages} mensajes, ${student.chats} chats, ${student.hours} horas`
    )
    .join("\n")

  return {
    message:
      `Claro, Inge. Este es el grupo con mayor actividad registrada hasta ahora:\n\n${list}\n\n` +
      `Si quieres, te doy el reporte completo de cualquiera de ellos.`,
    context,
  }
}

if (!router.needsStudent && router.intent === "progress_summary") {
  const snapshot = await getUsageSnapshot()

  if (snapshot.totalStudents === 0) {
    return {
      message:
        "Aún no hay suficiente actividad para resumir el progreso general de los estudiantes.",
      context,
    }
  }

  const activeWithHours = snapshot.students.filter((student) => student.hours > 0).length

  return {
    message:
      `Claro, Inge. En general ya hay ${snapshot.totalStudents} estudiante(s) con actividad en el sistema.\n\n` +
      `Además, ${activeWithHours} ya registraron horas de práctica.\n` +
      `En total observo ${snapshot.totalChats} chats y ${snapshot.totalMessages} mensajes generados.\n\n` +
      `Si quieres, en el siguiente mensaje puedo bajar esto a un estudiante específico por RU, nombre o correo.`,
    context,
  }
}

  if (router.needsStudent) {
  let student = null

  if (router.studentTerm?.trim()) {
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
        .map((item) => `• ${item.full_name ?? "Sin nombre"} (RU ${item.ru ?? "s/d"})`)
        .join("\n")

      return {
        message:
          `Encontré varios estudiantes posibles:\n\n${list}\n\n` +
          `Indícame cuál deseas revisar y te doy el detalle.`,
        context,
      }
    }

    student = matches[0]
  } else if (context.studentId) {
    student = await loadStudentById(context.studentId)
  }

  if (!student) {
    return {
      message:
        "Para ayudarte con ese reporte necesito que me indiques el RU, el nombre o el correo institucional del estudiante.",
      context,
    }
  }

  const [chats, messages, hours] = await Promise.all([
    getChatsCount(student.id),
    getMessagesCount(student.id),
    getHoursTotal(student.id),
  ])

  const responsePrompt = `
Eres un asistente académico para docentes de Ingeniería de Métodos.

Responde en español, con tono natural, claro y profesional.
No suenes robótico.
Habla como apoyo docente útil y cercano.
No inventes datos.

Datos del estudiante:
- Nombre: ${student.full_name ?? "Sin nombre"}
- RU: ${student.ru ?? "Sin RU"}
- Chats: ${chats}
- Mensajes: ${messages}
- Horas registradas: ${hours}

Objetivo:
1. resumir el estado actual del estudiante,
2. interpretar brevemente qué significa,
3. sugerir cuál podría ser el siguiente dato útil a revisar.

Máximo 170 palabras.
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
    "Claro, Inge. Puedo ayudarte con reportes por estudiante, horas registradas, progreso general o actividad del agente. También puedes escribirme algo como “quiénes están usando el agente” o darme el RU, nombre o correo de un estudiante.",
  context,
}
}

