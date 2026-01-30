"use client";

import { useEffect, useRef } from "react";

type SpotlightProps = {
  className?: string;
};

export function Spotlight({ className }: SpotlightProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // El contenedor que tiene la clase midnightStars (el <main>)
    const host = el.parentElement;
    if (!host) return;

    const setCenter = () => {
        const rect = host.getBoundingClientRect();
        host.style.setProperty("--spotlight-x", `${rect.width / 2}px`);
        host.style.setProperty("--spotlight-y", `${rect.height / 2}px`);
    };

    setCenter();

    const onMove = (ev: PointerEvent) => {
        if (rafRef.current !== null) return;

        rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;

        const rect = host.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;

        host.style.setProperty("--spotlight-x", `${x}px`);
        host.style.setProperty("--spotlight-y", `${y}px`);
        });
    };

    const onLeave = () => {
        setCenter();
    };

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", setCenter);

    return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        window.removeEventListener("resize", setCenter);
    };
    }, []);


    return (
    <div
        ref={ref}
        className={["spotlightOverlay", className].filter(Boolean).join(" ")}
        aria-hidden="true"
    />
    );

}
