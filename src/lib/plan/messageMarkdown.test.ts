import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageList } from "../../components/chat/MessageList";
import { advisorQuestion, advisorStageHeading } from "../chat/advisorVoice";
import type { Message } from "../types";

// Renderizado Markdown de los mensajes del chat (src/components/chat/MessageList.tsx), en Node con
// react-dom/server: estructura y estilos de tablas, código, encabezados, listas, citas y
// separadores; fórmulas con KaTeX (en línea, en bloque, inválidas, montos con $ y Excel); y la
// protección frente a HTML, enlaces peligrosos, imágenes externas y comandos de KaTeX de confianza.

// El HTML del contenido de un mensaje, sin la lista ni la burbuja.
function render(content: string, role: Message["role"] = "assistant"): string {
  const html = renderToStaticMarkup(
    createElement(MessageList, { messages: [{ id: "m1", role, content, createdAt: "2026-10-20T10:00:00Z" }] })
  );
  const open = '<div class="chat-markdown min-w-0 break-words">';
  const start = html.indexOf(open);
  assert.ok(start >= 0, "contenido del mensaje");
  const end = html.indexOf('<div aria-hidden="true"', start);
  // Sin los cierres del contenido, la burbuja y la fila.
  return html.slice(start + open.length, end).replace(/(?:<\/div>){3}$/, "");
}

const count = (html: string, fragment: string) => html.split(fragment).length - 1;

function runStructure() {
  {
    // Tabla GFM: contenedor con desplazamiento horizontal, encabezado, celdas, alineación y <br>.
    const html = render(
      "| Indicador | Antes | Después |\n|:--|--:|:-:|\n| Tiempo de ciclo | 12 min | 9 min |\n| Defectos<br>por lote | 8 | 3 |"
    );
    assert.match(html, /^<div class="[^"]*overflow-x-auto[^"]*"><table class="[^"]*border-collapse/, html);
    assert.equal(count(html, "<th "), 3);
    assert.equal(count(html, "<td "), 6);
    assert.ok(html.includes('style="text-align:left"') && html.includes('style="text-align:right"'));
    assert.ok(html.includes('style="text-align:center"'), "alineación centrada");
    assert.ok(html.includes("Defectos<br/>\npor lote"), "<br> como salto de línea");
    assert.ok(html.includes("<thead"));
    assert.ok(html.includes("even:bg-[color:var(--markdown-table-stripe)]"), "filas alternadas");
  }
  {
    // Código: en bloque con fondo y desplazamiento; en línea, con su etiqueta. El texto no cambia.
    const html = render("Usa `=SUMA(A1:A3)` así:\n\n```\n=SUMA(A1:A3)/B1\n- no es una lista\n```\n\n```js\nconst x = 1;\n```");
    assert.equal(count(html, "<pre "), 2);
    assert.ok(/<pre class="[^"]*overflow-x-auto[^"]*">/.test(html));
    assert.ok(html.includes('<code class="font-mono">=SUMA(A1:A3)/B1\n- no es una lista\n</code>'), html);
    assert.ok(html.includes('<code class="font-mono language-js">const x = 1;\n</code>'));
    assert.ok(/<code class="rounded px-1\.5[^"]*" style="[^"]*">=SUMA\(A1:A3\)<\/code>/.test(html), "código en línea");
    assert.ok(!/<pre[^>]*>\s*<code class="rounded/.test(html), "el bloque no lleva el estilo en línea");
  }
  {
    // Encabezados H1 a H6, cada uno con su tamaño.
    const html = render(["# Uno", "## Dos", "### Tres", "#### Cuatro", "##### Cinco", "###### Seis"].join("\n\n"));
    for (const level of [1, 2, 3, 4, 5, 6]) assert.equal(count(html, `<h${level} `), 1, `h${level}`);
    const classes = [1, 2, 3, 4, 5, 6].map((level) => new RegExp(`<h${level} class="([^"]*)"`).exec(html)?.[1]);
    assert.equal(new Set(classes).size, 6, "estilos distintos por nivel");
  }
  {
    // Listas anidadas, numeración que no empieza en 1, tareas, citas, separadores y tachado.
    const html = render(
      "1. Medir\n   - con cronómetro\n   - tres veces\n2. Analizar\n\nSigue:\n\n5. Quinto\n6. Sexto\n\n- [x] Hecho\n- [ ] Pendiente\n\n> **Ejemplo:** una MyPE de pan.\n\n---\n\n~~antes~~ ahora"
    );
    assert.ok(/<li[^>]*>Medir\s*<ul class="[^"]*list-disc/.test(html), "lista dentro de un ítem");
    assert.ok(html.includes('<ol start="5"'), "conserva el número inicial");
    assert.equal(count(html, 'type="checkbox"'), 2);
    assert.equal(count(html, "disabled"), 2, "casillas de solo lectura");
    assert.ok(html.includes("checked"), "la marcada");
    assert.ok(/<blockquote class="[^"]*var\(--markdown-quote-bg\)/.test(html));
    assert.ok(/<hr class="[^"]*var\(--markdown-rule\)/.test(html));
    assert.ok(html.includes('<del class="line-through opacity-75">antes</del>'));
  }
  {
    // Lista con líneas en blanco entre ítems (como la deja el formato del asesor): el párrafo del
    // ítem no suma el margen de un párrafo suelto.
    const html = render("Pasos:\n\n- Medir\n\n- Cortar");
    assert.ok(html.includes("[&amp;&gt;p]:mb-1.5"), html);
    assert.equal(count(html, "<li "), 2);
  }
  {
    // Los textos del asesor (### de la etapa, pregunta en negrita con su aclaración) se ven igual.
    const html = render(`${advisorStageHeading("Etapa 0: Contexto del caso")}\n\n${advisorQuestion("¿A qué rubro pertenece la empresa?", "Por ejemplo, alimentos.")}`);
    assert.ok(html.startsWith("<h3 "), html);
    assert.ok(html.includes("Etapa 0: Contexto del caso</h3>"));
    assert.ok(/<p class="[^"]*whitespace-pre-wrap[^"]*"><strong[^>]*>¿A qué rubro pertenece la empresa\?<\/strong>\nPor ejemplo, alimentos\.<\/p>/.test(html), html);
  }
  {
    // Texto corto: un solo párrafo, sin envoltorios.
    assert.equal(render("Hola, ¿en qué te ayudo?"), '<p class="mb-3 last:mb-0 whitespace-pre-wrap">Hola, ¿en qué te ayudo?</p>');
    // El mensaje del estudiante usa el mismo renderizado.
    assert.ok(render("**importante**", "user").includes("<strong"));
  }
}

