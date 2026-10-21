// src/lib/chat/assistantFormat.ts
//
// Construcción y formato de los mensajes del chat (src/app/chat/page.tsx), sin estado ni
// persistencia: appendAssistant los usa antes de pintar y guardar la respuesta.
// createMessage no es determinista: usa crypto.randomUUID() y la hora actual.
// formatAdvisorReplyForChat es el texto que se pinta y se guarda de una respuesta del asesor; lo
// usan el navegador (appendAssistant) y el servidor (/api/messages), que no confía en el
// formateado que manda el cliente. Aplicarlo dos veces da lo mismo que aplicarlo una.
//
// Lo que cambia, solo en la prosa:
//   - quita la muletilla inicial ("Entendido, ", "Perfecto, "…) y pone en mayúscula la primera
//     letra, salvo que el mensaje empiece por una variable (x, x_{i}, P'…);
//   - una lista numerada escrita en una línea ("1. A 2. B", "…: 1. A") pasa a un ítem por línea,
//     solo si la numeración es una secuencia. Un número suelto seguido de punto ("2026. Esto", "la
//     nota es 80. Revisa") o después de palabras como etapa, sección o versión ("Etapa 4. Diagrama")
//     no es un ítem;
//   - deja una línea en blanco antes de las viñetas, de los ítems numerados, de los emojis de
//     bloque, de las preguntas (¿) y de los cierres ("Ahora", "Entonces"…), y entre una tabla y el
//     texto que la sigue (GFM pegaría ese texto a la tabla como otra fila);
//   - "**Versión N**:" pasa a "**Versión N**" y un salto;
//   - tabulaciones a un espacio, sin espacios al final de línea (salvo el salto forzado de dos
//     espacios) y sin líneas en blanco repetidas.
// Lo que no cambia: bloques de código (``` y ~~~, aunque no estén cerrados), código en línea,
// fórmulas ($$ … $$, \[ … \], \( … \) y $ … $), tablas, encabezados, citas y líneas con sangría
// (listas anidadas, código indentado). Cómo se pintan lo decide MessageList.

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

const LEAD_IN = /^(entendido|entiendo|registrado|perfecto|de acuerdo|muy bien|esta bien|está bien|ok|okay|claro|listo)\s*,\s*/i;

// Las palabras de una letra del castellano; cualquier otra letra suelta al empezar es una variable.
const ONE_LETTER_WORDS = new Set(["a", "e", "o", "u", "y"]);

