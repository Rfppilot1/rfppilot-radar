import type { SecondLookItem } from "./review.js";
import type { Match, Opportunity } from "./schema.js";

export interface DigestEntry {
  opportunity: Opportunity;
  match: Match;
}

export interface Digest {
  profileName: string;
  generatedAt: string;
  newMatches: DigestEntry[];
  closingSoon: DigestEntry[];
  intel: DigestEntry[];
  secondLook: SecondLookItem[];
}

const fmtDate = (iso: string | null, ref?: string) => {
  if (!iso) return "no due date";
  const d = new Date(iso);
  const sameYear = ref ? new Date(ref).getUTCFullYear() === d.getUTCFullYear() : true;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "America/New_York",
  });
};

const KIND_LABEL: Record<Opportunity["kind"], string> = {
  rfp: "RFP",
  rfq: "RFQ",
  rfi: "RFI",
  itb: "ITB",
  itn: "ITN",
  soq: "Statement of Qualifications",
  presolicitation: "Pre-solicitation",
  sources_sought: "Sources sought",
  grant: "Grant",
  award_decision: "Award decision",
  informational: "Notice",
  single_source: "Single source",
  other: "Solicitation",
};
const kindText = (o: Opportunity) => o.kindLabel ?? KIND_LABEL[o.kind];

const SOURCE_LABEL: Record<Opportunity["source"], string> = {
  "sam-gov": "Federal",
  "tx-esbd": "Texas",
  "fl-mfmp": "Florida",
  openfema: "FEMA",
};

/** Plain text suitable for SMS or a chat message. Short lines, no markup. */
export function renderDigestText(d: Digest, maxPerSection = 5): string {
  const lines: string[] = [`RFP Pilot Radar for ${d.profileName}, ${fmtDate(d.generatedAt)}`];
  const section = (title: string, rows: DigestEntry[]) => {
    if (rows.length === 0) return;
    lines.push("", `${title} (${rows.length})`);
    for (const { opportunity: o, match: m } of rows.slice(0, maxPerSection)) {
      lines.push(
        `- ${o.title} | ${o.buyer.name} | due ${fmtDate(o.dueAt, d.generatedAt)} | fit ${Math.round(m.score)}`,
      );
    }
    if (rows.length > maxPerSection) lines.push(`  +${rows.length - maxPerSection} more in Radar`);
  };
  section("New matches", d.newMatches);
  section("Closing within 7 days", d.closingSoon);
  if (d.secondLook.length > 0) {
    lines.push("", `Second look (${d.secondLook.length})`);
    for (const s of d.secondLook.slice(0, maxPerSection)) lines.push(`- ${s.opportunity.title}: ${s.note}`);
  }
  section("Market intel (awards, pre-solicitations)", d.intel);
  if (lines.length === 1) lines.push("", "Nothing new that fits today.");
  return lines.join("\n");
}

/** Markdown for email or a chat client. Each entry links to the public source page and shows why it matched. */
export function renderDigestMarkdown(d: Digest): string {
  const out: string[] = [`# Radar: ${d.profileName}`, `_${fmtDate(d.generatedAt)}_`, ""];
  const entry = ({ opportunity: o, match: m }: DigestEntry) => {
    const why = m.reasons
      .filter((r) => r.points > 0)
      .map((r) => r.detail)
      .join("; ");
    return [
      `**[${o.title}](${o.provenance.sourceUrl})**`,
      `${SOURCE_LABEL[o.source]} · ${o.buyer.name} · ${kindText(o)} · due ${fmtDate(o.dueAt, d.generatedAt)} · fit **${Math.round(m.score)}** (${m.band})`,
      why ? `Why: ${why}` : "",
      "",
    ].filter(Boolean);
  };
  const section = (title: string, rows: DigestEntry[]) => {
    if (rows.length === 0) return;
    out.push(`## ${title} (${rows.length})`, "");
    for (const r of rows) out.push(...entry(r), "");
  };
  section("New matches", d.newMatches);
  section("Closing within 7 days", d.closingSoon);
  if (d.secondLook.length > 0) {
    out.push(`## Second look (${d.secondLook.length})`, "");
    for (const s of d.secondLook)
      out.push(`**[${s.opportunity.title}](${s.opportunity.provenance.sourceUrl})**`, s.note, "");
  }
  section("Market intel", d.intel);
  return out.join("\n");
}
