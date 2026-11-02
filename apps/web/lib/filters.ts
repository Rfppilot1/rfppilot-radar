import type { MatchItem } from "./radar";

/**
 * Everything a view shows is described by the URL, so a filtered view can be bookmarked or sent to a colleague.
 * These functions are pure: the pages pass in the items, decisions and clock, and get the filtered list back.
 */
export const NOTICE_TYPES = ["rfp", "rfq", "itb", "itn", "soq", "rfi"] as const;
export type NoticeTypeFilter = (typeof NOTICE_TYPES)[number] | "other";
export const DUE_WINDOWS = [7, 14, 30] as const;
export const SORTS = ["fit", "due", "new"] as const;

export interface View {
  /** "all", "federal", or a two-letter state the profile covers. */
  tab: string;
  fit: "all" | "strong";
  level: "all" | "state" | "local";
  type: NoticeTypeFilter | "all";
  due: (typeof DUE_WINDOWS)[number] | null;
  q: string;
  /** Five-digit county FIPS code, set by clicking the map. */
  county: string | null;
  fresh: boolean;
  hidePassed: boolean;
  sort: (typeof SORTS)[number];
  /** Opportunity id shown in the detail panel. */
  open: string | null;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

export function parseView(params: Params, states: string[]): View {
  const tabRaw = one(params.tab).toLowerCase();
  const tab =
    tabRaw === "federal" ? "federal" : states.map((s) => s.toLowerCase()).includes(tabRaw) ? tabRaw : "all";
  const typeRaw = one(params.type).toLowerCase();
  const due = Number(one(params.due));
  const sort = one(params.sort) as View["sort"];
  const county = one(params.county);
  return {
    tab,
    fit: one(params.fit) === "strong" ? "strong" : "all",
    level: one(params.level) === "state" ? "state" : one(params.level) === "local" ? "local" : "all",
    type: (NOTICE_TYPES as readonly string[]).includes(typeRaw)
      ? (typeRaw as NoticeTypeFilter)
      : typeRaw === "other"
        ? "other"
        : "all",
    due: (DUE_WINDOWS as readonly number[]).includes(due) ? (due as View["due"]) : null,
    q: one(params.q).slice(0, 80),
    county: /^\d{5}$/.test(county) ? county : null,
    fresh: one(params.fresh) === "1",
    hidePassed: one(params.passed) !== "show",
    sort: (SORTS as readonly string[]).includes(sort) ? sort : "fit",
    open: one(params.open) || null,
  };
}

/** Builds a URL for the same page with some view settings changed; defaults are left out to keep URLs short. */
export function viewHref(path: string, view: View, change: Partial<View> = {}): string {
  const v = { ...view, ...change };
  const p = new URLSearchParams();
  if (v.tab !== "all") p.set("tab", v.tab);
  if (v.fit !== "all") p.set("fit", v.fit);
  if (v.level !== "all") p.set("level", v.level);
  if (v.type !== "all") p.set("type", v.type);
  if (v.due) p.set("due", String(v.due));
  if (v.q) p.set("q", v.q);
  if (v.county) p.set("county", v.county);
  if (v.fresh) p.set("fresh", "1");
  if (!v.hidePassed) p.set("passed", "show");
  if (v.sort !== "fit") p.set("sort", v.sort);
  if (v.open) p.set("open", v.open);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** Which tab a notice belongs to: federal buyers on their own tab, everything else under its state. */
export function tabOf(item: MatchItem): string {
  return item.opportunity.buyer.level === "federal"
    ? "federal"
    : (item.opportunity.state ?? "").toLowerCase() || "other";
}

export function typeOf(item: MatchItem): NoticeTypeFilter {
  const k = item.opportunity.kind as string;
  return (NOTICE_TYPES as readonly string[]).includes(k) ? (k as NoticeTypeFilter) : "other";
}

export interface FilterContext {
  now: string;
  /** Start of the visitor's previous visit, for "new since my last visit". */
  previousVisit: string | null;
  /** Opportunity ids the firm answered "No" (pass) on. */
  passed: ReadonlySet<string>;
  countyOf: (item: MatchItem) => string | null;
}

const DAY = 86_400_000;

/** Everything except the tab; used both for the list and for the per-tab counts. */
function matchesFilters(item: MatchItem, v: View, ctx: FilterContext): boolean {
  const o = item.opportunity;
  if (v.fit === "strong" && item.match.band !== "strong") return false;
  if (v.level !== "all" && o.buyer.level !== v.level) return false;
  if (v.type !== "all" && typeOf(item) !== v.type) return false;
  if (v.due) {
    if (!o.dueAt) return false;
    const left = Date.parse(o.dueAt) - Date.parse(ctx.now);
    if (left < 0 || left > v.due * DAY) return false;
  }
  if (v.q) {
    const hay = `${o.buyer.name} ${o.title} ${o.solicitationNumber ?? ""}`.toLowerCase();
    if (
      !v.q
        .toLowerCase()
        .split(/\s+/)
        .every((w) => hay.includes(w))
    )
      return false;
  }
  if (v.county && ctx.countyOf(item) !== v.county) return false;
  if (v.fresh) {
    const since = ctx.previousVisit;
    const first = item.match.firstGoodAt ?? item.match.firstMatchedAt;
    if (since && first < since) return false;
  }
  if (v.hidePassed && ctx.passed.has(o.id)) return false;
  return true;
}

export function applyView(items: MatchItem[], v: View, ctx: FilterContext): MatchItem[] {
  const list = items.filter((i) => (v.tab === "all" || tabOf(i) === v.tab) && matchesFilters(i, v, ctx));
  const due = (i: MatchItem) =>
    i.opportunity.dueAt ? Date.parse(i.opportunity.dueAt) : Number.POSITIVE_INFINITY;
  const first = (i: MatchItem) => i.match.firstGoodAt ?? i.match.firstMatchedAt;
  return list.sort((a, b) =>
    v.sort === "due"
      ? due(a) - due(b) || b.match.score - a.match.score
      : v.sort === "new"
        ? first(b).localeCompare(first(a)) || b.match.score - a.match.score
        : b.match.score - a.match.score || due(a) - due(b),
  );
}

/** Count per tab with the current filters applied, so a tab shows what clicking it would show. */
export function tabCounts(
  items: MatchItem[],
  v: View,
  states: string[],
  ctx: FilterContext,
): { tab: string; label: string; count: number }[] {
  const filtered = items.filter((i) => matchesFilters(i, v, ctx));
  const count = (tab: string) => filtered.filter((i) => tab === "all" || tabOf(i) === tab).length;
  return [
    { tab: "all", label: "All", count: count("all") },
    ...states.map((s) => ({
      tab: s.toLowerCase(),
      label: STATE_NAMES[s.toUpperCase()] ?? s,
      count: count(s.toLowerCase()),
    })),
    { tab: "federal", label: "Federal", count: count("federal") },
  ];
}

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
