import * as React from "react";

export type MinimalIconName = "compass" | "layers" | "file" | "spark" | "check" | "chart";

type Props = {
  name: MinimalIconName;
  className?: string;
  title?: string;
};

// Minimal, single-color icons (no external deps).
export function MinimalIcon({ name, className, title }: Props) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    className,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
  } as const;

  const strokeProps = {
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  const paths: Record<MinimalIconName, React.ReactNode> = {
    compass: (
      <>
        <path {...strokeProps} d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z" />
        <path {...strokeProps} d="M10.5 10.5L8.8 15.2l4.7-1.7l1.7-4.7l-4.7 1.7Z" />
      </>
    ),
    layers: (
      <>
        <path {...strokeProps} d="M12 4l8 4-8 4-8-4 8-4Z" />
        <path {...strokeProps} d="M4 12l8 4 8-4" />
        <path {...strokeProps} d="M4 16l8 4 8-4" />
      </>
    ),
    file: (
      <>
        <path {...strokeProps} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
        <path {...strokeProps} d="M14 3v5h5" />
        <path {...strokeProps} d="M8 13h8" />
        <path {...strokeProps} d="M8 16h6" />
      </>
    ),
    spark: (
      <>
        <path {...strokeProps} d="M12 2l1.1 4.3L17 7.4l-3.9 1.1L12 13l-1.1-4.5L7 7.4l3.9-1.1L12 2Z" />
        <path {...strokeProps} d="M5 13l.7 2.2L8 16l-2.3.8L5 19l-.7-2.2L2 16l2.3-.8L5 13Z" />
      </>
    ),
    check: (
      <>
        <path {...strokeProps} d="M9 12l2 2 4-5" />
        <path {...strokeProps} d="M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18Z" />
      </>
    ),
    chart: (
      <>
        <path {...strokeProps} d="M4 19V5" />
        <path {...strokeProps} d="M4 19h16" />
        <path {...strokeProps} d="M8 15v-3" />
        <path {...strokeProps} d="M12 15V9" />
        <path {...strokeProps} d="M16 15V7" />
      </>
    ),
  };

  return (
    <svg {...common}>
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}