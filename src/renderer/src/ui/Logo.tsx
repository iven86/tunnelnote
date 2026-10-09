export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      className="logo-mark"
      height={size}
      viewBox="0 0 64 64"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="tn-bg" x1="6" x2="58" y1="4" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#19d3b5" />
          <stop offset="1" stopColor="#5b5bf0" />
        </linearGradient>
        <linearGradient id="tn-glow" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect fill="url(#tn-bg)" height="60" rx="16" width="60" x="2" y="2" />
      <rect fill="url(#tn-glow)" height="30" rx="14" width="56" x="4" y="4" />
      <path
        d="M14 52V32a18 18 0 0 1 36 0v20"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="4.5"
      />
      <path
        d="M22 52V33a10 10 0 0 1 20 0v19"
        fill="none"
        opacity="0.5"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="3.5"
      />
      <path
        d="m27 37 5.5 5L27 47"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.5"
      />
      <path d="M35.5 47.5H40" stroke="#fff" strokeLinecap="round" strokeWidth="3.5" />
    </svg>
  );
}

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo" role="img" aria-label="TunnelNote">
      <LogoMark size={size} />
      <span aria-hidden className="logo-word">
        <span className="logo-word-main">Tunnel</span>
        <span className="logo-word-accent">Note</span>
      </span>
    </span>
  );
}
