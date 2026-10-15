import { createHash } from "node:crypto";

/** SHA-256 of a value's canonical JSON (object keys sorted), for change detection. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Converts a wall-clock date and time in an IANA timezone to a UTC ISO string, without external
 * dependencies. Accepts "M/D/YYYY" and optional "h:mm AM/PM". Returns null when the date is unparseable.
 */
export function zonedToUtcIso(
  date: string,
  time: string | null | undefined,
  timeZone: string,
): string | null {
  const dm = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(date ?? "");
  if (!dm) return null;
  let hour = 23;
  let minute = 59;
  if (time && time.trim()) {
    const tm = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(time);
    if (!tm) return null;
    hour = Number(tm[1]);
    minute = Number(tm[2]);
    const ampm = tm[3]?.toUpperCase();
    if (minute > 59) return null;
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
    } else if (hour > 23) {
      return null;
    }
  }
  const [y, mo, d] = [Number(dm[3]), Number(dm[1]), Number(dm[2])];
  // Reject impossible calendar dates (2/30, 13/1) instead of letting Date roll them over.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const asUtc = Date.UTC(y, mo - 1, d, hour, minute);
  // Offset of the zone at that instant; one correction pass handles DST boundaries.
  const offset1 = tzOffsetMs(asUtc, timeZone);
  let utc = asUtc - offset1;
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset1) utc = asUtc - offset2;
  return new Date(utc).toISOString();
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - utcMs;
}

/** Normalizes any parseable timestamp to ISO 8601 UTC, or null. */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function clean(value: string | null | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}
