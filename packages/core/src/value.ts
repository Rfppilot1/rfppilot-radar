import type { Opportunity } from "./schema.js";

type Value = NonNullable<Opportunity["estimatedValue"]>;

/** Parses a structured money field such as "59,500.00" or "$1,200,000". Zero or unparseable gives null. */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Smallest amount treated as a real contract value. Agencies fill required value fields with placeholders
 * ($0.01, $1, $100), which would otherwise show as "$0" or "$1" contracts and skew market totals. The same floor
 * applies to values read from posting text.
 */
export const MIN_CONTRACT_VALUE = 1000;

/** An agency's stated estimate, or null when it is missing, zero or a placeholder under MIN_CONTRACT_VALUE. */
export function parseEstimate(raw: string | number | null | undefined): number | null {
  const n = parseMoney(raw);
  return n !== null && n >= MIN_CONTRACT_VALUE ? n : null;
}

const VALUE_CUE =
  /\b(estimated|anticipated|approximate(ly)?|total|maximum|not[- ]to[- ]exceed|budget(ed)?|funding|available funds|contract value|award amount)\b/i;
// Dollar amounts in these sentences are about something else (bonds, insurance, fees, penalties).
const NOT_VALUE =
  /\b(bond|insurance|liabilit|coverage|penalt|liquidated|fee|deposit|per hour|hourly|per day|per diem|surety|indemnif)/i;
const AMOUNT = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(million|billion|m\b|mm\b|k\b)?/i;

/**
 * Reads a contract value from a posting's text, conservatively: the sentence must name a value ("estimated",
 * "not to exceed", "budget"...) and must not be about bonds, insurance or fees. The sentence is kept so a
 * reader can check it. Returns null rather than guess.
 */
export function valueFromText(text: string | null | undefined): Value | null {
  if (!text) return null;
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.;!?])\s+(?=[A-Z0-9$])/);
  for (const s of sentences) {
    if (!VALUE_CUE.test(s) || NOT_VALUE.test(s)) continue;
    const m = AMOUNT.exec(s);
    if (!m) continue;
    let amount = Number(m[1]!.replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "million" || unit === "m" || unit === "mm") amount *= 1_000_000;
    else if (unit === "billion") amount *= 1_000_000_000;
    else if (unit === "k") amount *= 1_000;
    if (!Number.isFinite(amount) || amount < MIN_CONTRACT_VALUE) continue;
    return { amount, basis: "posting_text", text: s.trim().slice(0, 240) };
  }
  return null;
}

/** "$59.5K", "$2.5M", "$1.2B"; "≈" marks a value read from the posting's text rather than a stated field. */
export function formatValue(v: Value): string {
  const a = v.amount;
  const s =
    a >= 1e9
      ? `$${trim(a / 1e9)}B`
      : a >= 1e6
        ? `$${trim(a / 1e6)}M`
        : a >= 1e3
          ? `$${trim(a / 1e3)}K`
          : `$${Math.round(a)}`;
  return v.basis === "posting_text" ? `≈${s}` : s;
}

const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""));
