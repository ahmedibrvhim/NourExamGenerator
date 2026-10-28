import { useId } from "react";

// The Al-Nour mark: an open book (the source PDF) under a spark of light (نور) with a tick (the finished exam).
// Colours come from the active theme through CSS variables, so it re-tints when the theme changes.
export default function Emblem({ animated = false, size = 120 }: { animated?: boolean; size?: number }) {
  const id = useId().replace(/:/g, "");
  const g = `em-g-${id}`, glow = `em-glow-${id}`;
  const rays = [-72, -48, -24, 0, 24, 48, 72]; // a fan of light above the book
  return (
    <svg className={`emblem${animated ? " emblem-anim" : ""}`} width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="شعار سنتر النور التعليمي">
      <defs>
        <linearGradient id={g} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="120" y2="120">
          <stop offset="0" style={{ stopColor: "var(--logo-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-b)" }} />
        </linearGradient>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      <circle className="em-glow" cx="60" cy="52" r="56" fill={`url(#${glow})`} />

      <g className="em-rays" stroke={`url(#${g})`} strokeWidth="2.4" strokeLinecap="round">
        {rays.map((a) => (
          <line key={a} x1="60" y1="12" x2="60" y2="19" transform={`rotate(${a} 60 52)`} />
        ))}
      </g>

      {/* open book */}
      <g className="em-book" fill="rgba(255,255,255,.04)" stroke={`url(#${g})`} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M60 96 C48 87 30 85 15 89 L15 55 C30 51 48 53 60 62 Z" />
        <path d="M60 96 C72 87 90 85 105 89 L105 55 C90 51 72 53 60 62 Z" />
      </g>
      <g className="em-lines" stroke={`url(#${g})`} strokeWidth="2.6" strokeLinecap="round" opacity=".8">
        <line x1="25" y1="65" x2="48" y2="69" pathLength="1" />
        <line x1="25" y1="74" x2="48" y2="78" pathLength="1" />
      </g>
      <path className="em-tick" d="M71 71 L78 78 L92 64" fill="none" stroke={`url(#${g})`} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" pathLength="1" />

      {/* spark of light */}
      <path className="em-spark" d="M60 28 C61.5 36 64 38.5 72 40 C64 41.5 61.5 44 60 52 C58.5 44 56 41.5 48 40 C56 38.5 58.5 36 60 28 Z" fill={`url(#${g})`} />
    </svg>
  );
}
