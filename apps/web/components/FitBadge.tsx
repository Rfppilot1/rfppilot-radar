export function FitBadge({ band, score }: { band: string; score: number }) {
  const strong = band === "strong";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        strong ? "bg-strong-bg text-strong" : "bg-possible-bg text-possible"
      }`}
    >
      {strong ? "Strong fit" : "Possible fit"}
      <span className="tabular-nums opacity-80">{Math.round(score)}</span>
    </span>
  );
}
