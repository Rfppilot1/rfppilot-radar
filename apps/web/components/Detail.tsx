import Link from "next/link";
import { decide } from "@/app/opportunities/actions";
import type { MatchItem } from "@/lib/radar";
import { FitBadge } from "./FitBadge";
import { dateTime, daysLeft, money, safeHref, shortDate } from "@/lib/format";

const KEY_DATE: Record<string, string> = {
  pre_bid: "Pre-bid meeting",
  site_visit: "Site visit",
  questions_due: "Questions due",
  bid_opening: "Bid opening",
};

export function Detail({
  item,
  now,
  answer,
  closeHref,
  returnTo,
}: {
  item: MatchItem;
  now: string;
  answer: string | null;
  closeHref: string;
  returnTo: string;
}) {
  const o = item.opportunity;
  const left = daysLeft(o.dueAt, now);
  const reasons = [...item.match.reasons].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 6);
  const source = safeHref(o.provenance.sourceUrl);

  return (
    <article className="rounded-lg border border-line bg-card shadow-sm">
      <header className="border-b border-line p-4">
        <div className="flex items-start justify-between gap-3">
          <FitBadge band={item.match.band} score={item.match.score} />
          <Link
            href={closeHref}
            scroll={false}
            className="text-sm text-muted hover:text-ink"
            aria-label="Close details"
          >
            Close ✕
          </Link>
        </div>
        <h2 className="mt-2 text-lg font-bold leading-snug text-brand-dark">{o.title}</h2>
        <p className="mt-1 text-sm text-muted">{o.buyer.name}</p>
        {o.solicitationNumber && (
          <p className="mt-0.5 text-xs text-muted">
            {o.kindLabel && !o.solicitationNumber.toLowerCase().startsWith(o.kindLabel.toLowerCase())
              ? `${o.kindLabel} ${o.solicitationNumber}`
              : o.solicitationNumber}
          </p>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-px bg-line text-sm">
        <div className="bg-card p-3">
          <dt className="text-xs font-semibold text-muted">Due</dt>
          <dd className="mt-0.5 font-semibold">{dateTime(o.dueAt, o.dueTimezone)}</dd>
          {left !== null && <dd className="text-xs text-muted">{left} days left</dd>}
        </div>
        <div className="bg-card p-3">
          <dt className="text-xs font-semibold text-muted">Stated value</dt>
          <dd className="mt-0.5 font-semibold">
            {o.estimatedValue ? money(o.estimatedValue.amount) : "Not stated"}
          </dd>
          {o.estimatedValue && (
            <dd className="text-xs text-muted">
              {o.estimatedValue.basis === "agency_estimate" ? "Agency estimate" : "From the posting text"}
            </dd>
          )}
        </div>
      </dl>

      <div className="space-y-4 p-4">
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Why it fits</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {reasons.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={`w-9 shrink-0 text-right font-semibold tabular-nums ${r.points >= 0 ? "text-strong" : "text-red-700"}`}
                >
                  {r.points > 0 ? "+" : ""}
                  {Math.round(r.points)}
                </span>
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
          {item.match.review?.rationale && (
            <p className="mt-2 rounded-md bg-page p-2.5 text-sm text-muted">{item.match.review.rationale}</p>
          )}
        </section>

        {o.keyDates.length > 0 && (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Key dates</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {o.keyDates.map((k, i) => (
                <li key={i} title={k.note}>
                  <span className="font-semibold">{KEY_DATE[k.kind] ?? k.kind}:</span>{" "}
                  {k.date ? shortDate(`${k.date}T12:00:00Z`, "UTC") : "Date not stated"}
                  {k.time && ` at ${k.time}`}
                  {k.mandatory === true && (
                    <span className="ml-1 font-semibold text-possible">(mandatory)</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {o.documents.length > 0 && (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">
              Documents ({o.documents.length})
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {o.documents.slice(0, 8).map((d, i) => {
                const href = safeHref(d.url);
                const label = d.filename ?? d.description ?? "Document";
                return (
                  <li key={i} className="truncate">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand hover:underline"
                      >
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </li>
                );
              })}
              {o.documents.length > 8 && (
                <li className="text-muted">and {o.documents.length - 8} more on the source page</li>
              )}
            </ul>
          </section>
        )}

        {o.contact && (o.contact.name || o.contact.email) && (
          <section className="text-sm">
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Contact</h3>
            <p className="mt-1">
              {o.contact.name}
              {o.contact.email && (
                <>
                  {o.contact.name && " · "}
                  <a className="text-brand hover:underline" href={`mailto:${o.contact.email}`}>
                    {o.contact.email}
                  </a>
                </>
              )}
            </p>
          </section>
        )}

        {source && (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-semibold text-brand hover:underline"
          >
            Open the posting on the agency site ↗
          </a>
        )}
      </div>

      <footer className="border-t border-line p-4">
        <p className="mb-2 text-sm font-semibold">Worth a look?</p>
        <form action={decide} className="flex gap-2">
          <input type="hidden" name="opportunityId" value={o.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button
            name="answer"
            value="watch"
            className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold ${
              answer === "watch"
                ? "bg-strong text-white"
                : "border border-strong text-strong hover:bg-strong-bg"
            }`}
          >
            {answer === "watch" ? "✓ Yes" : "Yes"}
          </button>
          <button
            name="answer"
            value="pass"
            className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold ${
              answer === "pass" ? "bg-ink text-white" : "border border-line text-ink hover:bg-page"
            }`}
          >
            {answer === "pass" ? "✓ No, passed" : "No, pass"}
          </button>
        </form>
        <p className="mt-2 text-xs text-muted">
          Passed items leave this list and come back in the second-look review if they change.
        </p>
      </footer>
    </article>
  );
}
