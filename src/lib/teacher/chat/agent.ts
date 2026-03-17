import { getGeminiModel } from "@/lib/geminiClient"
import {
  findStudentsByTerm,
  getChatsCount,
  getMessagesCount,
  getHoursTotal,
  getTopStudentsByMessages,
  getUsageSnapshot,
  getStudentDisplayName,
  loadStudentById,
} from "./tools"
import {
  TeacherRouterSchema,
  type ProfileStudent,
  type TeacherChatContext,
  type TeacherRouter,
} from "./types"

type StudentUsage = {
  chats: number
  messages: number
  hours: number
}

function extractFirstJsonObject(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

function parseTeacherRouter(raw: string): TeacherRouter | null {
  try {
    const parsed = JSON.parse(raw)
    const validated = TeacherRouterSchema.safeParse(parsed)
    return validated.success ? validated.data : null
  } catch {
    const candidate = extractFirstJsonObject(raw)
    if (!candidate) return null

    try {
      const parsed = JSON.parse(candidate)
      const validated = TeacherRouterSchema.safeParse(parsed)
      return validated.success ? validated.data : null
    } catch {
      return null
    }
  }
}

async function resolveStudent(
  router: TeacherRouter,
  context: TeacherChatContext
): Promise<
  | { kind: "missing" }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: ProfileStudent[] }
  | { kind: "ok"; student: ProfileStudent }
> {
  if (router.studentTerm?.trim()) {
    const matches = await findStudentsByTerm(router.studentTerm)

    if (matches.length === 0) {
      return { kind: "not_found" }
    }

    if (matches.length > 1) {
      return { kind: "ambiguous", matches }
    }

    return { kind: "ok", student: matches[0] }
  }

  if (context.studentId) {
    const student = await loadStudentById(context.studentId)
    if (student) {
      return { kind: "ok", student }
    }
  }

  return { kind: "missing" }
}

async function loadStudentUsage(userId: string): Promise<StudentUsage> {
  const [chats, messages, hours] = await Promise.all([
    getChatsCount(userId),
    getMessagesCount(userId),
    getHoursTotal(userId),
  ])

  return { chats, messages, hours }
}

function buildStudentContext(
  student: ProfileStudent,
  context: TeacherChatContext
): TeacherChatContext {
  return {
    studentId: student.user_id,
    studentName: getStudentDisplayName(student),
    ru: student.ru ?? undefined,
    stage: context.stage,
  }
}

function buildStudentLine(student: {
  ru: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
}) {
  return `${getStudentDisplayName(student)} (RU ${student.ru ?? "s/d"})`
}

