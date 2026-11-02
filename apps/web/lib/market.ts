import type { County, Placement } from "./counties";
import type { MatchItem } from "./radar";
import { statedValue } from "./format";

/** Market-screen numbers for one tab. Pure, so each figure has a unit test with hand-checked answers. */
export interface MarketStats {
  open: number;
  strong: number;
  dueIn14: number;
  value: { total: number; covered: number; of: number };
  byCounty: Map<string, { county: County; count: number }>;
  statewide: number;
  federal: number;
  unplaced: { count: number; buyers: string[] };
  closing: { day: string; count: number }[];
  topBuyers: { name: string; count: number }[];
}

const DAY = 86_400_000;

/** Calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function localDay(iso: string, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function marketStats(
  items: MatchItem[],
  place: (item: MatchItem) => Placement,
  now: string,
  timeZone = "America/New_York",
  days = 30,
): MarketStats {
  const nowMs = Date.parse(now);
  const byCounty = new Map<string, { county: County; count: number }>();
  const unplacedBuyers = new Map<string, number>();
  const buyers = new Map<string, number>();
  let statewide = 0;
  let federal = 0;
  let unplaced = 0;
  let total = 0;
  let covered = 0;
  let dueIn14 = 0;

  // One bucket per calendar day for the next `days` days, starting today in the viewer's time zone.
  const today = localDay(now, timeZone);
  const closing = Array.from({ length: days }, (_, i) => ({
    day: localDay(new Date(Date.parse(`${today}T12:00:00Z`) + i * DAY).toISOString(), "UTC"),
    count: 0,
  }));
  const slot = new Map(closing.map((c, i) => [c.day, i] as const));

  for (const item of items) {
    const o = item.opportunity;
    const p = place(item);
    if (p.kind === "county") {
      const cur = byCounty.get(p.county.fips);
      byCounty.set(p.county.fips, { county: p.county, count: (cur?.count ?? 0) + 1 });
    } else if (p.kind === "statewide") statewide++;
    else if (p.kind === "federal") federal++;
    else {
      unplaced++;
      unplacedBuyers.set(o.buyer.name, (unplacedBuyers.get(o.buyer.name) ?? 0) + 1);
    }
    buyers.set(o.buyer.name, (buyers.get(o.buyer.name) ?? 0) + 1);
    const value = statedValue(o.estimatedValue);
    if (value) {
      total += value.amount;
      covered++;
    }
    if (o.dueAt) {
      const left = Date.parse(o.dueAt) - nowMs;
      if (left >= 0 && left <= 14 * DAY) dueIn14++;
      const i = slot.get(localDay(o.dueAt, timeZone));
      if (i !== undefined) closing[i]!.count++;
    }
  }

  const ranked = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    open: items.length,
    strong: items.filter((i) => i.match.band === "strong").length,
    dueIn14,
    value: { total, covered, of: items.length },
    byCounty,
    statewide,
    federal,
    unplaced: {
      count: unplaced,
      buyers: ranked(unplacedBuyers)
        .slice(0, 8)
        .map(([n]) => n),
    },
    closing,
    topBuyers: ranked(buyers)
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
  };
}

/** Five shades for the map: 0 gets none; the rest split by the largest county count. */
export function shadeStep(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}