// El código TeX de cada fórmula que pintó KaTeX (anotación de MathML), en orden.
const texOf = (html: string) =>
  [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map((m) =>
    m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  );
const displays = (html: string) => count(html, 'class="katex-display"');
const formulas = (html: string) => count(html, 'class="katex"');

function runMath() {
  {
    // En línea, dentro del párrafo: una fracción con su MathML.
    const html = render("La productividad es $$P = \\frac{U}{HH}$$ por hora-hombre.");
    assert.equal(formulas(html), 1);
    assert.equal(displays(html), 0, "no se centra");
    assert.ok(/^<p [^>]*>La productividad es <span class="katex">/.test(html), html.slice(0, 200));
    assert.ok(html.includes("por hora-hombre.</p>"));
    assert.ok(html.includes("<mfrac>"), "fracción");
    // En línea, \frac pasa a \dfrac: la fracción sale del tamaño del texto, no reducida.
    assert.deepEqual(texOf(html), ["P = \\dfrac{U}{HH}"]);
  }
  {
    // En bloque (con $$ en líneas propias, o una línea que es solo $$ … $$): centradas. Sumatoria,
    // subíndices y exponentes.
    const html = render(
      "El tiempo total es:\n\n$$\n\\sum_{i=1}^{n} t_{i}\n$$\n\nY la eficiencia:\n\n$$E = \\frac{T_{std}}{T_{real}} \\times 100$$\n\nTambién $$x^{2}$$ en línea."
    );
    assert.equal(displays(html), 2, "dos fórmulas centradas");
    assert.equal(formulas(html), 3);
    assert.ok(html.includes("∑") && html.includes("<munderover>"), "sumatoria con límites");
    assert.ok(html.includes("<msub>") && html.includes("<msup>"), "subíndices y exponentes");
    assert.deepEqual(texOf(html), ["\\sum_{i=1}^{n} t_{i}", "E = \\frac{T_{std}}{T_{real}} \\times 100", "x^{2}"]);
    assert.ok(html.includes("Y la eficiencia:</p>") && html.includes("en línea.</p>"));
  }
  {
    // Porcentaje: un % suelto dentro de la fórmula no la corta (en LaTeX es un comentario); \% se
    // respeta tal cual.
    const html = render("$$\\frac{9 - 7.5}{7.5} \\times 100 = 20%$$ y $$Utilización = 85\\%$$");
    assert.deepEqual(texOf(html), ["\\dfrac{9 - 7.5}{7.5} \\times 100 = 20\\%", "Utilización = 85\\%"]);
    assert.equal(count(html, "<mi mathvariant=\"normal\">%</mi>") + count(html, "<mo>%</mo>"), 2, "el % se ve");
  }
  {
    // \( … \) y \[ … \] (otra notación habitual de los modelos) se pintan igual; "\[1\]" es texto.
    const html = render("Si \\(x_{i}\\) es cada medición, el promedio es\n\\[\\bar{x} = \\frac{\\sum x_{i}}{n}\\]\nVer nota \\[1\\].");
    assert.equal(formulas(html), 2);
    assert.equal(displays(html), 1);
    assert.deepEqual(texOf(html), ["x_{i}", "\\bar{x} = \\frac{\\sum x_{i}}{n}"]);
    assert.ok(html.includes("Ver nota [1].</p>"), html);
  }
  {
    // Montos con $: nunca son fórmulas.
    const text = "Cuesta $100 y $200; en total $300. Con IVA, $345.50. También 150 $us o Bs 200.";
    const html = render(text);
    assert.equal(formulas(html), 0);
    assert.ok(!html.includes("katex"));
    assert.equal(html, `<p class="mb-3 last:mb-0 whitespace-pre-wrap">${text}</p>`);
  }
  {
    // Fórmulas de Excel: en código no se convierten (ni sus $ de referencia absoluta ni \( \)).
    const html = render(
      "En D2:\n\n```\n=$B$2/SUMA(C2:C5)\n=REDONDEAR(B2/C2;2)\n```\n\nO en línea: `=$B$2*C2` y `\\(x\\)`. También $$a$$ fuera."
    );
    assert.ok(html.includes('<code class="font-mono">=$B$2/SUMA(C2:C5)\n=REDONDEAR(B2/C2;2)\n</code>'), html);
    assert.ok(html.includes(">=$B$2*C2</code>") && html.includes(">\\(x\\)</code>"));
    assert.deepEqual(texOf(html), ["a"], "solo la fórmula fuera del código");
  }
  {
    // Un bloque de código sin cerrar no se toca.
    const html = render("```\n$$x$$ \\(y\\)");
    assert.equal(formulas(html), 0);
  }
  {
    // Fórmula inválida: se ve su texto (en rojo) y el resto del mensaje sigue igual.
    const html = render("Antes $$\\frac{a$$ después, y $$\\notacommand{x}$$ fin. Luego **bien**: $$a+b$$.");
    assert.ok(html.includes("katex-error"), "marcada como error");
    assert.ok(html.includes("frac{a"), "el texto de la fórmula se lee");
    assert.ok(html.includes("después, y") && html.includes(" fin. Luego "), "el resto del párrafo");
    assert.ok(html.includes('<strong class="font-semibold'), "el Markdown sigue funcionando");
    assert.ok(texOf(html).includes("a+b"), "la fórmula válida se pinta");
  }
  {
    // Mensajes antiguos sin fórmulas: el mismo HTML de siempre.
    assert.equal(render("Hola, ¿en qué te ayudo?"), '<p class="mb-3 last:mb-0 whitespace-pre-wrap">Hola, ¿en qué te ayudo?</p>');
    const table = render("| A | B |\n|---|---|\n| 1 | 2 |");
    assert.ok(!table.includes("katex") && table.includes("<table"));
  }
  {
    // Seguridad: sin comandos de confianza (enlaces, imágenes, clases o atributos HTML), sin HTML
    // dentro de la fórmula y con límite para una macro que se expande sin fin.
    const html = render(
      [
        "$$\\href{javascript:alert(1)}{x}$$",
        "$$\\url{https://tracker.example/a}$$",
        "$$\\includegraphics{https://tracker.example/x.png}$$",
        "$$\\htmlClass{evil}{x} \\htmlData{onclick=alert(1)}{y} \\htmlStyle{background:url(https://tracker.example/b)}{z}$$",
        "$$<script>alert(1)</script>$$",
        "$$\\def\\a{\\a\\a}\\a$$",
      ].join("\n\n")
    );
    assert.ok(!/href=/.test(html), "sin enlaces");
    assert.ok(!html.includes("<img"), "sin imágenes");
    assert.ok(!html.includes("<script"), "sin script");
    // El código fuente aparece como texto en la anotación TeX; lo que importa son los atributos.
    assert.ok(!/ class="[^"]*evil/.test(html), "sin \\htmlClass");
    assert.ok(!/ data-onclick=/.test(html), "sin \\htmlData");
    assert.ok(!/ style="[^"]*url\(/.test(html), "sin \\htmlStyle con recursos externos");
    assert.ok(!/src="https:\/\/tracker/.test(html), "sin recursos externos");
    assert.ok(html.includes("katex-error"), "la macro infinita termina en error, no cuelga");
  }
}

// Formas habituales en que un modelo escribe LaTeX, además de $$ … $$.
function runMathReadability() {
  // Junta todas las fallas antes de cortar, para ver cada caso.
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`${name}: ${detail.slice(0, 300)}`);
  };
  const sameTex = (name: string, html: string, expected: string[]) =>
    check(name, JSON.stringify(texOf(html)) === JSON.stringify(expected), JSON.stringify(texOf(html)));
  {
    // $ … $ con LaTeX (lo más común): se pinta. Una variable sola ($P$) también.
    const html = render("La productividad es $P = \\frac{U}{HH}$, donde $P$ son unidades por hora y $x_{i}$ cada dato.");
    check("$…$ con LaTeX", formulas(html) === 3, html);
    sameTex("$…$ con LaTeX (TeX)", html, ["P = \\dfrac{U}{HH}", "P", "x_{i}"]);
  }
  {
    // \(P\): una variable sola entre \( \) también es una fórmula.
    const html = render("Si \\(P\\) sube, mejora.");
    check("\\(P\\)", formulas(html) === 1, html);
  }
  {
    // Bloque ```latex, ```tex o ```math: fórmula centrada, no código.
    const html = render("```latex\nE = \\frac{T_{std}}{T_{real}} \\times 100\n```\n\n```math\nx^{2}\n```");
    check("```latex", displays(html) === 2, html);
    check("```latex sin <pre>", !html.includes("<pre"), html);
  }
  {
    // Bloque con el texto en las mismas líneas que los $$: centrado, y lo que sigue no se pierde.
    const html = render("$$\\text{Variación} = \\frac{9 - 7.5}{7.5} \\times 100\n= 20\\%$$\n\nTexto después.");
    check("$$ con texto en sus líneas", displays(html) === 1, html);
    check("$$ con texto en sus líneas: lo que sigue", html.includes("<p class=\"mb-3 last:mb-0 whitespace-pre-wrap\">Texto después.</p>"), html);
  }
  {
    // Un $$ sin cerrar no se traga el resto del mensaje.
    const html = render("Precio: $$ y más texto.\n\n**Fin**");
    check("$$ sin cerrar", formulas(html) === 0 && html.includes("<strong") && html.includes("y más texto."), html);
  }
  {
    // Una línea que es solo LaTeX, sin delimitadores: se pinta centrada.
    const html = render("Productividad:\n\nP = \\frac{1200}{160} = 7,5 \\text{ u/HH}\n\nListo.");
    check("línea de LaTeX sin $", displays(html) === 1, html);
    sameTex("línea de LaTeX sin $ (TeX)", html, ["P = \\frac{1200}{160} = 7{,}5 \\text{ u/HH}"]);
  }
  {
    // Decimales con coma (7,5): sin el espacio que KaTeX pone después de una coma.
    sameTex("decimales con coma", render("$$7,5 + 1,25 = 8,75$$"), ["7{,}5 + 1{,}25 = 8{,}75"]);
  }
  {
    // Montos y referencias de Excel con $, fuera del código: siguen siendo texto.
    for (const text of [
      "Cuesta $100 y $200.",
      "Entre $5-$10 por unidad.",
      "Ahorro de $20,000 y $30,000.",
      "En Excel: =$B$2*C2 o =Hoja1!$B$2/C2.",
      "Pago de $us 50 y $us 70.",
    ]) {
      const html = render(text);
      check(`texto con $: ${text}`, formulas(html) === 0, html);
    }
  }
  {
    // Una oración con un comando suelto queda como texto (no se adivina la fórmula).
    const html = render("Donde \\bar{x} es el promedio de los datos medidos.");
    check("prosa con un comando", !html.includes("katex"), html);
  }
  {
    // Una ruta de Windows no es una línea de LaTeX (ni una fórmula con error).
    const html = render("Guárdalo en C:\\Users\\alan\\text");
    check("ruta con \\text", !html.includes("katex"), html);
  }
  {
    // Dentro de una tabla, en línea; la tabla se sigue pintando.
    const html = render("| Indicador | Fórmula |\n|---|---|\n| Productividad | $P = \\frac{U}{HH}$ |\n| OEE | $$D \\times R \\times C$$ |");
    check("tabla con fórmulas", html.includes("<table") && formulas(html) === 2 && displays(html) === 0, html);
  }
  {
    // Un paso de una lista con su fórmula en bloque: la lista sigue con sus dos ítems.
    const html = render("1. Calcula la productividad:\n   $$\n   P = \\frac{1200}{160}\n   $$\n2. Compara con el mes anterior.");
    check("bloque dentro de una lista", count(html, "<li ") === 2 && displays(html) === 1, html);
    check("bloque dentro del primer ítem", /<li [^>]*>[\s\S]*katex-display[\s\S]*<\/li>\s*<li /.test(html), html);
  }
  assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
}

