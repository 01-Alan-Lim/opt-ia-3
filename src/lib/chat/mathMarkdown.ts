// src/lib/chat/mathMarkdown.ts
//
// Fórmulas del chat: lleva las formas en que un modelo escribe LaTeX a la única que interpreta
// remark-math en MessageList ($$ … $$, en línea o en bloque) antes de pintar el Markdown. Solo
// cambia lo que se pinta: el texto guardado es el mismo. Sin React ni dependencias.
//
// Fuera del código (bloques ``` y ~~~, aunque no estén cerrados, y código en línea):
//   - \[ … \] pasa a un bloque y \( … \) a una fórmula en línea, si lo de adentro es una fórmula.
//   - $ … $ pasa a una fórmula solo si parece LaTeX (un comando, ^ o _, una igualdad con letras o
//     una variable sola) y cumple la regla de pandoc: sin espacio justo después del primer $ ni
//     justo antes del segundo, y sin una letra o un dígito pegados por fuera. Así "$100 y $200",
//     "$20,000", "$us 50" y "=$B$2*C2" siguen siendo texto.
//   - Una línea suelta que es solo LaTeX (un comando como \frac y a lo sumo una palabra) pasa a un
//     bloque. Una oración con un comando suelto queda como está: no se adivina la fórmula.
//   - $$ … $$ que ocupa sus propias líneas (aunque el texto empiece en la línea del primer $$) es un
//     bloque, centrado; si no, va en línea. Un $$ sin pareja se muestra como texto.
// Bloques ```latex, ```tex, ```katex y ```math: fórmula en bloque, no código.
// Dentro de cada fórmula: % pasa a \% (en LaTeX empieza un comentario), la coma decimal (7,5) a
// 7{,}5 (sin el espacio que KaTeX pone tras una coma) y, en línea, \frac a \dfrac (la fracción en
// línea sale del tamaño del texto, no reducida).
// Las fórmulas de Excel van en código y no cambian.

// Comandos que delatan una línea de LaTeX escrita sin delimitadores.
const BARE_LATEX_COMMAND =
  /\\(?:d?frac|tfrac|sum|prod|int|sqrt|times|cdot|div|bar|overline|hat|Delta|delta|sigma|mu|lambda|alpha|beta|text|left|right|approx|leq?|geq?|neq|pm|log|ln|lim)(?![A-Za-z])/;

// En una fórmula, % empieza un comentario de LaTeX y cortaría lo que sigue: pasa a \%.
const escapePercent = (tex: string) => tex.replace(/\\?%/g, (match) => (match === "%" ? "\\%" : match));

// 7,5 → 7{,}5: la coma decimal sin espacio detrás.
const decimalComma = (tex: string) => tex.replace(/(\d),(?=\d)/g, "$1{,}");

const displayTex = (tex: string) => decimalComma(escapePercent(tex.trim()));

const inlineTex = (tex: string) =>
  displayTex(tex.replace(/\s*\n\s*/g, " ")).replace(/\\frac(?![A-Za-z])/g, "\\dfrac");

// Lo de adentro de \( \) o \[ \]: un comando, ^ o _, un operador o una letra (una variable).
// "\[1\]" (corchetes escapados con un número) sigue siendo texto.
const delimitedLooksLikeMath = (tex: string) => /[A-Za-z\\^_=+\-*/<>≤≥×÷]/.test(tex) && !/^\s*\d+\s*$/.test(tex);

// Lo de adentro de $ … $: un comando, ^ o _, una igualdad o desigualdad con letras, o una variable
// sola (P, x', T_{std}). Los montos no cumplen nada de esto.
function singleDollarLooksLikeTex(tex: string): boolean {
  if (/\\[A-Za-z]+/.test(tex) || /[\^_]/.test(tex)) return true;
  if (/[=<>≤≥]/.test(tex) && /[A-Za-z]/.test(tex)) return true;
  return /^[A-Za-z]'?$/.test(tex);
}

