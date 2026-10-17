import type { KeyDate } from "./schema.js";

/**
 * Finds pre-bid conferences, site visits, question deadlines and bid openings in a solicitation's text.
 *
 * Deliberately conservative: an event is reported only when a sentence names it, and its date only when that
 * same sentence states one. A missed date costs a reader a click into the posting; an invented one could cost
 * them a disqualifying no-show, so nothing is inferred across sentences.
 */
const KINDS: [KeyDate["kind"], RegExp][] = [
  [
    "pre_bid",
    /\bpre-?\s?(bid|proposal|solicitation|offer|response|submittal|quote)s?\s+(conference|meeting|call|webinar|session)|\b(bidders?|offerors?|proposers?|vendors?)['’]?\s+(conference|meeting)\b/i,
  ],
  ["site_visit", /\bsite\s+(visit|walk|inspection|tour)s?\b|\bwalk-?\s?through\b/i],
  [
    "questions_due",
    /\b(questions|inquiries|clarifications)\b[^.]{0,60}\b(due|deadline|must be (submitted|received)|no later than|by)\b|\bdeadline for (written )?(questions|inquiries)\b|\blast day (for|to submit) (written )?questions\b/i,
  ],
  ["bid_opening", /\b(public\s+)?(bid|proposal|quote)s?\s+opening\b|\bpublic opening\b/i],
];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i;
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/;
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/i;

export interface KeyDateOptions {
  /** When the text was read; supplies the year for dates written without one. */
  now: string;
}

export function extractKeyDates(text: string | null | undefined, o: KeyDateOptions): KeyDate[] {
  if (!text) return [];
  const sentences = text
    .replace(/\s+/g, " ")
    // Split at sentence ends, but not after "Jan." or "No." inside a date or reference.
    .split(/(?<=[.;!?])(?<!\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|No)\.)\s+(?=[A-Z0-9])|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: KeyDate[] = [];
  for (const sentence of sentences) {
    for (const [kind, re] of KINDS) {
      if (!re.test(sentence)) continue;
      const date = findDate(sentence, o.now);
      // Undated question deadlines and bid openings are boilerplate in most postings; only events a bidder
      // must physically attend are worth flagging without a date.
      if (!date && (kind === "questions_due" || kind === "bid_opening")) continue;
      const time = date ? findTime(sentence) : null;
      const mandatory = /\b(non-?\s?mandatory|not mandatory|optional|voluntary)\b/i.test(sentence)
        ? false
        : /\bmandatory\b|\brequired to attend\b|\battendance is required\b/i.test(sentence)
          ? true
          : null;
      if (out.some((k) => k.kind === kind && k.date === date)) continue;
      out.push({ kind, date, time, mandatory, note: sentence.slice(0, 300) });
    }
  }
  // A dated entry supersedes an undated mention of the same event.
  return out.filter((k) => k.date !== null || !out.some((d) => d.kind === k.kind && d.date !== null));
}

function findDate(s: string, now: string): string | null {
  const ref = new Date(now);
  const m = MONTH_DATE.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? ymd(m[3] ? Number(m[3]) : inferYear(month, Number(m[2]), ref), month, Number(m[2])) : null;
  }
  const n = NUMERIC_DATE.exec(s);
  if (n) {
    const y = n[3]!.length === 2 ? 2000 + Number(n[3]) : Number(n[3]);
    return ymd(y, Number(n[1]), Number(n[2]));
  }
  return null;
}

/** A date written without a year is the next occurrence, allowing for events up to 60 days past. */
function inferYear(month: number, day: number, ref: Date): number {
  const y = ref.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day);
  return candidate < ref.getTime() - 60 * 86_400_000 ? y + 1 : y;
}

function ymd(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findTime(s: string): string | null {
  const t = TIME.exec(s);
  if (!t) return null;
  const h = Number(t[1]);
  if (h < 1 || h > 12) return null;
  return `${h}:${t[2] ?? "00"} ${t[3]!.toUpperCase()}M`;
}

const KIND_LABEL: Record<KeyDate["kind"], string> = {
  pre_bid: "Pre-bid conference",
  site_visit: "Site visit",
  questions_due: "Questions due",
  bid_opening: "Bid opening",
};

/** "Mandatory pre-bid conference Oct 27, 10:00 AM" / "Questions due Oct 20" / "Site visit (date in posting)". */
export function keyDateLabel(k: KeyDate): string {
  const name = KIND_LABEL[k.kind];
  const lead = k.mandatory === true ? `Mandatory ${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
  if (!k.date) return `${lead} (date in posting)`;
  const [y, m, d] = k.date.split("-").map(Number);
  const when = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${lead} ${when}${k.time ? `, ${k.time}` : ""}`;
}

/** Key dates still ahead (or undated), soonest first, skipping a bid opening on the response due date. */
export function upcomingKeyDates(keyDates: KeyDate[], now: string, dueAt: string | null): KeyDate[] {
  const today = now.slice(0, 10);
  const dueDay = dueAt?.slice(0, 10) ?? null;
  return keyDates
    .filter((k) => k.date === null || k.date >= today)
    .filter(
      (k) =>
        !(
          k.kind === "bid_opening" &&
          k.date !== null &&
          dueDay !== null &&
          Math.abs(Date.parse(k.date) - Date.parse(dueDay)) <= 86_400_000
        ),
    )
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
}
