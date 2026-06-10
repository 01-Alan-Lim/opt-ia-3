import * as React from "react";

type OPTIALogoProps = {
  className?: string;
  label?: string;
};

export function OPTIALogo({ className, label }: OPTIALogoProps) {
  return (
    <div
      className={["inline-flex items-center gap-2.5", className]
        .filter(Boolean)
        .join(" ")}
    >
      <svg
        width="38"
        height="38"
        viewBox="0 0 38 38"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={label ? undefined : true}
        role={label ? "img" : undefined}
      >
        {/* Hexagonal frame */}
        <path
          d="M19 2.5L34 11V27L19 35.5L4 27V11L19 2.5Z"
          fill="rgba(14,165,233,0.09)"
          stroke="rgba(56,189,248,0.42)"
          strokeWidth="1.15"
        />
        {/* Central node */}
        <circle cx="19" cy="19" r="3.2" fill="rgba(56,189,248,0.93)" />
        {/* 6 outer nodes */}
        <circle cx="19" cy="8.2"  r="2.1"  fill="rgba(125,211,252,0.78)" />
        <circle cx="28"  cy="13.5" r="1.85" fill="rgba(125,211,252,0.65)" />
        <circle cx="28"  cy="24.5" r="1.85" fill="rgba(125,211,252,0.58)" />
        <circle cx="19" cy="29.8" r="2.1"  fill="rgba(125,211,252,0.52)" />
        <circle cx="10"  cy="24.5" r="1.85" fill="rgba(125,211,252,0.58)" />
        <circle cx="10"  cy="13.5" r="1.85" fill="rgba(125,211,252,0.65)" />
        {/* Spoke lines: center → each outer node */}
        <line x1="19"   y1="15.8" x2="19"   y2="10.3" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
        <line x1="21.8" y1="17.5" x2="26.15" y2="14.8" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
        <line x1="21.8" y1="20.5" x2="26.15" y2="23.2" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
        <line x1="19"   y1="22.2" x2="19"   y2="27.7" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
        <line x1="16.2" y1="20.5" x2="11.85" y2="23.2" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
        <line x1="16.2" y1="17.5" x2="11.85" y2="14.8" stroke="rgba(56,189,248,0.30)" strokeWidth="1.05" />
      </svg>
      {label != null ? (
        <span className="text-base font-bold tracking-tight text-slate-100">{label}</span>
      ) : null}
    </div>
  );
}
