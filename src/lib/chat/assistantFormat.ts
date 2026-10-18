// src/lib/chat/assistantFormat.ts
//
// Construcción y formato de los mensajes del chat (src/app/chat/page.tsx), sin estado ni
// persistencia: appendAssistant los usa antes de pintar y guardar la respuesta.
// createMessage no es determinista: usa crypto.randomUUID() y la hora actual.
// formatAdvisorReplyForChat es el texto que se pinta y se guarda de una respuesta del asesor; lo
// usan el navegador (appendAssistant) y el servidor (/api/messages), que no confía en el
// formateado que manda el cliente.

import type { Message } from "@/lib/types";

export function formatAdvisorReplyForChat(raw: string): string {
  return formatAssistantMessageForReadability(softenAssistantLeadInChat(raw));
}

export function createMessage(role: Message["role"], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

export function softenAssistantLeadInChat(message: string): string {
  let text = String(message ?? "").trim();
  if (!text) return text;

  const patterns = [
    /^(entendido|entiendo|registrado|perfecto|de acuerdo|muy bien|esta bien|está bien|ok|okay|claro|listo)\s*,\s*[A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+)?[.,:;!\-]*\s*/u,
    /^(entendido|entiendo|registrado|perfecto|de acuerdo|muy bien|esta bien|está bien|ok|okay|claro|listo)\s*,\s*/i,
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, "");
  }

  text = text.replace(/^\s+/, "");

  if (!text) {
    return String(message ?? "").trim();
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatAssistantMessageForReadability(message: string): string {
  let text = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .trim();

  if (!text) return text;

  // 1) Espacio antes de bloques con emoji / encabezados
  text = text.replace(
    /([^\n])\n(?=(?:✅|📄|🧩|👉|⚠️|🎯|📌|📊|📝))/g,
    "$1\n\n"
  );

  // 2) Si una lista numerada viene pegada después de ":" o de una frase,
  // forzamos bloque aparte para que Markdown la renderice bien.
  text = text.replace(/:\s*(\d+\.\s)/g, ":\n\n$1");
  text = text.replace(/([^\n])(\d+\.\s)/g, (match, prev, itemStart) => {
    if (/\s/.test(prev)) {
      return `${prev}\n\n${itemStart}`;
    }
    return match;
  });

  // 3) Cada ítem numerado debe iniciar en línea propia
  text = text.replace(/([^\n])\n(?=\d+\.\s)/g, "$1\n\n");

  // 4) Cada bullet debe iniciar en línea propia
  text = text.replace(/([^\n])\n(?=(?:-|\*|•)\s)/g, "$1\n\n");

  // 5) Si el modelo junta dos ítems numerados en el mismo párrafo, separarlos
  // Ej: "1. Causa A 2. Causa B"
  text = text.replace(/(\d+\.\s.*?)(\s)(?=\d+\.\s)/g, "$1\n");

  // 6) Si después de un ítem viene una frase normal tipo cierre o pregunta,
  // dar aire para que no choque con la lista.
  text = text.replace(
    /([^\n])\n(?=(?:Estamos|Ahora|Con esto|En resumen|Por tanto|Entonces|Si quieres|¿))/g,
    "$1\n\n"
  );

  // 7) Mejorar caso específico de Versiones
  text = text.replace(/\*\*(Versión\s+\d+)\*\*\s*:\s*/gi, "**$1**\n");

  // 8) Limpiar espacios sobrantes por línea
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \u00A0]+$/g, ""))
    .join("\n");

  // 9) Reducir exceso de saltos
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