export async function runTeacherChatAgent(
  message: string,
  context: TeacherChatContext
) {
  const model = getGeminiModel()

  const routerPrompt = `
Eres un asistente académico para docentes de Ingeniería de Métodos.

Tu tarea es interpretar la consulta del docente con flexibilidad semántica.
No dependas de palabras exactas.
Debes inferir la intención aunque el docente escriba de manera informal, incompleta o conversacional.

Devuelve SOLO un JSON válido.
No agregues explicación, ni markdown, ni texto fuera del JSON.

Tipos de intención permitidos:
- student_lookup
- student_report
- student_hours
- student_stages
- student_interactions
- usage_summary
- progress_summary
- top_students
- alerts
- stage_analysis
- clarify

Formato exacto:
{
  "intent": "clarify",
  "confidence": 0.0,
  "needsStudent": false,
  "studentTerm": "",
  "stage": 0,
  "question": ""
}

Reglas:
- Si el docente pregunta por un estudiante concreto, needsStudent=true.
- Si menciona RU, correo, nombre o apellido, colócalo en studentTerm.
- Si pregunta por horas, usa student_hours.
- Si pregunta por actividad, interacción, uso, mensajes o chats de un estudiante, usa student_interactions.
- Si pregunta por quiénes usan el sistema, uso global, estudiantes activos o actividad general, usa usage_summary.
- Si pide ranking, top, los más activos o quién usa más el agente, usa top_students.
- Si pide panorama general del grupo, usa progress_summary.
- Si pide avance por etapas, validación o análisis del plan, usa student_stages o stage_analysis.
- Si la consulta depende de un estudiante ya mencionado antes y no lo vuelve a nombrar, asume needsStudent=true.
- Si no alcanza la certeza, usa clarify.

Consulta del docente:
${message}

Contexto actual:
${JSON.stringify(context)}
`

  const routerResult = await model.generateContent(routerPrompt)
  const raw = routerResult.response.text().trim()
  const router = parseTeacherRouter(raw)

  if (!router) {
    return {
      message:
        "No logré interpretar la consulta del todo. Puedes pedirme, por ejemplo, un reporte de un estudiante, sus horas registradas, su nivel de actividad o un resumen general de uso del agente.",
      context,
    }
  }

  if (!router.needsStudent && router.intent === "usage_summary") {
    const snapshot = await getUsageSnapshot()

    if (snapshot.totalStudents === 0) {
      return {
        message:
          "Aún no veo estudiantes con actividad registrada en el agente. Cuando existan chats, mensajes u horas cargadas, podré resumirte el uso general.",
        context,
      }
    }

    const sample = snapshot.students
      .slice(0, 8)
      .map(
        (student) =>
          `• ${student.displayName} (RU ${student.ru ?? "s/d"}) — ${student.messages} mensajes, ${student.chats} chats, ${student.hours} horas`
      )
      .join("\n")

    return {
      message:
        `Claro, Inge. Ya veo actividad registrada de ${snapshot.totalStudents} estudiante(s).\n\n` +
        `En conjunto observo ${snapshot.totalChats} chats, ${snapshot.totalMessages} mensajes y ${snapshot.totalHours} horas registradas.\n\n` +
        `Los estudiantes con actividad visible son:\n${sample}\n\n` +
        `Si quieres, ahora puedo bajar esto a un estudiante específico o mostrarte quiénes son los más activos.`,
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
          `${index + 1}. ${student.displayName} (RU ${student.ru ?? "s/d"}) — ${student.messages} mensajes, ${student.chats} chats, ${student.hours} horas`
      )
      .join("\n")

    return {
      message:
        `Claro, Inge. Por actividad registrada, este sería el grupo más activo hasta ahora:\n\n${list}\n\n` +
        `Si quieres, te doy enseguida el reporte individual de cualquiera de ellos.`,
      context,
    }
  }

  if (!router.needsStudent && router.intent === "progress_summary") {
    const snapshot = await getUsageSnapshot()

    if (snapshot.totalStudents === 0) {
      return {
        message:
          "Aún no hay suficiente actividad para resumir el progreso general del grupo.",
        context,
      }
    }

    const activeWithHours = snapshot.students.filter((student) => student.hours > 0).length

    return {
      message:
        `Claro, Inge. A nivel general ya hay ${snapshot.totalStudents} estudiante(s) con actividad registrada.\n\n` +
        `${activeWithHours} de ellos ya tienen horas cargadas, y en total se observan ${snapshot.totalChats} chats y ${snapshot.totalMessages} mensajes.\n\n` +
        `Si quieres, ahora lo convierto en un análisis más puntual por estudiante.`,
      context,
    }
  }

  if (router.needsStudent || context.studentId) {
    const resolved = await resolveStudent(router, context)

    if (resolved.kind === "missing") {
      return {
        message:
          "Para ayudarte con ese análisis necesito que me indiques el RU, el nombre o el correo institucional del estudiante.",
        context,
      }
    }

    if (resolved.kind === "not_found") {
      return {
        message:
          "No encontré coincidencias para ese estudiante. Puedes enviarme el RU, el correo institucional o el nombre y apellido.",
        context,
      }
    }

    if (resolved.kind === "ambiguous") {
      const list = resolved.matches.map((item) => `• ${buildStudentLine(item)}`).join("\n")

      return {
        message:
          `Encontré varios estudiantes posibles:\n\n${list}\n\n` +
          `Indícame cuál deseas revisar y continúo con el detalle.`,
        context,
      }
    }

    const student = resolved.student
    const usage = await loadStudentUsage(student.user_id)
    const nextContext = buildStudentContext(student, context)
    const displayName = getStudentDisplayName(student)

    if (router.intent === "student_hours") {
      return {
        message:
          `Claro, Inge. ${displayName} lleva ${usage.hours} hora(s) registradas hasta ahora.\n\n` +
          `Además, veo ${usage.chats} chat(s) y ${usage.messages} mensaje(s) en la plataforma.\n\n` +
          `Si quieres, en el siguiente mensaje te hago una lectura rápida de qué sugiere ese nivel de actividad.`,
        context: nextContext,
      }
    }

    if (router.intent === "student_interactions") {
      return {
        message:
          `Claro, Inge. ${displayName} registra ${usage.chats} chat(s) y ${usage.messages} mensaje(s) en el sistema.\n\n` +
          `En horas acumuladas lleva ${usage.hours}.\n\n` +
          `Si te parece, también puedo interpretarte si esa participación se ve baja, media o activa dentro del uso esperado.`,
        context: nextContext,
      }
    }

    if (router.intent === "student_stages" || router.intent === "stage_analysis") {
      return {
        message:
          `Puedo ubicar al estudiante y resumirte su actividad general, pero en el ZIP actual el chat docente todavía no tiene conectada una lectura específica por etapas del plan de mejora.\n\n` +
          `${displayName} sí presenta ${usage.chats} chat(s), ${usage.messages} mensaje(s) y ${usage.hours} hora(s) registradas.\n\n` +
          `Si quieres, por ahora te doy un reporte general y luego conectamos el detalle por etapas sobre las tablas reales del plan.`,
        context: nextContext,
      }
    }

    if (router.intent === "alerts") {
      return {
        message:
          `Por ahora el chat docente no tiene una regla automática de alertas conectada. Aun así, sí puedo resumirte los indicadores básicos de ${displayName}.\n\n` +
          `Actualmente acumula ${usage.hours} hora(s), ${usage.chats} chat(s) y ${usage.messages} mensaje(s).\n\n` +
          `Si quieres, te hago una interpretación breve de esos datos.`,
        context: nextContext,
      }
    }

    const responsePrompt = `
Eres un asistente académico para docentes de Ingeniería de Métodos.

Responde en español con tono natural, profesional, cercano y analítico.
No suenes robótico.
No inventes datos.
No repitas la pregunta del docente.
No uses listas largas.
Máximo 170 palabras.

Datos reales del estudiante:
- Nombre: ${displayName}
- RU: ${student.ru ?? "Sin RU"}
- Chats: ${usage.chats}
- Mensajes: ${usage.messages}
- Horas registradas: ${usage.hours}

Tu respuesta debe:
1. resumir el estado actual,
2. interpretar brevemente qué sugieren esos datos,
3. proponer el siguiente ángulo útil a revisar.

Consulta del docente:
${message}
`

    const response = await model.generateContent(responsePrompt)

    return {
      message: response.response.text().trim(),
      context: nextContext,
    }
  }

  return {
    message:
      "Claro, Inge. Puedo ayudarte con reportes por estudiante, horas registradas, actividad del agente o panorama general del grupo. También puedes escribirme algo como “quiénes están usando el agente”, “quiénes son los más activos” o darme directamente el RU o nombre del estudiante.",
    context,
  }
}