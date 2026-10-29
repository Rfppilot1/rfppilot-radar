/** Screened → worth a look → strong. Widths are proportional to the first step; counts in text beside them. */
export function Funnel({ steps }: { steps: { label: string; count: number; note?: string }[] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={s.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.count.toLocaleString("en-US")}</span>
          </div>
          <div className="mt-1 h-3 rounded bg-page">
            <div
              className="h-3 rounded"
              style={{
                width: `${Math.max(1.5, (s.count / top) * 100)}%`,
                background:
                  ["var(--color-shade-2)", "var(--color-shade-3)", "var(--color-shade-4)"][i] ??
                  "var(--color-brand)",
              }}
            />
          </div>
          {s.note && <p className="mt-0.5 text-xs text-muted">{s.note}</p>}
        </li>
      ))}
    </ol>
  );
}
