"use client";

import * as React from "react";
import { useReducedMotion } from "framer-motion";

/* ── 5 × 7 pixel glyphs ─────────────────────────────────
   '1' = active dot  |  '0' = empty slot
   ────────────────────────────────────────────────────── */
const GLYPHS: Record<string, readonly string[]> = {
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  A: ["00100", "01010", "01010", "10001", "11111", "10001", "10001"],
} as const;

const CHAR_COLS = 5;  // each glyph is 5 columns wide
const CHAR_GAP_COLS = 2; // empty columns between chars
const ROWS = 7;
const MAGNET_RADIUS = 70; // px influence radius
const MAGNET_FORCE = 8;   // max px displacement

type DotEntry = {
  key: string;
  col: number;
  row: number;
};

function buildLayout(text: string): { dots: DotEntry[]; totalCols: number } {
  const chars = text
    .toUpperCase()
    .split("")
    .filter((c) => c in GLYPHS);

  const totalCols =
    chars.length === 0
      ? 0
      : chars.length * CHAR_COLS + (chars.length - 1) * CHAR_GAP_COLS;

  const dots: DotEntry[] = [];
  chars.forEach((char, ci) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const colOffset = ci * (CHAR_COLS + CHAR_GAP_COLS);
    glyph.forEach((rowStr, ri) => {
      for (let di = 0; di < rowStr.length; di++) {
        if (rowStr[di] === "1") {
          dots.push({ key: `${ci}-${ri}-${di}`, col: colOffset + di, row: ri });
        }
      }
    });
  });

  return { dots, totalCols };
}

export type DotMatrixWordProps = {
  text?: string;
  className?: string;
  dotClassName?: string;
  "aria-label"?: string;
};

export function DotMatrixWord({
  text = "OPT-IA",
  className,
  dotClassName,
  "aria-label": ariaLabel,
}: DotMatrixWordProps) {
  const shouldReduce = useReducedMotion();

  const { dots, totalCols } = React.useMemo(() => buildLayout(text), [text]);

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const dotRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const dotCenters = React.useRef<Array<{ x: number; y: number }>>([]);
  const rafRef = React.useRef<number | null>(null);
  const pendingPos = React.useRef<{ cx: number; cy: number } | null>(null);

  /* ── Cache dot centers (relative to container) ── */
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const compute = () => {
      const cr = container.getBoundingClientRect();
      dotCenters.current = dotRefs.current.map((el) => {
        if (!el) return { x: 0, y: 0 };
        const r = el.getBoundingClientRect();
        return {
          x: r.left - cr.left + r.width * 0.5,
          y: r.top - cr.top + r.height * 0.5,
        };
      });
    };

    compute();

    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [dots]);

  /* ── Magnetic pointer effect ── */
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || shouldReduce) return;

    const applyMagnetism = () => {
      rafRef.current = null;
      const pos = pendingPos.current;
      if (!pos) return;
      const { cx, cy } = pos;

      dotRefs.current.forEach((el, i) => {
        if (!el) return;
        const center = dotCenters.current[i];
        if (!center) return;
        const dx = cx - center.x;
        const dy = cy - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < MAGNET_RADIUS && dist > 0) {
          const t = 1 - dist / MAGNET_RADIUS;
          const force = t * MAGNET_FORCE;
          const ox = (dx / dist) * force;
          const oy = (dy / dist) * force;
          el.style.transform = `translate3d(${ox}px,${oy}px,0)`;
          el.style.opacity = String(0.6 + 0.4 * t);
        } else {
          el.style.transform = "";
          el.style.opacity = "";
        }
      });
    };

    const onMove = (e: PointerEvent) => {
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
      pendingPos.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      dotRefs.current.forEach((el) => {
        if (!el) return;
        el.style.transform = "";
        el.style.opacity = "";
      });
    };

    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
    };
  }, [shouldReduce, dots]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel ?? text}
      className={["dot-matrix-word", className].filter(Boolean).join(" ")}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${totalCols}, var(--dms, 5px))`,
        gridTemplateRows: `repeat(${ROWS}, var(--dms, 5px))`,
        columnGap: "var(--dmg, 2px)",
        rowGap: "var(--dmg, 2px)",
        width: "fit-content",
      }}
    >
      {dots.map((dot, i) => (
        <span
          key={dot.key}
          ref={(el) => {
            dotRefs.current[i] = el;
          }}
          aria-hidden="true"
          className={
            dotClassName ??
            "rounded-full bg-sky-300/65 will-change-transform"
          }
          style={{
            gridColumn: dot.col + 1,
            gridRow: dot.row + 1,
          }}
        />
      ))}
    </div>
  );
}
