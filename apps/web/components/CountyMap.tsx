import Link from "next/link";
import type { StateMap } from "@/lib/geo";
import { shadeStep } from "@/lib/market";

const FILL = [
  "#eef3f7",
  "var(--color-shade-1)",
  "var(--color-shade-2)",
  "var(--color-shade-3)",
  "var(--color-shade-4)",
];

/** Counties shaded by open-bid count; each county with bids links to the filtered list. Server-rendered SVG. */
export function CountyMap({
  map,
  counts,
  hrefFor,
  label,
}: {
  map: StateMap;
  counts: Map<string, number>;
  hrefFor: (fips: string) => string;
  label: string;
}) {
  const max = Math.max(0, ...counts.values());
  return (
    <figure>
      <svg viewBox={`0 0 ${map.width} ${map.height}`} role="img" aria-label={label} className="h-auto w-full">
        {map.counties.map((c) => {
          const n = counts.get(c.fips) ?? 0;
          const shape = (
            <path
              d={c.d}
              fill={FILL[shadeStep(n, max)]}
              stroke="#ffffff"
              strokeWidth={0.8}
              className={n ? "transition-opacity hover:opacity-80" : ""}
            >
              <title>{`${c.name} County: ${n} open ${n === 1 ? "bid" : "bids"}`}</title>
            </path>
          );
          return n ? (
            <Link key={c.fips} href={hrefFor(c.fips)} aria-label={`${c.name} County, ${n} open bids`}>
              {shape}
            </Link>
          ) : (
            <g key={c.fips}>{shape}</g>
          );
        })}
        <path d={map.outline} fill="none" stroke="#9fb4c6" strokeWidth={1} />
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>Open bids per county:</span>
        {[0, 1, 2, 3, 4].map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span
              className="inline-block size-3 rounded-sm border border-line"
              style={{ background: FILL[s] }}
            />
            {s === 0 ? "None" : s === 1 ? "Fewer" : s === 4 ? `Most (${max})` : ""}
          </span>
        ))}
        <span>Click a county to see its bids.</span>
      </figcaption>
    </figure>
  );
}
