import * as React from "react";

type PartnerLogoProps = {
  className?: string;
  label?: string;
};

export function PartnerLogo({ className, label = "Plataforma aliada" }: PartnerLogoProps) {
  return (
    <div
      className={["inline-flex items-center gap-2", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="h-7 w-7 rounded-lg border border-white/15 bg-white/5 grid place-items-center flex-shrink-0">
        <span className="text-[11px] font-bold text-slate-400 select-none">P</span>
      </div>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}
