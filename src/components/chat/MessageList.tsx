"use client";

// Lista de mensajes del chat (Asistente General y Asesor E0-E10) y su renderizado Markdown.
// react-markdown con remark-gfm: tablas, listas de tareas, tachado y enlaces automáticos; y
// fórmulas con remark-math y rehype-katex (el CSS de KaTeX lo importa src/app/chat/page.tsx).
// Solo cambia cómo se pinta: el texto guardado y el que se recupera son los mismos.
//
// Fórmulas: remark-math interpreta solo $$ … $$ (en línea o en bloque); normalizeMath
// (src/lib/chat/mathMarkdown.ts) lleva a esa forma las otras maneras de escribir LaTeX ($ … $ que
// parece LaTeX, \( \), \[ \], ```latex, una línea de LaTeX sin delimitadores). Un $ de un monto
// ("$100 y $200") nunca es una fórmula.
//
// Seguridad: el HTML del texto no se interpreta (react-markdown lo muestra escapado; no se usa
// rehype-raw), salvo <br>, que se convierte en un salto de línea de Markdown. Los enlaces pasan
// por el filtro de URL de react-markdown (sin javascript:, vbscript: ni data:) y abren en otra
// pestaña sin referrer. Las imágenes no se cargan: se muestra su texto alternativo. KaTeX va con
// trust: false (sin \href, \url, \includegraphics ni \html*) y límites de expansión y tamaño; su
// resultado pasa por el árbol de rehype, no por dangerouslySetInnerHTML. Una fórmula inválida se
// muestra como su texto, en rojo, y el resto del mensaje se pinta igual.

import { memo, useEffect, useRef, type ReactNode } from "react";
import type { Components, Options as MarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeKatex, { type Options as KatexOptions } from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMath } from "@/lib/chat/mathMarkdown";
import { Message } from "@/lib/types";
import clsx from "clsx";

function TypingDots() {
  return (
    <span className="typing-dots" aria-label="Escribiendo">
      <span />
      <span />
      <span />
    </span>
  );
}

// Lo mínimo del árbol de Markdown (mdast) que recorre remarkHtmlBreaks.
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

// Un <br> suelto (frecuente dentro de las celdas de una tabla) pasa a ser un salto de línea de
// Markdown. Cualquier otro HTML sigue mostrándose como texto.
function remarkHtmlBreaks() {
  const visit = (node: MarkdownNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) =>
      child.type === "html" && /^<br\s*\/?>$/i.test((child.value ?? "").trim()) ? { type: "break" } : child
    );
    node.children.forEach(visit);
  };
  return (tree: MarkdownNode) => visit(tree);
}

// Opciones explícitas (propiedades propias, no heredadas): sin comandos de confianza, sin avisos
// de modo estricto (las tildes dentro de una fórmula son válidas) y con límites para una fórmula
// que se expande sin fin.
const KATEX_OPTIONS: KatexOptions = {
  trust: false,
  strict: "ignore",
  maxExpand: 1000,
  maxSize: 20,
  errorColor: "#ef4444",
  output: "htmlAndMathml",
};

const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkHtmlBreaks,
];
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [[rehypeKatex, KATEX_OPTIONS]];

// Texto plano de los hijos de un elemento (para distinguir el código en bloque del código en línea).
function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

const HEADING = "font-semibold text-[color:var(--markdown-strong)] first:mt-0";