function runSafety() {
  {
    // HTML: se muestra escapado, nunca como elementos.
    const html = render(
      'Antes <script>alert(1)</script> y <img src=x onerror="alert(1)"> y <iframe src="https://example.com"></iframe>\n\n<div onclick="alert(1)">caja</div>'
    );
    for (const tag of ["<script", "<img", "<iframe", "<div onclick"]) assert.ok(!html.includes(tag), `sin ${tag}`);
    assert.ok(html.includes("&lt;script&gt;"), "se ve como texto");
  }
  {
    // Enlaces: sin javascript:, vbscript: ni data:; los seguros abren en otra pestaña sin referrer.
    const html = render(
      "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](vbscript:msgbox(1)) [d](data:text/html;base64,PHNjcmlwdD4=) [e](https://opt-ia.test/guia)"
    );
    assert.ok(!/href="(?:javascript|vbscript|data):/i.test(html), html);
    assert.ok(html.includes('href="https://opt-ia.test/guia" target="_blank" rel="noreferrer noopener"'));
    assert.ok(!html.includes(" node="), "el nodo de Markdown no llega al DOM");
  }
  {
    // Imágenes: no se cargan; queda el texto alternativo.
    const html = render("![Diagrama de Ishikawa](https://tracker.example/pixel.png) y ![](https://tracker.example/sin-alt.png)");
    assert.ok(!html.includes("<img") && !html.includes("tracker.example"), html);
    assert.ok(html.includes("[Diagrama de Ishikawa]"));
  }
  {
    // Un <br> sí; un <br> con atributos, no.
    const html = render("uno<br>dos<br/>tres<br onmouseover=alert(1)>cuatro");
    assert.equal(count(html, "<br/>"), 2);
    assert.ok(html.includes("&lt;br onmouseover=alert(1)&gt;"), html);
  }
  {
    // Un contenido que no es texto se muestra como JSON, sin romper la lista.
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        messages: [{ id: "m1", role: "assistant", content: { a: 1 } as unknown as string, createdAt: "2026-10-20T10:00:00Z" }],
      })
    );
    assert.ok(html.includes("&quot;a&quot;: 1"));
  }
}

runStructure();
runMath();
runMathReadability();
runSafety();
console.log("messageMarkdown tests passed");
