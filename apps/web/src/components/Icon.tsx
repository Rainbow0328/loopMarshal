import type { CSSProperties } from "react";

const paths = {
  workspace: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M3 9h18M9 9v12" />
    </>
  ),
  book: (
    <>
      <path d="M12 5v16M12 5C9 2 5 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-2-9 1Z" />
    </>
  ),
  model: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="3" />
      <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3M10 10h4v4h-4z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5" />
    </>
  ),
  settings: (
    <>
      <path d="m9 4 1-2h4l1 2 2 1 2-.2 2 3.4-1.2 1.7v2.2l1.2 1.7-2 3.4-2-.2-2 1-1 2h-4l-1-2-2-1-2 .2-2-3.4L4.2 12V9.8L3 8.1l2-3.4 2 .2Z" />
      <circle cx="12" cy="11" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  external: (
    <path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  send: (
    <>
      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
      <path d="M7 12h14" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  file: (
    <>
      <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  panel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 3v18m5-13 3 4-3 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function LoopMark({ size = 32 }: { size?: number }) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className="loop-mark"
      src="/loopmarshal.png"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
