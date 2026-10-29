import Link from "next/link";
import { Tabs } from "@/components/Tabs";
import { FitBadge } from "@/components/FitBadge";
import { Detail } from "@/components/Detail";
import {
  applyView,
  NOTICE_TYPES,
  parseView,
  STATE_NAMES,
  tabCounts,
  viewHref,
  type View,
} from "@/lib/filters";
import { daysLeft, KIND_LABEL, money, shortDate } from "@/lib/format";
import { loadRadar } from "@/lib/load";
import { API_PAGE_LIMIT } from "@/lib/radar";

export const dynamic = "force-dynamic";
const PATH = "/opportunities";

export default async function Opportunities({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const data = await loadRadar();
  const { profile, items, truncated, ctx, now, decisionOf, place } = data;
  const params = await searchParams;
  const view = parseView(params, profile.states);
  const list = applyView(items, view, ctx);
  const tabs = tabCounts(items, view, profile.states, ctx);
  const open = view.open ? items.find((i) => i.opportunity.id === view.open) : undefined;
  const countyName = view.county
    ? [...data.counties.values()].flat().find((c) => c.fips === view.county)?.name
    : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-brand-dark">Opportunities</h1>
          <p className="text-sm text-muted">
            Open bids scored for {profile.name}, best fit first. Updated daily.
          </p>
        </div>
        <Link
          href={viewHref("/market", { ...view, open: null })}
          className="text-sm font-semibold text-brand hover:underline"
        >
          See the market view →
        </Link>
      </div>

      <Tabs
        tabs={tabs}
        active={view.tab}
        hrefFor={(tab) => viewHref(PATH, view, { tab, county: null, open: null })}
      />
      <Filters view={view} />

      {view.county && (
        <p className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-brand/10 px-3 py-1 font-medium text-brand-dark">
            {countyName ?? "Selected"} County
          </span>
          <Link
            className="text-brand hover:underline"
            href={viewHref(PATH, view, { county: null, open: null })}
          >
            Clear county
          </Link>
        </p>
      )}
      {params.error === "decision" && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          Your answer was not saved. The bid may have closed or Radar was briefly unavailable. Please try
          again.
        </p>
      )}
      {truncated && (
        <p role="status" className="rounded-md bg-possible-bg px-3 py-2 text-sm text-possible">
          Showing the top {API_PAGE_LIMIT.toLocaleString("en-US")} matches by fit. Counts are partial and
          lower-scored bids may be missing.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section aria-label="Results" className={open ? "order-2 lg:order-1" : ""}>
          <p className="mb-2 text-sm text-muted">
            {list.length} {list.length === 1 ? "opportunity" : "opportunities"}
          </p>
          {list.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-card p-8 text-center text-sm text-muted">
              Nothing matches these filters.{" "}
              <Link className="font-semibold text-brand hover:underline" href={PATH}>
                Clear all filters
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
              {list.map((item) => {
                const o = item.opportunity;
                const left = daysLeft(o.dueAt, now);
                const selected = o.id === view.open;
                const answer = decisionOf.get(o.id);
                const p = place(item);
                const where =
                  o.buyer.level === "federal"
                    ? "Federal"
                    : p.kind === "county"
                      ? o.buyer.name.toLowerCase().includes(`${p.county.name} county`.toLowerCase())
                        ? (o.state ?? "")
                        : `${p.county.name} County, ${o.state}`
                      : p.kind === "statewide"
                        ? `${STATE_NAMES[o.state ?? ""] ?? o.state} statewide`
                        : (o.state ?? "");
                return (
                  <li key={o.id}>
                    <Link
                      href={viewHref(PATH, view, { open: o.id })}
                      scroll={false}
                      aria-current={selected ? "true" : undefined}
                      className={`block px-4 py-3 hover:bg-page ${selected ? "bg-brand/5 shadow-[inset_3px_0_0] shadow-brand" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-semibold leading-snug text-ink">{o.title}</p>
                        <FitBadge band={item.match.band} score={item.match.score} />
                      </div>
                      <p className="mt-1 text-sm text-muted">
                        {o.buyer.name}
                        {where && <span> · {where}</span>}
                      </p>
                      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                        <span className={left !== null && left <= 7 ? "font-semibold text-possible" : ""}>
                          Due {shortDate(o.dueAt)}
                          {left !== null && ` (${left} ${left === 1 ? "day" : "days"})`}
                        </span>
                        <span>{KIND_LABEL[o.kind] ?? o.kind}</span>
                        {o.estimatedValue && <span>{money(o.estimatedValue.amount)}</span>}
                        {o.hasAddendum && <span>Addendum posted</span>}
                        {answer === "watch" && (
                          <span className="font-semibold text-strong">You said yes</span>
                        )}
                        {answer === "pass" && <span className="font-semibold">You passed</span>}
                        {answer === "pursue" && <span className="font-semibold text-strong">Pursuing</span>}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {open && (
          <aside aria-label="Selected opportunity" className="order-1 lg:order-2">
            <div className="lg:sticky lg:top-4">
              <Detail
                item={open}
                now={now}
                answer={decisionOf.get(open.opportunity.id) ?? null}
                closeHref={viewHref(PATH, view, { open: null })}
                returnTo={viewHref(PATH, view)}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Filters({ view }: { view: View }) {
  const select = "rounded-md border border-line bg-card px-2.5 py-1.5 text-sm";
  return (
    <form
      method="get"
      action={PATH}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-card p-3"
    >
      {view.tab !== "all" && <input type="hidden" name="tab" value={view.tab} />}
      {view.county && <input type="hidden" name="county" value={view.county} />}
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-semibold text-muted">
        Search
        <input
          name="q"
          defaultValue={view.q}
          placeholder="Agency, title or number"
          className={`${select} font-normal text-ink`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
        Fit
        <select name="fit" defaultValue={view.fit} className={select}>
          <option value="all">Strong and possible</option>
          <option value="strong">Strong only</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
        Buyer
        <select name="level" defaultValue={view.level} className={select}>
          <option value="all">All buyers</option>
          <option value="state">State agencies</option>
          <option value="local">Local (cities, counties, schools)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
        Type
        <select name="type" defaultValue={view.type} className={select}>
          <option value="all">All types</option>
          {NOTICE_TYPES.map((t) => (
            <option key={t} value={t}>
              {KIND_LABEL[t]}
            </option>
          ))}
          <option value="other">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
        Due
        <select name="due" defaultValue={view.due ?? ""} className={select}>
          <option value="">Any time</option>
          <option value="7">Next 7 days</option>
          <option value="14">Next 14 days</option>
          <option value="30">Next 30 days</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
        Sort
        <select name="sort" defaultValue={view.sort} className={select}>
          <option value="fit">Best fit</option>
          <option value="due">Due soonest</option>
          <option value="new">Newest</option>
        </select>
      </label>
      <div className="flex flex-col gap-1.5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="fresh" value="1" defaultChecked={view.fresh} />
          New since my last visit
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="passed" value="show" defaultChecked={!view.hidePassed} />
          Show ones I passed on
        </label>
      </div>
      <div className="flex gap-2">
        <button className="rounded-md bg-brand px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-dark">
          Apply
        </button>
        <Link href={PATH} className="rounded-md px-3 py-1.5 text-sm font-semibold text-muted hover:text-ink">
          Reset
        </Link>
      </div>
    </form>
  );
}
