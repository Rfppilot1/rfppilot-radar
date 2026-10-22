import { displayAgency } from "./names.js";
import type { SecondLookItem } from "./review.js";
import type { Match, Opportunity, Reason } from "./schema.js";
import { BANDS } from "./scoring.js";
import { changeLine, type OpportunityChange } from "./changes.js";
import { keyDateLabel, upcomingKeyDates } from "./keydates.js";
import { formatValue } from "./value.js";
import type { FeedbackVote } from "./feedback.js";

/** Rendering options. `feedback` returns the yes/no link for an opportunity; when absent, no links are shown. */
export interface RenderOptions {
  feedback?: (opportunityId: string, vote?: FeedbackVote) => string;
}

export interface DigestEntry {
  opportunity: Opportunity;
  match: Match;
}

/** A tracked solicitation that changed since the reader's last digest (deadline, addendum, cancellation…). */
export interface DigestChange extends DigestEntry {
  changes: OpportunityChange[];
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
  /** "Today in brief": two or three AI-written sentences drawn only from this digest's own facts. */
  summary?: string | null;
  /** The profile's band cutoffs, so each card can say how far it sits from Strong. Defaults apply if omitted. */
  bands?: { strong: number; possible: number };
  /** Solicitations already shown before that changed since the last digest. */
  changed?: DigestChange[];
  newMatches: DigestEntry[];
  closingSoon: DigestEntry[];
  /** Strong matches seen before that are still open and not closing within the week, best fit first. */
  strongOpen?: DigestEntry[];
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

/** Source · buyer · notice type · due date · estimated value (when the posting states one). */
const metaLine = (o: Opportunity, ref: string) =>
  `${SOURCE_LABEL[o.source]} · ${displayAgency(o.buyer.name)} · ${kindText(o)} · due ${fmtDate(o.dueAt, ref)}` +
  (o.estimatedValue ? ` · Est. ${formatValue(o.estimatedValue)}` : "");

const SOURCE_LABEL: Record<Opportunity["source"], string> = {
  "sam-gov": "Federal",
  "tx-esbd": "Texas",
  "fl-mfmp": "Florida",
  openfema: "FEMA",
};

/** Fit colors shared by the glance panel and the score pills: green strong, amber possible, red below the bar. */
export const FIT_COLORS = {
  strong: { bg: "#1E8E3E", fg: "#FFFFFF", label: "Strong fit", short: "Strong", tint: "#E6F4EA" },
  possible: { bg: "#F2B705", fg: "#3A2C00", label: "Possible fit", short: "Possible", tint: "#FEF7E0" },
  notFit: { bg: "#D93025", fg: "#FFFFFF", label: "Screened out", short: "Low", tint: "#FCE8E6" },
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

/** A strong match shown in the top section, with why it is flagged ("New today", "Closes within 7 days"). */
export interface StrongEntry extends DigestEntry {
  tags: string[];
}

/**
 * Every open strong match in the digest, best fit first: new today, closing this week, or carried over from
 * earlier emails. This is the first section after "At a glance", so the strongest opportunities always lead.
 * Items listed here are left out of the New and Closing sections below so nothing appears twice.
 */
export function strongestOpen(d: Digest, limit = 10): StrongEntry[] {
  const newIds = new Set(d.newMatches.map((e) => e.opportunity.id));
  const closingIds = new Set(d.closingSoon.map((e) => e.opportunity.id));
  const seen = new Map<string, DigestEntry>();
  for (const e of [...d.newMatches, ...d.closingSoon, ...(d.strongOpen ?? [])])
    if (e.match.band === "strong" && !seen.has(e.opportunity.id)) seen.set(e.opportunity.id, e);
  return [...seen.values()]
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, limit)
    .map((e) => ({
      ...e,
      tags: [
        ...(newIds.has(e.opportunity.id) ? ["New today"] : []),
        ...(closingIds.has(e.opportunity.id) ? ["Closes within 7 days"] : []),
      ],
    }));
}

/** The digest's sections after the strong list is pulled to the top: same entries, minus those shown there. */
function remaining(d: Digest, strong: StrongEntry[]) {
  const ids = new Set(strong.map((e) => e.opportunity.id));
  const keep = (rows: DigestEntry[]) => rows.filter((e) => !ids.has(e.opportunity.id));
  return { newMatches: keep(d.newMatches), closingSoon: keep(d.closingSoon) };
}

/** Plain text suitable for SMS or a chat message. Short lines, no markup. */
export function renderDigestText(d: Digest, maxPerSection = 5, opts: RenderOptions = {}): string {
  const lines: string[] = [`RFP Pilot Radar for ${d.profileName}, ${fmtDate(d.generatedAt)}`];
  if (d.summary) lines.push(d.summary);
  if (d.glance) lines.push(glanceLine(d.glance));
  const strong = strongestOpen(d);
  const rest = remaining(d, strong);
  const section = (title: string, rows: (DigestEntry & { tags?: string[] })[]) => {
    if (rows.length === 0) return;
    lines.push("", `${title} (${rows.length})`);
    for (const { opportunity: o, match: m, tags } of rows.slice(0, maxPerSection)) {
      lines.push(
        `- ${o.title} | ${displayAgency(o.buyer.name)} | due ${fmtDate(o.dueAt, d.generatedAt)}${o.estimatedValue ? ` | est. ${formatValue(o.estimatedValue)}` : ""} | fit ${Math.round(m.score)}${tags?.length ? ` | ${tags.join(", ")}` : ""}`,
      );
      const kd = upcomingKeyDates(o.keyDates ?? [], d.generatedAt, o.dueAt);
      if (kd.length) lines.push(`  ${kd.map(keyDateLabel).join(" · ")}`);
      if (opts.feedback) lines.push(`  Good fit? Yes/No: ${opts.feedback(o.id)}`);
    }
    if (rows.length > maxPerSection) lines.push(`  +${rows.length - maxPerSection} more in Radar`);
  };
  section("Strong matches still open", strong);
  if (d.changed?.length) {
    lines.push("", `Changed since last email (${d.changed.length})`);
    for (const c of d.changed.slice(0, maxPerSection))
      lines.push(`- ${c.opportunity.title}: ${c.changes.map(changeLine).join("; ")}`);
    if (d.changed.length > maxPerSection) lines.push(`  +${d.changed.length - maxPerSection} more in Radar`);
  }
  section("New matches", rest.newMatches);
  section("Closing within 7 days", rest.closingSoon);
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
export function renderDigestMarkdown(d: Digest, opts: RenderOptions = {}): string {
  const out: string[] = [`# Radar: ${d.profileName}`, `_${fmtDate(d.generatedAt)}_`, ""];
  if (d.summary) out.push(`**Today in brief:** ${d.summary}`, "");
  if (d.glance) out.push(`**At a glance:** ${glanceLine(d.glance)}`, "");
  const strong = strongestOpen(d);
  const rest = remaining(d, strong);
  const entry = ({ opportunity: o, match: m, tags }: DigestEntry & { tags?: string[] }) => {
    const x = explain(m, d.bands ?? BANDS);
    return [
      `**[${o.title}](${o.provenance.sourceUrl})**${tags?.length ? ` _${tags.join(" · ")}_` : ""}`,
      metaLine(o, d.generatedAt),
      upcomingKeyDates(o.keyDates ?? [], d.generatedAt, o.dueAt)
        .map((k) => `**${keyDateLabel(k)}**`)
        .join(" · "),
      `**${x.headline}.** ${x.gap}`,
      ...x.rows.map((r) => `- ${r.sign}${r.points} ${r.label}: ${r.text}`),
      opts.feedback
        ? `Good fit? [Yes](${opts.feedback(o.id, "yes")}) · [No](${opts.feedback(o.id, "no")})`
        : "",
      "",
    ].filter(Boolean);
  };
  const section = (title: string, rows: (DigestEntry & { tags?: string[] })[]) => {
    if (rows.length === 0) return;
    out.push(`## ${title} (${rows.length})`, "");
    for (const r of rows) out.push(...entry(r), "");
  };
  section("Strong matches still open", strong);
  if (d.changed?.length) {
    out.push(`## Changed since last email (${d.changed.length})`, "");
    for (const c of d.changed)
      out.push(
        `**[${c.opportunity.title}](${c.opportunity.provenance.sourceUrl})**`,
        ...c.changes.map((x) => `- ${changeLine(x)}`),
        "",
      );
  }
  section("New matches", rest.newMatches);
  section("Closing within 7 days", rest.closingSoon);
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
export function renderDigestHtml(d: Digest, opts: RenderOptions = {}): string {
  const font = "font-family:Inter,Segoe UI,Arial,sans-serif";
  const h2 = (t: string) =>
    `<h2 style="${font};font-size:15px;color:#0E2F6C;margin:22px 0 8px;border-bottom:2px solid #1795C3;padding-bottom:4px">${esc(t)}</h2>`;
  const card = (
    title: string,
    url: string,
    meta: string,
    whyHtml: string,
    score?: number,
    band?: Match["band"],
    extraHtml = "",
    footHtml = "",
  ) => {
    const c =
      band === "strong" ? FIT_COLORS.strong : band === "possible" ? FIT_COLORS.possible : FIT_COLORS.notFit;
    const edge = score !== undefined ? `border-left:4px solid ${c.bg};` : "";
    return (
      `<div style="${font};border:1px solid #D3E1EC;${edge}border-radius:8px;padding:10px 12px;margin:0 0 8px">` +
      (score !== undefined
        ? `<span title="${esc(c.label)}" style="float:right;background:${c.bg};color:${c.fg};border-radius:10px;padding:1px 8px;font-size:12px;font-weight:700">${score} · ${esc(c.short)}</span>`
        : "") +
      `<a href="${safeUrl(url)}" style="color:#0E2F6C;font-weight:600;font-size:14px;text-decoration:none">${esc(title)}</a>` +
      `<div style="color:#556175;font-size:12px;margin-top:3px">${esc(meta)}</div>` +
      extraHtml +
      (whyHtml ? `<div style="font-size:12px;margin-top:6px;color:#1B2433">${whyHtml}</div>` : "") +
      footHtml +
      `</div>`
    );
  };
  const btn = (href: string, label: string, bg: string, fg: string) =>
    `<a href="${safeUrl(href)}" style="display:inline-block;background:${bg};color:${fg};border-radius:6px;padding:4px 12px;font-size:12px;font-weight:700;text-decoration:none;margin-right:6px">${esc(label)}</a>`;
  const vote = (id: string) =>
    opts.feedback
      ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #E3ECF3;font-size:12px;color:#556175">Good fit for you? ` +
        btn(opts.feedback(id, "yes"), "Yes", FIT_COLORS.strong.tint, "#145C2A") +
        btn(opts.feedback(id, "no"), "No", FIT_COLORS.notFit.tint, "#A50E0E") +
        `</div>`
      : "";
  const tagPills = (tags: string[] = []) =>
    tags.length
      ? `<div style="margin-top:4px">` +
        tags
          .map(
            (t) =>
              `<span style="display:inline-block;background:#E8F1FB;color:#0E2F6C;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;margin-right:4px">${esc(t)}</span>`,
          )
          .join("") +
        `</div>`
      : "";
  const entries = (rows: (DigestEntry & { tags?: string[] })[]) =>
    rows
      .map(({ opportunity: o, match: m, tags }) =>
        card(
          o.title,
          o.provenance.sourceUrl,
          metaLine(o, d.generatedAt),
          explainHtml(m, d.bands ?? BANDS),
          Math.round(m.score),
          m.band,
          tagPills(tags) + keyDatesHtml(o, d.generatedAt),
          vote(o.id),
        ),
      )
      .join("");
  const strong = strongestOpen(d);
  const rest = remaining(d, strong);
  const changedCards = (rows: DigestChange[]) =>
    rows
      .map(({ opportunity: o, match: m, changes }) =>
        card(
          o.title,
          o.provenance.sourceUrl,
          metaLine(o, d.generatedAt),
          changes
            .map(
              (c) =>
                `<div style="background:${c.kind === "cancelled" || c.kind === "withdrawn" ? "#FCE8E6" : "#E8F1FB"};border-radius:6px;padding:4px 8px;margin-top:3px;font-weight:600;color:${c.kind === "cancelled" || c.kind === "withdrawn" ? "#A50E0E" : "#0E2F6C"}">${esc(changeLine(c))}</div>`,
            )
            .join(""),
          Math.round(m.score),
          m.band,
          keyDatesHtml(o, d.generatedAt),
          vote(o.id),
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
  if (d.summary)
    parts.push(
      `<div style="${font};margin-top:12px;padding:12px 14px;border-radius:10px;background:#F4F9FD;border-left:4px solid #1795C3">` +
        `<div style="font-size:11px;letter-spacing:1.2px;font-weight:700;color:#0E2F6C">TODAY IN BRIEF</div>` +
        `<div style="font-size:14px;line-height:1.5;margin-top:4px;color:#1B2433">${esc(d.summary)}</div></div>`,
    );
  if (d.glance) parts.push(glanceHtml(d, font));
  if (strong.length) parts.push(h2(`Strong matches still open (${strong.length})`), entries(strong));
  if (d.changed?.length)
    parts.push(h2(`Changed since last email (${d.changed.length})`), changedCards(d.changed));
  if (rest.newMatches.length)
    parts.push(h2(`New matches (${rest.newMatches.length})`), entries(rest.newMatches));
  if (rest.closingSoon.length)
    parts.push(h2(`Closing within 7 days (${rest.closingSoon.length})`), entries(rest.closingSoon));
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
  if (
    !d.newMatches.length &&
    !d.closingSoon.length &&
    !d.strongOpen?.length &&
    !d.secondLook.length &&
    !d.changed?.length
  )
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
  const top = [...d.newMatches, ...d.closingSoon, ...(d.strongOpen ?? [])].sort(
    (a, b) => b.match.score - a.match.score,
  )[0];
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
    `<div style="font-size:12px;margin-top:8px;color:#1B2433"><b>${d.newMatches.length}</b> new today · ${d.changed?.length ? `<b>${d.changed.length}</b> changed · ` : ""}<b>${d.closingSoon.length}</b> closing within 7 days</div>` +
    (top ? line("Top match:", top, `fit ${Math.round(top.match.score)}`) : "") +
    (next ? line("Next deadline:", next, `due ${fmtDate(next.opportunity.dueAt, d.generatedAt)}`) : "") +
    `</div>`
  );
}

const FACTOR_LABEL: Record<Reason["factor"], string> = {
  code: "Category code",
  capability: "Capability match",
  semantic: "AI review",
  exclusion: "Excluded term",
  buyer: "Known buyer",
  kind: "Notice type",
  timing: "Timing",
  geography: "Location",
  status: "Status",
};

interface ExplainRow {
  sign: "+" | "−";
  points: number;
  label: string;
  text: string;
}

/**
 * Plain-English account of a score: a headline ("Strong fit, 74 of 100"), how far it sits from the next band,
 * and the signed points behind it, largest first. Uses only the recorded reasons, so it can never disagree
 * with the score.
 */
export function explain(
  m: Pick<Match, "score" | "band" | "reasons" | "review">,
  bands: { strong: number; possible: number },
): { headline: string; gap: string; rows: ExplainRow[] } {
  const score = Math.round(m.score);
  const name = m.band === "strong" ? "Strong fit" : m.band === "possible" ? "Possible fit" : "Low fit";
  const gap =
    m.band === "strong"
      ? `Strong starts at ${bands.strong}.`
      : m.band === "possible"
        ? `${Math.max(1, bands.strong - Math.round(m.score))} points short of Strong (${bands.strong}).`
        : `Possible starts at ${bands.possible}.`;
  const rows = m.reasons
    .filter((r) => Math.round(r.points) !== 0)
    .sort((a, b) => Math.sign(b.points) - Math.sign(a.points) || Math.abs(b.points) - Math.abs(a.points))
    .map((r) => ({
      sign: (r.points > 0 ? "+" : "−") as ExplainRow["sign"],
      points: Math.abs(Math.round(r.points)),
      label: FACTOR_LABEL[r.factor],
      text: reasonText(r, m.review),
    }));
  const total = Math.round(m.reasons.reduce((t, r) => t + r.points, 0));
  const capped = total > 100 ? ` Points total ${total}; the score caps at 100.` : "";
  return { headline: `${name}, ${score} of 100`, gap: gap + capped, rows };
}

function reasonText(r: Reason, review: Match["review"] | undefined): string {
  if (r.factor === "semantic") {
    if (review?.rationale)
      return `${review.verdict === "fit" ? "Fit" : review.verdict === "maybe" ? "Maybe" : "Not a fit"}. ${review.rationale}`;
    const m = /review \((\w+)\): ([\s\S]*)$/.exec(r.detail);
    if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}. ${m[2]}`;
  }
  // Drop the "Matches capabilities:" style prefix; the label already says it.
  return r.detail.replace(
    /^(Classification matches profile|Matches capabilities|Past or current buyer|Notice type|Contains excluded term\(s\)): /,
    "",
  );
}

function explainHtml(m: Match, bands: { strong: number; possible: number }): string {
  const x = explain(m, bands);
  const c =
    m.band === "strong" ? FIT_COLORS.strong : m.band === "possible" ? FIT_COLORS.possible : FIT_COLORS.notFit;
  const head =
    `<div style="background:${c.tint};border-radius:6px;padding:5px 8px;margin-bottom:4px">` +
    `<b style="color:#1B2433">${esc(x.headline)}.</b> <span style="color:#556175">${esc(x.gap)}</span></div>`;
  const rows = x.rows
    .map((r) => {
      const pos = r.sign === "+";
      return (
        `<tr><td valign="top" style="width:38px;padding:2px 6px 2px 0;white-space:nowrap;font-weight:700;color:${pos ? "#1E8E3E" : "#D93025"}">${r.sign}${r.points}</td>` +
        `<td valign="top" style="padding:2px 0"><span style="color:#556175">${esc(r.label)}:</span> ${esc(r.text)}</td></tr>`
      );
    })
    .join("");
  return (
    head +
    (rows
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:12px;width:100%">${rows}</table>`
      : "")
  );
}

/** Upcoming key dates as small chips under a card's meta line; a mandatory event is called out in red. */
function keyDatesHtml(o: Opportunity, now: string): string {
  const kd = upcomingKeyDates(o.keyDates ?? [], now, o.dueAt);
  if (!kd.length) return "";
  return (
    `<div style="margin-top:5px">` +
    kd
      .map((k) => {
        const hot = k.mandatory === true;
        return `<span style="display:inline-block;margin:2px 4px 0 0;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:600;background:${hot ? "#FCE8E6" : "#EEF3F8"};color:${hot ? "#A50E0E" : "#0E2F6C"}">${esc(keyDateLabel(k))}</span>`;
      })
      .join("") +
    `</div>`
  );
}
