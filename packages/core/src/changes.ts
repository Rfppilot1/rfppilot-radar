import { keyDateLabel } from "./keydates.js";
import type { KeyDate, Opportunity } from "./schema.js";

/** One material change to a solicitation between two versions, described in the reader's terms. */
export type OpportunityChange =
  | { kind: "due_moved"; from: string; to: string }
  | { kind: "cancelled" }
  | { kind: "withdrawn" }
  | { kind: "reopened" }
  | { kind: "addendum"; documents: string[] }
  | { kind: "documents_added"; documents: string[] }
  | { kind: "key_date"; keyDate: KeyDate; previous: KeyDate | null };

/** A record is "enriched" once it carries detail-level data (description or documents). */
const enriched = (o: Opportunity) => o.description !== null || o.documents.length > 0;

/**
 * Compares the version a reader last saw with the current one. Only changes a bidder acts on are reported:
 * a moved deadline, a cancellation, an addendum or new documents, and new or moved key dates. Fields that
 * only became available because Radar started reading more detail are never reported as changes.
 */
export function diffOpportunity(prev: Opportunity, cur: Opportunity, now?: string): OpportunityChange[] {
  const out: OpportunityChange[] = [];
  if (prev.dueAt && cur.dueAt && prev.dueAt !== cur.dueAt) {
    out.push({ kind: "due_moved", from: prev.dueAt, to: cur.dueAt });
  }
  const wasActive = prev.status === "open" || prev.status === "preview";
  if (cur.status === "cancelled" && prev.status !== "cancelled") out.push({ kind: "cancelled" });
  // Dropped from the source's open list before its deadline: withdrawn, cancelled or awarded early.
  if (cur.status === "closed" && wasActive && (!cur.dueAt || !now || cur.dueAt > now))
    out.push({ kind: "withdrawn" });
  if (
    (cur.status === "open" || cur.status === "preview") &&
    (prev.status === "cancelled" || prev.status === "closed")
  ) {
    out.push({ kind: "reopened" });
  }

  const comparable = enriched(prev) && enriched(cur);
  const before = new Set(prev.documents.map((d) => d.filename ?? d.url));
  const added = comparable
    ? cur.documents
        .filter((d) => !before.has(d.filename ?? d.url))
        .map((d) => d.filename ?? "untitled document")
    : [];
  const addendumNow =
    (cur.hasAddendum && !prev.hasAddendum) ||
    (cur.version ?? 0) > (prev.version ?? 0) ||
    added.some((n) => /addend|amend/i.test(n));
  if (addendumNow) out.push({ kind: "addendum", documents: added });
  else if (added.length > 0) out.push({ kind: "documents_added", documents: added });

  // A key date is news only when the posting's text actually changed (a parser upgrade re-reading the same
  // text is not an agency action) and the date has not already passed.
  const textChanged = (prev.description ?? "") !== (cur.description ?? "");
  const today = now ? now.slice(0, 10) : null;
  const upcoming = (k: KeyDate) => k.date === null || today === null || k.date >= today;
  if (comparable && textChanged) {
    for (const k of cur.keyDates.filter(upcoming)) {
      const same = prev.keyDates.find((p) => p.kind === k.kind);
      if (!same) out.push({ kind: "key_date", keyDate: k, previous: null });
      else if (same.date !== k.date || same.time !== k.time || same.mandatory !== k.mandatory)
        out.push({ kind: "key_date", keyDate: k, previous: same });
    }
  }
  return out;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/** One short line per change, e.g. "Deadline extended: Oct 23 → Oct 30". */
export function changeLine(c: OpportunityChange): string {
  switch (c.kind) {
    case "due_moved": {
      const verb = c.to > c.from ? "extended" : "moved earlier";
      return day(c.from) === day(c.to)
        ? `Due time changed on ${day(c.to)}`
        : `Deadline ${verb}: ${day(c.from)} → ${day(c.to)}`;
    }
    case "cancelled":
      return "Cancelled by the agency";
    case "withdrawn":
      return "No longer posted by the agency (pulled before its deadline)";
    case "reopened":
      return "Reopened by the agency";
    case "addendum":
      return c.documents.length
        ? `Addendum posted: ${c.documents.slice(0, 3).join("; ")}`
        : "Addendum posted";
    case "documents_added":
      return `New documents: ${c.documents.slice(0, 3).join("; ")}`;
    case "key_date":
      return c.previous ? `Changed: ${keyDateLabel(c.keyDate)}` : `Added: ${keyDateLabel(c.keyDate)}`;
  }
}