// react-markdown les pasa a los componentes el nodo (`node`): no se reenvía al DOM.
const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2 break-all text-[color:var(--markdown-link)] hover:text-[color:var(--markdown-link-hover)] transition-colors"
      >
        {children}
      </a>
    );
  },

  p: ({ children }) => {
    return <p className="mb-3 last:mb-0 whitespace-pre-wrap">{children}</p>;
  },

  // Listas: anidadas con sangría propia; un párrafo dentro de un ítem (lista con líneas en blanco
  // entre ítems) no agrega el margen de un párrafo suelto. Las listas de tareas, sin viñeta.
  ul: ({ className, children }) => {
    const tasks = className?.includes("contains-task-list");
    return (
      <ul
        className={clsx(
          "mb-3 last:mb-0 space-y-1.5 [li>&]:mt-1.5 [li>&]:mb-0",
          tasks ? "list-none pl-1" : "list-disc pl-5 marker:text-[color:var(--muted)] [li>&]:list-[circle]"
        )}
      >
        {children}
      </ul>
    );
  },

  ol: ({ start, children }) => {
    return (
      <ol
        start={start}
        className="mb-3 last:mb-0 list-decimal pl-5 space-y-1.5 marker:text-[color:var(--muted)] [li>&]:mt-1.5 [li>&]:mb-0"
      >
        {children}
      </ol>
    );
  },

  li: ({ children }) => {
    return <li className="leading-relaxed pl-0.5 [&>p]:mb-1.5 [&>p:last-child]:mb-0">{children}</li>;
  },

  // Casilla de una lista de tareas: solo lectura.
  input: ({ checked, type }) => {
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled
        readOnly
        className="mr-2 h-3.5 w-3.5 translate-y-[1px] accent-sky-500"
      />
    );
  },

  h1: ({ children }) => {
    return <h1 className={clsx(HEADING, "mt-5 mb-3 text-base sm:text-lg")}>{children}</h1>;
  },

  h2: ({ children }) => {
    return <h2 className={clsx(HEADING, "mt-5 mb-2.5 text-[15px] sm:text-base")}>{children}</h2>;
  },

  h3: ({ children }) => {
    return <h3 className={clsx(HEADING, "mt-4 mb-2 text-sm sm:text-[15px]")}>{children}</h3>;
  },

  h4: ({ children }) => {
    return <h4 className={clsx(HEADING, "mt-4 mb-1.5 text-[13px] sm:text-sm")}>{children}</h4>;
  },

  h5: ({ children }) => {
    return <h5 className={clsx(HEADING, "mt-3 mb-1.5 text-[13px]")}>{children}</h5>;
  },

  h6: ({ children }) => {
    return (
      <h6 className="mt-3 mb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--muted)] first:mt-0">
        {children}
      </h6>
    );
  },

  strong: ({ children }) => {
    return <strong className="font-semibold text-[color:var(--markdown-strong)]">{children}</strong>;
  },

  em: ({ children }) => {
    return <em className="italic">{children}</em>;
  },

  del: ({ children }) => {
    return <del className="line-through opacity-75">{children}</del>;
  },

  // Cita como recuadro de nota o ejemplo.
  blockquote: ({ children }) => {
    return (
      <blockquote className="my-3 first:mt-0 last:mb-0 rounded-r-xl border-l-[3px] border-[color:var(--markdown-quote-border)] bg-[color:var(--markdown-quote-bg)] px-3 py-2">
        {children}
      </blockquote>
    );
  },

  hr: () => {
    return <hr className="my-4 border-0 border-t border-[color:var(--markdown-rule)]" />;
  },

  // Tabla dentro de un contenedor con desplazamiento horizontal: en pantallas angostas se desliza
  // la tabla, no la página ni la burbuja.
  table: ({ children }) => {
    return (
      <div className="my-3 first:mt-0 last:mb-0 max-w-full overflow-x-auto rounded-xl border border-[color:var(--markdown-table-border)] scrollbar-optia">
        <table className="w-full border-collapse text-left text-[12.5px] sm:text-[13px] leading-snug">{children}</table>
      </div>
    );
  },

  thead: ({ children }) => {
    return (
      <thead className="border-b border-[color:var(--markdown-table-border)] bg-[color:var(--markdown-table-head-bg)]">
        {children}
      </thead>
    );
  },

  tr: ({ children }) => {
    return (
      <tr className="border-t border-[color:var(--markdown-table-border)] first:border-t-0 even:bg-[color:var(--markdown-table-stripe)]">
        {children}
      </tr>
    );
  },

  // style trae la alineación de la columna (|:--|--:|) que pone remark-gfm.
  th: ({ style, children }) => {
    return (
      <th
        style={style}
        className="min-w-[6rem] px-3 py-2 align-bottom font-semibold text-[color:var(--markdown-strong)]"
      >
        {children}
      </th>
    );
  },

  td: ({ style, children }) => {
    return (
      <td style={style} className="min-w-[6rem] px-3 py-2 align-top">
        {children}
      </td>
    );
  },

  // Bloque de código: fondo propio y desplazamiento horizontal; el texto no se reacomoda.
  pre: ({ children }) => {
    return (
      <pre className="my-3 first:mt-0 last:mb-0 max-w-full overflow-x-auto rounded-xl border border-[color:var(--markdown-pre-border)] bg-[color:var(--markdown-pre-bg)] px-3.5 py-3 text-[12px] leading-relaxed text-[color:var(--markdown-code-text)] scrollbar-optia">
        {children}
      </pre>
    );
  },

  // En un bloque (lenguaje indicado o texto con saltos de línea, que el código en línea nunca
  // tiene) el estilo lo da el <pre>; en línea, una etiqueta con fondo.
  code: ({ className, children }) => {
    const block = /\blanguage-/.test(className ?? "") || textOf(children).includes("\n");
    if (block) return <code className={clsx("font-mono", className)}>{children}</code>;
    return (
      <code
        className="rounded px-1.5 py-0.5 font-mono text-[12px]"
        style={{
          backgroundColor: "var(--markdown-code-bg)",
          color: "var(--markdown-code-text)",
        }}
      >
        {children}
      </code>
    );
  },

  // Las imágenes no se cargan (evita pedidos a sitios externos): queda su texto alternativo.
  img: ({ alt }) => {
    return alt ? <span className="text-[color:var(--muted)]">[{alt}]</span> : null;
  },
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

