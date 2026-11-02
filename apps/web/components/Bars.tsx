import Link from "next/link";

/** Ranked horizontal bars with the value in text ink beside each bar. */
export function Bars({
  rows,
  hrefFor,
}: {
  rows: { name: string; count: number }[];
  hrefFor?: (name: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ol className="space-y-2">
      {rows.map((r) => {
        const body = (
          <>
            <span className="flex justify-between gap-3 text-sm">
              <span className="truncate">{r.name}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </span>
            <span className="mt-1 block h-1.5 rounded-full bg-page">
              <span
                className="block h-1.5 rounded-full bg-brand"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </span>
          </>
        );
        return (
          <li key={r.name}>
            {hrefFor ? (
              <Link href={hrefFor(r.name)} className="block rounded hover:bg-page">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
