import Link from "next/link";

export function Tabs({
  tabs,
  active,
  hrefFor,
}: {
  tabs: { tab: string; label: string; count: number }[];
  active: string;
  hrefFor: (tab: string) => string;
}) {
  return (
    <nav aria-label="Region" className="flex flex-wrap gap-1 border-b border-line">
      {tabs.map((t) => {
        const on = t.tab === active;
        return (
          <Link
            key={t.tab}
            href={hrefFor(t.tab)}
            aria-current={on ? "page" : undefined}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${
              on ? "border-brand text-brand-dark" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${on ? "bg-brand text-white" : "bg-line/70 text-ink"}`}
            >
              {t.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
