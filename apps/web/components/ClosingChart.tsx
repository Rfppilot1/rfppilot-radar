import { shortDate } from "@/lib/format";

/** Bids closing per day for the next 30 days. One series, one hue; weekly ticks; the busiest day is labeled. */
export function ClosingChart({ days }: { days: { day: string; count: number }[] }) {
  const W = 1200;
  const H = 200;
  const pad = { l: 28, r: 8, t: 18, b: 26 };
  const max = Math.max(1, ...days.map((d) => d.count));
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (n: number) => pad.t + (H - pad.t - pad.b) * (1 - n / max);
  const peak = days.reduce((a, b) => (b.count > a.count ? b : a), days[0] ?? { day: "", count: 0 });
  const label = (d: string) => shortDate(`${d}T12:00:00Z`, "UTC").replace(/, \d{4}$/, "");
  const total = days.reduce((s, d) => s + d.count, 0);
  const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${total} bids close in the next 30 days; busiest day ${label(peak.day)} with ${peak.count}.`}
      className="h-auto w-full"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e6eef4" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={12} fill="#556175">
            {t}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = pad.l + i * bw;
        const h = H - pad.b - y(d.count);
        return (
          <g key={d.day}>
            <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent">
              <title>{`${label(d.day)}: ${d.count} closing`}</title>
            </rect>
            {d.count > 0 && (
              <rect
                x={x + 1}
                y={y(d.count)}
                width={Math.max(1, bw - 2)}
                height={h}
                rx={2}
                fill="var(--color-brand)"
                pointerEvents="none"
              />
            )}
            {i % 7 === 0 && (
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize={12} fill="#556175">
                {label(d.day)}
              </text>
            )}
          </g>
        );
      })}
      {peak.count > 0 && (
        <text
          x={pad.l + days.indexOf(peak) * bw + bw / 2}
          y={y(peak.count) - 5}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill="#14213d"
        >
          {peak.count}
        </text>
      )}
    </svg>
  );
}
