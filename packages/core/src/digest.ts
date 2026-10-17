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

/** Counts across every open, biddable notice Radar read for the profile, not only the ones listed. */
export interface DigestGlance {
  screened: number;
  strong: number;
  possible: number;
  /** Weak or excluded: read and scored, but below the bar. */
  notFit: number;
  bySource: Record<string, number>;
}

export interface Digest {
  profileName: string;
  generatedAt: string;
  glance?: DigestGlance;
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

/** Fit colors shared by the glance panel and the score pills: green strong, amber possible, red below the bar. */
export const FIT_COLORS = {
  strong: { bg: "#1E8E3E", fg: "#FFFFFF", label: "Strong fit" },
  possible: { bg: "#F2B705", fg: "#3A2C00", label: "Possible fit" },
  notFit: { bg: "#D93025", fg: "#FFFFFF", label: "Screened out" },
} as const;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function sourceMix(g: DigestGlance): string {
  return Object.entries(g.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${SOURCE_LABEL[k as Opportunity["source"]] ?? k} ${n.toLocaleString("en-US")}`)
    .join(" · ");
}

function glanceLine(g: DigestGlance): string {
  return `${plural(g.screened, "open solicitation")} read; ${g.strong} strong, ${g.possible} possible, ${g.notFit} screened out.`;
}

/** Plain text suitable for SMS or a chat message. Short lines, no markup. */
export function renderDigestText(d: Digest, maxPerSection = 5): string {
  const lines: string[] = [`RFP Pilot Radar for ${d.profileName}, ${fmtDate(d.generatedAt)}`];
  if (d.glance) lines.push(glanceLine(d.glance));
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
  if (d.glance) out.push(`**At a glance:** ${glanceLine(d.glance)}`, "");
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
  const card = (
    title: string,
    url: string,
    meta: string,
    why: string,
    score?: number,
    band?: Match["band"],
  ) => {
    const c =
      band === "strong" ? FIT_COLORS.strong : band === "possible" ? FIT_COLORS.possible : FIT_COLORS.notFit;
    const edge = score !== undefined ? `border-left:4px solid ${c.bg};` : "";
    return (
      `<div style="${font};border:1px solid #D3E1EC;${edge}border-radius:8px;padding:10px 12px;margin:0 0 8px">` +
      (score !== undefined
        ? `<span title="${esc(c.label)}" style="float:right;background:${c.bg};color:${c.fg};border-radius:10px;padding:1px 8px;font-size:12px;font-weight:700">${score}</span>`
        : "") +
      `<a href="${safeUrl(url)}" style="color:#0E2F6C;font-weight:600;font-size:14px;text-decoration:none">${esc(title)}</a>` +
      `<div style="color:#556175;font-size:12px;margin-top:3px">${esc(meta)}</div>` +
      (why ? `<div style="font-size:12px;margin-top:5px;color:#1B2433">${esc(why)}</div>` : "") +
      `</div>`
    );
  };
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
          m.band,
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
  if (d.glance) parts.push(glanceHtml(d, font));
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
    `<p style="${font};font-size:11px;color:#6B7689;margin-top:18px">Every item links to the public posting. Scores are explained by the reasons shown; nothing is inferred beyond what the posting states. To stop these emails, use the unsubscribe option in your mail app.</p></div>`,
  );
  return parts.join("");
}

/** Email-safe "at a glance" panel: three colored count tiles, a proportion bar, and today's headline items. */
function glanceHtml(d: Digest, font: string): string {
  const g = d.glance!;
  const tile = (n: number, c: { bg: string; fg: string; label: string }) =>
    `<td width="33%" style="padding:0 4px"><div style="${font};background:${c.bg};color:${c.fg};border-radius:8px;padding:10px 6px;text-align:center">` +
    `<div style="font-size:24px;font-weight:800;line-height:1.1">${n.toLocaleString("en-US")}</div>` +
    `<div style="font-size:11px;font-weight:600;letter-spacing:.3px">${esc(c.label)}</div></div></td>`;
  const total = Math.max(1, g.strong + g.possible + g.notFit);
  // Keep a visible sliver for any non-zero band so a single strong match still shows on the bar.
  const pct = (n: number) => (n === 0 ? 0 : Math.max(2, Math.round((n / total) * 100)));
  const seg = (n: number, color: string) =>
    n === 0
      ? ""
      : `<td width="${pct(n)}%" style="background:${color};height:8px;font-size:0;line-height:0">&nbsp;</td>`;
  const top = [...d.newMatches, ...d.closingSoon].sort((a, b) => b.match.score - a.match.score)[0];
  const next = [...d.closingSoon].sort((a, b) =>
    (a.opportunity.dueAt ?? "").localeCompare(b.opportunity.dueAt ?? ""),
  )[0];
  const line = (label: string, e: DigestEntry, tail: string) =>
    `<div style="font-size:12px;margin-top:4px"><span style="color:#556175">${label}</span> ` +
    `<a href="${safeUrl(e.opportunity.provenance.sourceUrl)}" style="color:#0E2F6C;font-weight:600;text-decoration:none">${esc(e.opportunity.title)}</a>` +
    ` <span style="color:#556175">${esc(tail)}</span></div>`;
  return (
    `<div style="${font};border:1px solid #D3E1EC;border-radius:10px;padding:12px;margin-top:12px">` +
    `<div style="font-size:11px;letter-spacing:1.2px;font-weight:700;color:#0E2F6C">AT A GLANCE</div>` +
    `<div style="font-size:13px;margin:4px 0 10px">Radar read <b>${plural(g.screened, "open solicitation")}</b> for you` +
    (Object.keys(g.bySource).length ? ` <span style="color:#556175">(${esc(sourceMix(g))})</span>` : "") +
    `.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>` +
    tile(g.strong, FIT_COLORS.strong) +
    tile(g.possible, FIT_COLORS.possible) +
    tile(g.notFit, FIT_COLORS.notFit) +
    `</tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-radius:4px;overflow:hidden"><tr>` +
    seg(g.strong, FIT_COLORS.strong.bg) +
    seg(g.possible, FIT_COLORS.possible.bg) +
    seg(g.notFit, FIT_COLORS.notFit.bg) +
    `</tr></table>` +
    `<div style="font-size:12px;margin-top:8px;color:#1B2433"><b>${d.newMatches.length}</b> new today · <b>${d.closingSoon.length}</b> closing within 7 days</div>` +
    (top ? line("Top match:", top, `fit ${Math.round(top.match.score)}`) : "") +
    (next ? line("Next deadline:", next, `due ${fmtDate(next.opportunity.dueAt, d.generatedAt)}`) : "") +
    `</div>`
  );
}
