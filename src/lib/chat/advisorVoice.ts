// src/lib/chat/advisorVoice.ts
//
// Estilo conversacional del asesor, pensado para E0-E10. Hoy lo usan la Etapa 0
// (src/lib/plan/stage0Context.ts) y el saludo del Asistente General; E1-E10 todavía arman sus
// textos por su cuenta y deben adoptarlo cuando se revisen. Pautas:
//   - Lenguaje natural, cercano y profesional, de mentor académico: orienta, y las decisiones y
//     los datos son del estudiante.
//   - Una sola pregunta principal por turno, destacada en su propio párrafo (advisorQuestion).
//     El resto del mensaje no la repite ni agrega otra; las ayudas invitan sin preguntar.
//   - Reconocer lo que el estudiante ya respondió antes de pedir lo siguiente.
//   - Emojis solo cuando aporten claridad (el saludo de apertura, un aviso): nunca en cada línea
//     ni como felicitación automática.
//   - No inventar hechos de la empresa: solo lo que el estudiante registró.
//   - No inferir el género por el nombre, la foto o el correo. Expresiones neutras: "te doy la
//     bienvenida", "la persona que te supervisa"; no "bienvenido/a" ni "tu supervisor".
//   - Nombre: saludar por el nombre de pila del perfil (studentIdentity.ts) solo al abrir una etapa;
//     el título "Univ." va en la cabecera, no en las respuestas.
//   - Formato: el Markdown que ya pinta MessageList (### para la etapa, **negrita** para la
//     pregunta). Sin HTML ni estilos nuevos, así los mensajes guardados se ven igual.
//   - Terminología: "Práctica Empresarial", en singular, para la asignatura y la experiencia de cada
//     estudiante ("durante tu Práctica Empresarial", "como parte de tu Práctica Empresarial"); no
//     "Prácticas Empresariales" para la de un estudiante, ni "pasantía" o "prácticas profesionales"
//     como sinónimos. Nombrarla cuando aporte, no en cada mensaje: también "la empresa donde
//     realizas tu práctica", "el proceso que estás analizando", "las actividades que desarrollas en
//     la empresa".
//   - No suponer que el estudiante es empleado o trabajador de la empresa. Los términos técnicos
//     ("puesto de trabajo", "métodos de trabajo", "condiciones de trabajo", "carga de trabajo")
//     sí se usan cuando corresponden.
//   - Nunca nombres reales de empresas en los textos generados.
// Los textos deben quedar iguales tras formatAdvisorReplyForChat (assistantFormat.ts), que es lo que
// se pinta y se guarda. Las pautas para las respuestas en texto libre de Gemini (extensión, formato,
// fórmulas) están en responseStyle.ts.

// "¡Hola, Alan! …" o "¡Hola! …" si no se conoce el nombre.
export function advisorGreeting(name: string | null | undefined, rest: string) {
  const who = (name ?? "").trim();
  return `¡Hola${who ? `, ${who}` : ""}! ${rest}`;
}

// Saludo del Asistente General con el historial vacío (useChatHistory.ts). Mismo tono y mismo
// nombre de pila que el asesor; sin nombre, "¡Hola! …". No menciona la tecnología interna.
export function generalAssistantGreeting(name: string | null | undefined) {
  return advisorGreeting(
    name,
    "👋 Soy OPT-IA, tu asistente académico. Estoy aquí para acompañarte durante tu Práctica Empresarial, " +
      "resolver tus dudas y orientarte en las actividades que desarrollas en la empresa.\n\n¿Por dónde comenzamos?"
  );
}

// Título de la etapa, con la misma etiqueta que muestra la barra lateral.
export function advisorStageHeading(label: string) {
  return `### ${label}`;
}

// La pregunta principal del turno, en negrita y con su aclaración en la línea siguiente.
export function advisorQuestion(question: string, hint?: string) {
  return hint ? `**${question}**\n${hint}` : `**${question}**`;
}