// $ … $ en una línea, con la regla de pandoc y que parezca LaTeX: pasa a $$ … $$. Los $$ y los \$
// se dejan como están.
function convertSingleDollar(prose: string): string {
  let out = "";
  let i = 0;
  while (i < prose.length) {
    const ch = prose[i];
    if (ch === "\\" && prose[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    if (prose[i + 1] === "$") {
      out += "$$";
      i += 2;
      continue;
    }
    const close = closingDollar(prose, i + 1);
    if (close > i + 1) {
      const tex = prose.slice(i + 1, close);
      const before = prose[i - 1] ?? "";
      const after = prose[close + 1] ?? "";
      const pandoc = !/\s/.test(tex[0]) && !/\s/.test(tex[tex.length - 1]) && !/[A-Za-z0-9]/.test(after);
      const detached = !/[A-Za-z0-9=:!]/.test(before);
      if (pandoc && detached && singleDollarLooksLikeTex(tex)) {
        out += `$$${tex}$$`;
        i = close + 1;
        continue;
      }
    }
    out += "$";
    i += 1;
  }
  return out;
}

// El $ que cierra uno abierto en from - 1, en la misma línea; -1 si no hay (o si llega antes un $$).
function closingDollar(prose: string, from: number): number {
  for (let j = from; j < prose.length; j++) {
    const ch = prose[j];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "$") return prose[j + 1] === "$" ? -1 : j;
  }
  return -1;
}

// Palabras de prosa (tres letras o más) fuera de los comandos y de las llaves.
function proseWords(line: string): number {
  let text = line.replace(/\\[A-Za-z]+/g, " ");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\{[^{}]*\}/g, " ");
  }
  return (text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}/g) ?? []).length;
}

// Una línea suelta que es solo LaTeX pasa a un bloque. No toca títulos, citas, tablas ni ítems
// de lista, ni las líneas que ya están dentro de un bloque $$.
function wrapBareLatexLines(prose: string): string {
  let inDisplay = false;
  return prose
    .split("\n")
    .map((line) => {
      const dollars = (line.match(/\$\$/g) ?? []).length;
      const skip = inDisplay || line.includes("$");
      if (dollars % 2 === 1) inDisplay = !inDisplay;
      if (skip) return line;
      const trimmed = line.trim();
      if (!trimmed || /^(?:#|>|\||[-*+]\s|\d+[.)]\s)/.test(trimmed)) return line;
      // Además del comando, algo de fórmula (=, ^, _ o llaves): una ruta como C:\Users\text no lo es.
      if (!BARE_LATEX_COMMAND.test(trimmed) || !/[=^_{}]/.test(trimmed) || proseWords(trimmed) > 1) return line;
      const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
      return `\n${indent}$$\n${indent}${trimmed}\n${indent}$$\n`;
    })
    .join("\n");
}

// Cada par $$ … $$: bloque si ocupa sus propias líneas o tiene saltos de línea; si no, en línea.
// Un $$ sin pareja se muestra como texto.
function formatDollarMath(prose: string): string {
  const parts = prose.split("$$");
  if (parts.length === 1) return prose;
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    if (i === parts.length - 1) {
      out += `\\$\\$${parts[i]}`;
      break;
    }
    const tex = parts[i];
    const after = parts[i + 1];
    if (!tex.trim()) {
      out += `\\$\\$${tex}\\$\\$${after}`;
      continue;
    }
    const ownLines = /(?:^|\n)[ \t]*$/.test(out) && /^[ \t]*(?:\n|$)/.test(after);
    if (ownLines || tex.includes("\n")) {
      const indent = /(?:^|\n)([ \t]*)$/.exec(out)?.[1] ?? "";
      out = `${out.replace(/[ \t]*$/, "")}\n\n${indent}$$\n${indent}${displayTex(tex)}\n${indent}$$\n\n${after.replace(/^[ \t]*\n?/, "")}`;
    } else {
      out += `$$${inlineTex(tex)}$$${after}`;
    }
  }
  return out;
}

function normalizeProse(prose: string): string {
  const delimited = prose
    .replace(/\\\[([\s\S]+?)\\\]/g, (match, tex: string) => (delimitedLooksLikeMath(tex) ? `\n$$${tex.trim()}$$\n` : match))
    .replace(/\\\(([^\n]+?)\\\)/g, (match, tex: string) => (delimitedLooksLikeMath(tex) ? `$$${tex.trim()}$$` : match));
  return formatDollarMath(wrapBareLatexLines(convertSingleDollar(delimited)));
}

const MATH_FENCE = /^(```|~~~)[ \t]*(?:latex|tex|katex|math)[ \t]*\n([\s\S]*?)\n?[ \t]*(?:\1)?$/i;

export function normalizeMath(text: string): string {
  if (!/[$\\]|```|~~~/.test(text)) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/)
    .map((part, index) => {
      if (index % 2 === 0) return normalizeProse(part);
      const fence = MATH_FENCE.exec(part);
      return fence && fence[2].trim() ? `\n$$\n${displayTex(fence[2])}\n$$\n` : part;
    })
    .join("");
}
