import type { SecondLookItem } from "./review.js";
import type { Match, Opportunity } from "./schema.js";

export interface DigestEntry {
  opportunity: Opportunity;
  match: Match;
}

/** A demand signal shown alongside opportunities, such as a new FEMA disaster declaration. */
export interface DigestSignal {
  title: string;
  detail: string;
  date: string;
  sourceUrl: string;
}

export interface Digest {
  profileName: string;
  generatedAt: string;
  newMatches: DigestEntry[];
  closingSoon: DigestEntry[];
  intel: DigestEntry[];
  secondLook: SecondLookItem[];
  signals?: DigestSignal[];
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
  if (d.signals?.length) {
    lines.push("", `Demand signals (${d.signals.length})`);
    for (const g of d.signals.slice(0, maxPerSection)) lines.push(`- ${g.title}: ${g.detail}`);
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
  if (d.signals?.length) {
    out.push(`## Demand signals (${d.signals.length})`, "");
    for (const g of d.signals) out.push(`**[${g.title}](${g.sourceUrl})**`, g.detail, "");
  }
  section("Market intel", d.intel);
  return out.join("\n");
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (u: string) => (/^https:\/\//.test(u) ? esc(u) : "#");

/** Email-safe HTML (inline styles, no external assets). All source text is escaped. */
export function renderDigestHtml(d: Digest): string {
  const font = "font-family:Inter,Segoe UI,Arial,sans-serif";
  const h2 = (t: string) =>
    `<h2 style="${font};font-size:15px;color:#0E2F6C;margin:22px 0 8px;border-bottom:2px solid #1795C3;padding-bottom:4px">${esc(t)}</h2>`;
  const card = (title: string, url: string, meta: string, why: string, score?: number) =>
    `<div style="${font};border:1px solid #D3E1EC;border-radius:8px;padding:10px 12px;margin:0 0 8px">` +
    (score !== undefined
      ? `<span style="float:right;background:#1A75C8;color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:700">${score}</span>`
      : "") +
    `<a href="${safeUrl(url)}" style="color:#0E2F6C;font-weight:600;font-size:14px;text-decoration:none">${esc(title)}</a>` +
    `<div style="color:#556175;font-size:12px;margin-top:3px">${esc(meta)}</div>` +
    (why ? `<div style="font-size:12px;margin-top:5px;color:#1B2433">${esc(why)}</div>` : "") +
    `</div>`;
  const entries = (rows: DigestEntry[]) =>
    rows
      .map(({ opportunity: o, match: m }) =>
        card(
          o.title,
          o.provenance.sourceUrl,
          `${SOURCE_LABEL[o.source]} · ${o.buyer.name} · ${kindText(o)} · due ${fmtDate(o.dueAt, d.generatedAt)}`,
          m.reasons
            .filter((r) => r.points > 0)
            .map((r) => r.detail)
            .join("; "),
          Math.round(m.score),
        ),
      )
      .join("");
  const parts: string[] = [
    `<div style="${font};max-width:640px;margin:0 auto;color:#1B2433">`,
    `<div style="background:linear-gradient(135deg,#1795C3,#1A75C8 55%,#0E2F6C);color:#fff;border-radius:10px;padding:14px 16px">` +
      `<div style="font-size:11px;letter-spacing:1.5px;color:#7FE3F5;font-weight:700">RFP PILOT RADAR</div>` +
      `<div style="font-size:18px;font-weight:700;margin-top:2px">${esc(d.profileName)}</div>` +
      `<div style="font-size:12px;color:#D3E6F6">${esc(fmtDate(d.generatedAt))}</div></div>`,
  ];
  if (d.newMatches.length) parts.push(h2(`New matches (${d.newMatches.length})`), entries(d.newMatches));
  if (d.closingSoon.length)
    parts.push(h2(`Closing within 7 days (${d.closingSoon.length})`), entries(d.closingSoon));
  if (d.secondLook.length)
    parts.push(
      h2(`Second look (${d.secondLook.length})`),
      d.secondLook
        .map((s) => card(s.opportunity.title, s.opportunity.provenance.sourceUrl, s.note, ""))
        .join(""),
    );
  if (d.signals?.length)
    parts.push(
      h2(`Demand signals (${d.signals.length})`),
      d.signals.map((g) => card(g.title, g.sourceUrl, g.detail, "")).join(""),
    );
  if (d.intel.length) parts.push(h2(`Market intel (${d.intel.length})`), entries(d.intel));
  if (!d.newMatches.length && !d.closingSoon.length && !d.secondLook.length)
    parts.push(`<p style="${font};color:#556175">Nothing new that fits today.</p>`);
  parts.push(
    `<p style="${font};font-size:11px;color:#6B7689;margin-top:18px">Every item links to the public posting. Scores are explained by the reasons shown; nothing is inferred beyond what the posting states.</p></div>`,
  );
  return parts.join("");
}
