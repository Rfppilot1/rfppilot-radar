import Link from "next/link";
import { Bars } from "@/components/Bars";
import { ClosingChart } from "@/components/ClosingChart";
import { CountyMap } from "@/components/CountyMap";
import { Funnel } from "@/components/Funnel";
import { Tabs } from "@/components/Tabs";
import { applyView, parseView, STATE_NAMES, tabCounts, viewHref, type View } from "@/lib/filters";
import { money, TIME_ZONE } from "@/lib/format";
import { stateMap } from "@/lib/geo";
import { loadRadar } from "@/lib/load";
import { marketStats } from "@/lib/market";
import { API_PAGE_LIMIT, getGlance } from "@/lib/radar";

export const dynamic = "force-dynamic";
const PATH = "/market";

export default async function Market({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [data, glance] = await Promise.all([loadRadar(), getGlance().catch(() => null)]);
  const { profile, items, truncated, ctx, now, place } = data;
  // The market view ignores list-only settings (county, search, sort, open item); tab and fit still apply.
  const base = parseView(await searchParams, profile.states);
  const view: View = { ...base, county: null, q: "", open: null, sort: "fit" };
  const list = applyView(items, view, ctx);
  const stats = marketStats(list, place, now, TIME_ZONE);
  const tabs = tabCounts(items, view, profile.states, ctx);
  const opp = (change: Partial<View>) => viewHref("/opportunities", view, change);
  const mapStates =
    view.tab === "all" ? profile.states : view.tab === "federal" ? [] : [view.tab.toUpperCase()];
  const counts = new Map([...stats.byCounty].map(([fips, v]) => [fips, v.count]));
  const coverage = stats.value.of ? Math.round((stats.value.covered / stats.value.of) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Market</h1>
          <p className="text-sm text-muted">
            Where the open bids that fit {profile.name} are, and when they close.
          </p>
        </div>
        <form method="get" action={PATH} className="flex items-center gap-2 text-sm">
          {view.tab !== "all" && <input type="hidden" name="tab" value={view.tab} />}
          <label htmlFor="fit" className="text-muted">
            Fit
          </label>
          <select
            id="fit"
            name="fit"
            defaultValue={view.fit}
            className="rounded-md border border-line bg-card px-2 py-1"
          >
            <option value="all">Strong and possible</option>
            <option value="strong">Strong only</option>
          </select>
          <button className="rounded-md bg-brand px-3 py-1 font-semibold text-white">Apply</button>
        </form>
      </div>

      <Tabs tabs={tabs} active={view.tab} hrefFor={(tab) => viewHref(PATH, view, { tab })} />
      {truncated && (
        <p role="status" className="rounded-md bg-possible-bg px-3 py-2 text-sm text-possible">
          Figures cover the top {API_PAGE_LIMIT.toLocaleString("en-US")} matches by fit only, so they are
          partial.
        </p>
      )}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Open bids that fit" value={stats.open.toLocaleString("en-US")} href={opp({})} />
        <Tile
          label="Strong fits"
          value={stats.strong.toLocaleString("en-US")}
          href={opp({ fit: "strong" })}
        />
        <Tile
          label="Due in the next 14 days"
          value={stats.dueIn14.toLocaleString("en-US")}
          href={opp({ due: 14, sort: "due" })}
        />
        <Tile
          label="Stated value, open bids"
          value={stats.value.covered ? money(stats.value.total) : "—"}
          note={`Stated on ${stats.value.covered} of ${stats.value.of} bids (${coverage}%). Most agencies do not publish a value.`}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title={mapStates.length ? "Where the bids are" : "Federal bids"}>
          {mapStates.length === 0 ? (
            <p className="text-sm text-muted">
              Federal notices are placed by agency, not county. See the top buyers alongside.
            </p>
          ) : (
            <div className={mapStates.length > 1 ? "grid gap-4 sm:grid-cols-2" : ""}>
              {mapStates.map((s) => {
                const map = stateMap(s);
                if (!map) return null;
                return (
                  <div key={s}>
                    {mapStates.length > 1 && (
                      <h3 className="mb-1 text-sm font-semibold">{STATE_NAMES[s] ?? s}</h3>
                    )}
                    <CountyMap
                      map={map}
                      counts={counts}
                      label={`Open bids by county in ${STATE_NAMES[s] ?? s}`}
                      hrefFor={(fips) => opp({ tab: s.toLowerCase(), county: fips })}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {mapStates.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Also open: {stats.statewide} statewide (state agencies)
              {stats.federal > 0 && <>, {stats.federal} federal</>}
              {stats.unplaced.count > 0 && (
                <>
                  {" "}
                  and {stats.unplaced.count} we could not place on a county
                  {stats.unplaced.buyers.length > 0 && (
                    <> (for example {stats.unplaced.buyers.slice(0, 3).join(", ")})</>
                  )}
                </>
              )}
              .
            </p>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="Top buyers">
            {stats.topBuyers.length ? (
              <Bars rows={stats.topBuyers} hrefFor={(name) => opp({ q: name })} />
            ) : (
              <p className="text-sm text-muted">No open bids in this view.</p>
            )}
          </Card>
          {glance && (
            <Card title="From screened to strong">
              <Funnel
                steps={[
                  {
                    label: "Open bids Radar read",
                    count: glance.screened,
                    note: "All regions, not just this tab",
                  },
                  { label: "Worth a look (possible or strong)", count: glance.possible + glance.strong },
                  { label: "Strong fit", count: glance.strong },
                ]}
              />
            </Card>
          )}
        </div>
      </div>

      <Card title="Closing in the next 30 days">
        <ClosingChart days={stats.closing} />
        <p className="mt-1 text-xs text-muted">
          Due dates shown in Eastern time.{" "}
          <Link className="text-brand hover:underline" href={opp({ sort: "due", due: 30 })}>
            See them in order →
          </Link>
        </p>
      </Card>
    </div>
  );
}

function Tile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums text-brand-dark">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </>
  );
  const cls = "block rounded-lg border border-line bg-card p-4";
  return href ? (
    <Link href={href} className={`${cls} hover:border-brand`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-card p-4">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}
