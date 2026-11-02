import "server-only";
import { headers } from "next/headers";
import { countiesOf } from "./geo";
import { placeBuyer, type County, type Placement } from "./counties";
import type { FilterContext } from "./filters";
import { getDecisions, getMatches, getProfile, type MatchItem } from "./radar";

/**
 * Everything a page needs, fetched in parallel on the server.
 * RADAR_NOW pins the clock for screenshots and demos; it is never set in production.
 */
export async function loadRadar() {
  const [profile, { items, truncated }, decisions] = await Promise.all([
    getProfile(),
    getMatches(),
    getDecisions(),
  ]);
  const now = process.env.RADAR_NOW ?? new Date().toISOString();
  const previousVisit = (await headers()).get("x-radar-previous-visit") || null;

  const counties = new Map<string, County[]>(profile.states.map((s) => [s, countiesOf(s)]));
  const placed = new Map<string, Placement>();
  const place = (item: MatchItem): Placement => {
    const o = item.opportunity;
    let p = placed.get(o.id);
    if (!p) {
      p =
        o.buyer.level === "federal"
          ? { kind: "federal" }
          : placeBuyer({
              buyerName: o.buyer.name,
              buyerLevel: o.buyer.level,
              state: o.state,
              counties: (o.state && counties.get(o.state)) || [],
            });
      placed.set(o.id, p);
    }
    return p;
  };
  const decisionOf = new Map(decisions.map((d) => [d.opportunityId, d.decision]));
  const ctx: FilterContext = {
    now,
    previousVisit,
    passed: new Set(decisions.filter((d) => d.decision === "pass").map((d) => d.opportunityId)),
    countyOf: (item) => {
      const p = place(item);
      return p.kind === "county" ? p.county.fips : null;
    },
  };
  return { profile, items, truncated, now, previousVisit, place, decisionOf, ctx, counties };
}
