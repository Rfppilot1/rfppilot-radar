/** Display helpers. Dates show in the viewer's business time zone (Eastern for the pilot). */
/** A time zone the runtime knows, or null. Source data and settings can carry names like "Eastern". */
export function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export const TIME_ZONE = validZone(process.env.RADAR_TIME_ZONE) ?? "America/New_York";

export function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function shortDate(iso: string | null, timeZone = TIME_ZONE): string {
  if (!iso) return "No due date";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

export function dateTime(iso: string | null, tz: string | null, timeZone = TIME_ZONE): string {
  if (!iso) return "Not stated";
  const s = new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: validZone(tz) ?? timeZone,
    timeZoneName: "short",
  });
  return s;
}

export function daysLeft(iso: string | null, now: string): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.parse(now)) / 86_400_000);
}

export const KIND_LABEL: Record<string, string> = {
  rfp: "RFP",
  rfq: "RFQ",
  itb: "ITB",
  itn: "ITN",
  soq: "SOQ",
  rfi: "RFI",
  other: "Other",
};

/** Only http(s) links are rendered as links. */
export const safeHref = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