// Solo la muletilla: lo que sigue (un nombre, un término como "Pareto") no se toca.
export function softenAssistantLeadInChat(message: string): string {
  let text = String(message ?? "").trim();
  // En bucle ("Ok, listo, …"), así una segunda pasada no cambia nada.
  while (LEAD_IN.test(text)) {
    const rest = text.replace(LEAD_IN, "");
    if (!rest) break;
    text = rest;
  }
  return startsWithVariable(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

// "x es…", "x_{i} es…", "x^2", "P' =": una variable no pasa a mayúscula.
function startsWithVariable(text: string): boolean {
  const token = /^\S+/.exec(text)?.[0] ?? "";
  if (/^[a-z][_^'{=<>]/.test(token)) return true;
  const word = token.replace(/[.,:;!?)]+$/, "");
  return /^[a-z]$/.test(word) && !ONE_LETTER_WORDS.has(word);
}

// ---------------- Formato de la prosa ----------------

// fixed: se copia tal cual (código, fórmulas, tablas, encabezados, citas, sangría).
type Line = { text: string; kind: "prose" | "fixed" | "blank"; table?: boolean; hardBreak?: boolean };

const BLANK: Line = { text: "", kind: "blank" };

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// Código en línea y fórmulas de una línea: ``…``, `…`, $$…$$, \(…\), \[…\] y $…$ (sin espacio
// por dentro, como lo lee pandoc: "$100 y $200" no es una fórmula).
const INLINE_SPANS = /``[^\n]*?``|`[^`\n]+`|\$\$[^\n]*?\$\$|\\\([^\n]*?\\\)|\\\[[^\n]*?\\\]|\$(?=\S)[^$\n]*?\S\$(?!\d)/g;

// "N. " con texto detrás, al empezar la línea o después de un espacio o de ":". Hasta tres
// dígitos: un año nunca es un ítem.
const ITEM_MARK = /(^|[\s:])(\d{1,3})\.(?=[ \t]+\S)/g;

// Un número después de estas palabras es una referencia ("la sección 3. Métodos"), no un ítem.
const REFERENCE_WORD =
  /(?:^|[^\p{L}])(?:etapa|fase|secci[oó]n|cap[ií]tulo|versi[oó]n|tabla|figura|gr[aá]fico|anexo|p[aá]gina|norma|iso|art[ií]culo|ley|nota|puntaje|calificaci[oó]n|semana|nivel)\s+$/iu;

const VERSION_LABEL = /\*\*(Versión\s+\d+)\*\*\s*:\s*/gi;

// Inicios de línea que llevan una línea en blanco antes.
const BLOCK_EMOJI = /^(?:✅|📄|🧩|👉|⚠️|🎯|📌|📊|📝)/;
const BULLET = /^[-*•]\s/;
const ORDERED_ITEM = /^(\d+)\.\s/;
const CLOSING_PHRASE = /^(?:Estamos|Ahora|Con esto|En resumen|Por tanto|Entonces|Si quieres|¿)/;

export function formatAssistantMessageForReadability(message: string): string {
  const text = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!text) return text;

  const lines = classifyLines(text.split("\n")).flatMap((line) => (line.kind === "prose" ? formatProseLine(line.text) : [line]));
  return joinLines(withBlockSpacing(lines)).trim();
}

// Marca lo que no se toca. Una fórmula en bloque ($$ o \[ en una línea y su cierre en otra) solo
// cuenta si se cierra; si no, sigue siendo prosa.
function classifyLines(lines: string[]): Line[] {
  const out: Line[] = [];
  const fixed = (from: number, to: number, table = false) => {
    for (let j = from; j <= to; j++) out.push({ text: lines[j], kind: "fixed", table });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      out.push(BLANK);
      continue;
    }

    // Bloque de código hasta la cerca que lo cierra (mismo carácter, igual de larga o más) o el
    // final. "``` x ```" en una línea es código en línea, no una cerca.
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[1][0] === "`" && line.slice(fence[0].length).includes("`"))) {
      const close = new RegExp(`^\\s*\\${fence[1][0]}{${fence[1].length},}\\s*$`);
      let end = i + 1;
      while (end < lines.length && !close.test(lines[end])) end++;
      fixed(i, Math.min(end, lines.length - 1));
      i = end;
      continue;
    }

    if (countOf(line, "$$") % 2 === 1) {
      const end = findLine(lines, i + 1, (next) => countOf(next, "$$") % 2 === 1);
      if (end >= 0) {
        fixed(i, end);
        i = end;
        continue;
      }
    }

    const bracket = line.lastIndexOf("\\[");
    if (bracket >= 0 && !line.includes("\\]", bracket)) {
      const end = findLine(lines, i + 1, (next) => next.includes("\\]"));
      if (end >= 0) {
        fixed(i, end);
        i = end;
        continue;
      }
    }

    // Tabla GFM (encabezado y fila de guiones): sigue mientras las líneas tengan "|".
    const delimiter = lines[i + 1];
    if (line.includes("|") && delimiter !== undefined && delimiter.includes("|") && TABLE_DELIMITER.test(delimiter)) {
      let end = i + 2;
      while (end < lines.length && lines[end].trim() && lines[end].includes("|")) end++;
      fixed(i, end - 1, true);
      i = end - 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      fixed(i, i, true);
      continue;
    }

    if (/^#{1,6}(?:\s|$)/.test(line) || /^>/.test(line) || /^[ \t]/.test(line)) {
      fixed(i, i);
      continue;
    }

    out.push({ text: line, kind: "prose" });
  }
  return out;
}

// Una línea de prosa: tabulaciones y "**Versión N**:" fuera del código y las fórmulas, y la lista
// numerada en una línea, un ítem por línea. El salto forzado (dos espacios al final) se conserva.
function formatProseLine(line: string): Line[] {
  const hardBreak = / {2,}$/.test(line);
  const text = mapOutsideSpans(line, (part) => part.replace(/\t/g, " ").replace(VERSION_LABEL, "**$1**\n")).replace(/\n+$/, "");

  const out = text
    .split("\n")
    .flatMap((part) => splitNumberedSequence(part.replace(/[  ]+$/, "")))
    .map((part): Line => (part ? { text: part, kind: "prose" } : BLANK));
  const last = out[out.length - 1];
  if (hardBreak && last?.kind === "prose") out[out.length - 1] = { ...last, hardBreak: true };
  return out;
}

// Corta antes de cada ítem de una secuencia (1, 2, 3… o la que empieza al inicio de la línea, como
// "5. A 6. B"). Un "1." solo corta si viene después de ":". Si el mismo número aparece dos veces
// ("…del objetivo 2. 2. Vincula"), el ítem es el último. "" es la línea en blanco entre ítems.
function splitNumberedSequence(line: string): string[] {
  const spans = spansOf(line);
  const marks: Array<{ at: number; n: number; afterColon: boolean }> = [];
  for (const match of line.matchAll(ITEM_MARK)) {
    const at = (match.index ?? 0) + match[1].length;
    const before = line.slice(0, at);
    if (spans.some(([start, end]) => at >= start && at < end) || REFERENCE_WORD.test(before)) continue;
    marks.push({ at, n: Number(match[2]), afterColon: /:\s*$/.test(before) });
  }

  const cuts: number[] = [];
  let sequence: typeof marks = [];
  const close = () => {
    const single = sequence.length === 1 && sequence[0].n === 1 && sequence[0].afterColon;
    if (sequence.length >= 2 || single) cuts.push(...sequence.filter((mark) => mark.at > 0).map((mark) => mark.at));
    sequence = [];
  };
  for (const mark of marks) {
    const previous = sequence[sequence.length - 1];
    if (previous && mark.n === previous.n + 1) {
      sequence.push(mark);
    } else if (previous && sequence.length > 1 && mark.n === previous.n) {
      sequence[sequence.length - 1] = mark;
    } else if (mark.n === 1 || mark.at === 0) {
      close();
      sequence = [mark];
    }
  }
  close();
  if (!cuts.length) return [line];

  const out: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    const piece = line.slice(start, cut).trimEnd();
    if (piece) out.push(piece, "");
    start = cut;
  }
  out.push(line.slice(start));
  return out;
}

// Líneas en blanco antes de viñetas, ítems, emojis de bloque, preguntas y cierres, y después de una
// tabla; nunca dos seguidas. Un "N. " cuenta como ítem si es 1, si viene después de una línea en
// blanco o de otro ítem: si no, Markdown lo lee como texto del párrafo y debe seguir así.
function withBlockSpacing(lines: Line[]): Line[] {
  const out: Line[] = [];
  let previousItem = false;
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (line.kind === "blank") {
      if (previous && previous.kind !== "blank") out.push(BLANK);
      previousItem = false;
      continue;
    }
    if (line.kind === "fixed") {
      out.push(line);
      previousItem = false;
      continue;
    }

    const number = ORDERED_ITEM.exec(line.text);
    const item: boolean = number !== null && (Number(number[1]) === 1 || !previous || previous.kind === "blank" || previousItem);
    const spaced =
      item ||
      BULLET.test(line.text) ||
      BLOCK_EMOJI.test(line.text) ||
      CLOSING_PHRASE.test(line.text) ||
      previous?.table === true;
    if (spaced && previous && previous.kind !== "blank") out.push(BLANK);
    out.push(line);
    previousItem = item;
  }
  while (out.length && out[out.length - 1].kind === "blank") out.pop();
  return out;
}

function joinLines(lines: Line[]): string {
  return lines
    .map((line, i) => (line.hardBreak && lines[i + 1] && lines[i + 1].kind !== "blank" ? `${line.text}  ` : line.text))
    .join("\n");
}

function spansOf(line: string): Array<[number, number]> {
  return [...line.matchAll(INLINE_SPANS)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
}

function mapOutsideSpans(line: string, change: (part: string) => string): string {
  let out = "";
  let from = 0;
  for (const [start, end] of spansOf(line)) {
    out += change(line.slice(from, start)) + line.slice(start, end);
    from = end;
  }
  return out + change(line.slice(from));
}

function countOf(line: string, token: string): number {
  return line.split(token).length - 1;
}

function findLine(lines: string[], from: number, test: (line: string) => boolean): number {
  for (let j = from; j < lines.length; j++) if (test(lines[j])) return j;
  return -1;
}