// Memorizado por texto: un mensaje nuevo no vuelve a interpretar el Markdown de los anteriores.
const MessageContent = memo(function MessageContent({ content }: { content: unknown }) {
  return (
    <div className="chat-markdown min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={markdownComponents}
      >
        {normalizeMath(contentText(content))}
      </ReactMarkdown>
    </div>
  );
});

export function MessageList({
  messages,
  isTyping = false,
}: {
  messages: Message[];
  isTyping?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const prevLen = prevLenRef.current;
    const nextLen = messages.length;
    prevLenRef.current = nextLen;

    if (prevLen === 0) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 120;

    if (nearBottom || isTyping) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isTyping]);

  return (
    <div className="flex-1 min-h-0 relative h-full">
      <div
        ref={scrollerRef}
        className="absolute inset-0 overflow-y-auto scrollbar-optia px-3"
        style={{
          scrollPaddingBottom: "calc(var(--composer-h, 84px) + 24px)",
          maskImage:
            "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0%, black 3%, black 92%, transparent 100%)",
        }}
      >
        <div className="min-h-full flex flex-col justify-start">
          <div className="space-y-3 sm:space-y-5">
            {messages.map((msg) => {
              const isUser = msg.role === "user";

              return (
                <div
                  key={msg.id}
                  className={clsx("flex w-full", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={clsx(
                      "min-w-0 max-w-[84%] sm:max-w-[78%] md:max-w-[72%]",
                      "px-3 py-2.5 sm:px-4 sm:py-3",
                      "text-[13px] sm:text-sm leading-[1.55] sm:leading-relaxed",
                      "border shadow-[0_10px_30px_rgba(0,0,0,0.25)]",
                      isUser
                        ? "rounded-2xl sm:rounded-3xl rounded-br-lg sm:rounded-br-xl bg-[color:var(--bubble-user-bg)] border-[color:var(--bubble-user-border)] text-[color:var(--bubble-user-text)]"
                        : "rounded-2xl sm:rounded-3xl rounded-bl-lg sm:rounded-bl-xl bg-[color:var(--bubble-assistant-bg)] border-[color:var(--bubble-assistant-border)] text-[color:var(--bubble-assistant-text)]"
                    )}
                  >
                    <MessageContent content={msg.content} />
                  </div>
                </div>
              );
            })}

            {isTyping ? (
              <div className="flex w-full justify-start">
                <div
                  className={clsx(
                    "rounded-xl sm:rounded-2xl backdrop-blur-xl",
                    "bubble-assistant bg-[color:var(--surface-elevated)] text-[color:var(--foreground)] border border-[color:var(--border)]",
                    "shadow-[0_6px_14px_rgba(0,0,0,0.10)]",
                    "px-2.5 py-2 sm:px-3 inline-flex items-center"
                  )}
                >
                  <TypingDots />
                </div>
              </div>
            ) : null}

            <div
              aria-hidden="true"
              style={{ height: "calc(var(--composer-h, 84px) + 12px)" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
