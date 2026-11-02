/** The Radar suite icon (Brand/Suite Icons/svg/radar-icon.svg), inline so it needs no extra request. */
export function RadarMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="shrink-0 rounded-[24%] shadow-md ring-2 ring-white/70"
    >
      <defs>
        <linearGradient id="radar-mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#13B7CA" />
          <stop offset="1" stopColor="#2F6BED" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#radar-mark-g)" />
      <g transform="translate(23,23) scale(2.29)">
        <circle cx="12" cy="12" r="10" stroke="#D5ECFB" strokeWidth="2" fill="none" />
        <circle cx="12" cy="12" r="5" stroke="#D5ECFB" strokeWidth="2" fill="none" />
        <path d="M12 12 L12 2 A10 10 0 0 1 21.66 9.41 Z" fill="#FFFFFF" />
        <circle cx="6.6" cy="15.6" r="1.9" fill="#FFFFFF" />
      </g>
    </svg>
  );
}
