"use client";

import * as React from "react";
import { useReducedMotion } from "framer-motion";
import clsx from "clsx";

/* ── Dot-matrix glyphs: '1' = dot, '0' = empty ───────────────
   Letras OPT-IA con trazo de 1 punto (estilo OPTUS) pero formas
   más robustas y legibles. Cada glifo declara su propio ancho
   (glyph[0].length), así el guion puede ser más corto. */
const GLYPHS: Record<string, readonly string[]> = {
  // O cerrada y robusta (5×7)
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  // P con columna izquierda fuerte y panza superior clara (5×7)
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  // T con barra superior ancha y columna central (5×7)
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  // I con barra superior e inferior (no una línea fina) (5×7)
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  // A sólida: pico, paredes y travesaño completo (5×7)
  A: ["00100", "01110", "10001", "10001", "11111", "10001", "10001"],
  // Guion corto y centrado (3×7) — solo la fila media
  "-": ["000", "000", "000", "111", "000", "000", "000"],
} as const;

const ROWS = 7;

type DotEntry = { key: string; x: number; y: number };
type Layout   = { dots: DotEntry[]; width: number; height: number };

function buildLayout(
  text: string,
  dotSize: number,
  gap: number,
  letterGap: number,
): Layout {
  const chars = text
    .toUpperCase()
    .split("")
    .filter((c) => c in GLYPHS);

  const step = dotSize + gap; // distancia centro-a-centro entre puntos contiguos
  const dots: DotEntry[] = [];
  let xOffset = 0;

  chars.forEach((char, ci) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const cols = glyph[0].length;

    glyph.forEach((rowStr, ri) => {
      for (let di = 0; di < rowStr.length; di++) {
        if (rowStr[di] === "1") {
          dots.push({
            key: `${ci}-${ri}-${di}`,
            x:   xOffset + di * step,
            y:   ri * step,
          });
        }
      }
    });

    // ancho en píxeles del bloque de la letra + separación entre letras
    const blockWidth = cols * dotSize + (cols - 1) * gap;
    xOffset += blockWidth + letterGap;
  });

  // ancho total: descontar el último letterGap sobrante
  const width  = chars.length === 0 ? 0 : xOffset - letterGap;
  const height = ROWS * dotSize + (ROWS - 1) * gap;

  return { dots, width, height };
}

export type MagneticDotWordProps = {
  text?:         "OPT-IA";
  className?:    string;
  dotSize?:      number;
  gap?:          number;
  letterGap?:    number;
  pullDistance?: number;
  strength?:     number;
};

export function MagneticDotWord({
  text         = "OPT-IA",
  className,
  dotSize      = 18,
  gap          = 10,
  letterGap    = 18,
  pullDistance = 110,
  strength     = 0.6,
}: MagneticDotWordProps) {
  const shouldReduce = useReducedMotion();

  /* Tamaño "natural" (a escala 1) con las props de desktop. */
  const natural = React.useMemo(
    () => buildLayout(text, dotSize, gap, letterGap),
    [text, dotSize, gap, letterGap],
  );

  /* Escala para que la marca SIEMPRE quepa en su contenedor
     (nunca se corta) sin pasar de su tamaño desktop (scale ≤ 1).
     Usa medidas reales (no transform), así no deja huecos. */
  const outerRef = React.useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = React.useState(0);

  React.useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale =
    avail > 0 && natural.width > 0 ? Math.min(1, avail / natural.width) : 1;

  /* Medidas efectivas (escaladas para encajar) */
  const dotPx       = dotSize * scale;
  const gapPx       = gap * scale;
  const letterGapPx = letterGap * scale;
  const pullPx      = pullDistance * scale;

  const layout = React.useMemo(
    () => buildLayout(text, dotPx, gapPx, letterGapPx),
    [text, dotPx, gapPx, letterGapPx],
  );
  const { dots, width, height } = layout;

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const dotRefs      = React.useRef<Array<HTMLSpanElement | null>>([]);
  const dotCenters   = React.useRef<Array<{ x: number; y: number }>>([]);
  const rafRef       = React.useRef<number | null>(null);
  const pendingPos   = React.useRef<{ cx: number; cy: number } | null>(null);
  const isReturning  = React.useRef(false);
  const pulseUntil   = React.useRef(0);

  /* ── Cache dot centers relative to container ── */
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const compute = () => {
      const cr = container.getBoundingClientRect();
      dotCenters.current = dotRefs.current.map((el) => {
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
          x: r.left - cr.left + r.width  * 0.5,
          y: r.top  - cr.top  + r.height * 0.5,
        };
      });
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [layout]);

  /* ── Magnetic pointer effect ── */
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || shouldReduce) return;

    const applyMagnetism = () => {
      rafRef.current = null;
      const pos = pendingPos.current;
      if (!pos) return;
      // Mientras dura el "pulse" del click, no pisar las transforms del rebote.
      if (performance.now() < pulseUntil.current) return;
      const { cx, cy } = pos;

      dotRefs.current.forEach((el, i) => {
        if (!el) return;
        const center = dotCenters.current[i];
        if (!center) return;
        const dx   = cx - center.x;
        const dy   = cy - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < pullPx && dist > 0) {
          // caída suave (t²): los puntos cercanos se atraen con claridad
          // sin arrastrar todo el logo de forma caótica.
          const t     = 1 - dist / pullPx;
          const force = t * t * strength * pullPx;
          const ox    = (dx / dist) * force;
          const oy    = (dy / dist) * force;
          el.style.transform = `translate3d(${ox}px,${oy}px,0)`;
        } else {
          el.style.transform = "";
        }
      });
    };

    const onMove = (e: PointerEvent) => {
      /* Clear spring-return transition once when cursor re-enters */
      if (isReturning.current) {
        dotRefs.current.forEach((el) => {
          if (el) el.style.transition = "";
        });
        isReturning.current = false;
      }

      const rect = container.getBoundingClientRect();
      pendingPos.current = {
        cx: e.clientX - rect.left,
        cy: e.clientY - rect.top,
      };
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(applyMagnetism);
      }
    };

    const onLeave = () => {
      isReturning.current = true;
      pendingPos.current  = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      /* Retorno tipo spring vía CSS transition */
      dotRefs.current.forEach((el) => {
        if (!el) return;
        el.style.transition = "transform 0.55s cubic-bezier(0.34,1.56,0.64,1)";
        el.style.transform  = "";
      });
    };

    /* Click: rebote local ("pulse") de los puntos cercanos al click */
    const onDown = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      pulseUntil.current = performance.now() + 220;

      dotRefs.current.forEach((el, i) => {
        if (!el) return;
        const center = dotCenters.current[i];
        if (!center) return;
        const dx   = cx - center.x;
        const dy   = cy - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= pullPx) return;

        const t   = 1 - dist / pullPx;
        const pop = 1 + 0.55 * t;                       // escala del rebote
        const ox  = dist > 0 ? -(dx / dist) * 10 * t : 0; // empuje hacia afuera
        const oy  = dist > 0 ? -(dy / dist) * 10 * t : 0;
        el.style.transition = "transform 0.2s cubic-bezier(0.34,1.56,0.64,1)";
        el.style.transform  = `translate3d(${ox}px,${oy}px,0) scale(${pop})`;
        window.setTimeout(() => {
          if (!el) return;
          el.style.transform = "";
        }, 200);
      });
    };

    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);
    container.addEventListener("pointerdown", onDown);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("pointerdown", onDown);
    };
  }, [shouldReduce, layout, pullPx, strength]);

  return (
    <div ref={outerRef} className={clsx("w-full", className)}>
      <div
        ref={containerRef}
        role="img"
        aria-label={text}
        className="relative mx-auto select-none"
        style={{ width, height }}
      >
        {dots.map((dot, i) => (
        <span
          key={dot.key}
          ref={(el) => { dotRefs.current[i] = el; }}
          aria-hidden="true"
          className="will-change-transform"
          style={{
            position:     "absolute",
            left:         dot.x,
            top:          dot.y,
            width:        dotPx,
            height:       dotPx,
            borderRadius: "9999px",
            background:   "rgba(235, 250, 255, 0.96)",
            boxShadow:
              "0 0 10px rgba(56, 189, 248, 0.45), 0 0 22px rgba(14, 165, 233, 0.25)",
            display:      "block",
          }}
        />
        ))}
      </div>
    </div>
  );
}
