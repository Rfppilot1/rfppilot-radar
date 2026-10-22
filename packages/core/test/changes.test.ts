import { describe, expect, it } from "vitest";
import {
  changeLine,
  clipSentence,
  diffOpportunity,
  explain,
  extractKeyDates,
  keyDateLabel,
  upcomingKeyDates,
} from "../src/index.js";
import { NOW, opp } from "./helpers.js";

describe("key dates", () => {
  it("finds a dated, mandatory pre-bid conference and a question deadline, with their times", () => {
    const text =
      "A mandatory pre-bid conference will be held on October 27, 2026 at 10:00 a.m. in Room 4. " +
      "Questions must be submitted no later than 11/3/2026 by 5:00 PM CT. Proposals are due November 20.";
    const kd = extractKeyDates(text, { now: NOW });
    expect(kd.map((k) => [k.kind, k.date, k.time, k.mandatory])).toEqual([
      ["pre_bid", "2026-10-27", "10:00 AM", true],
      ["questions_due", "2026-11-03", "5:00 PM", null],
    ]);
    expect(keyDateLabel(kd[0]!)).toBe("Mandatory pre-bid conference Oct 27, 10:00 AM");
  });

  it("marks non-mandatory events, infers the year, and keeps an undated site visit", () => {
    const kd = extractKeyDates(
      "A non-mandatory pre-proposal meeting is scheduled for Jan. 8 at 2 pm. A site visit may be arranged with the contact.",
      { now: NOW },
    );
    expect(kd.map((k) => [k.kind, k.date, k.time, k.mandatory])).toEqual([
      ["pre_bid", "2027-01-08", "2:00 PM", false],
      ["site_visit", null, null, null],
    ]);
    expect(keyDateLabel(kd[1]!)).toBe("Site visit (date in posting)");
  });

  it("ignores undated boilerplate and drops past dates and a bid opening on the due date", () => {
    expect(extractKeyDates("Questions should be directed to the procurement officer.", { now: NOW })).toEqual(
      [],
    );
    const kd = extractKeyDates(
      "Pre-bid meeting October 1, 2026. Public bid opening November 20, 2026 at 2:00 PM.",
      { now: NOW },
    );
    expect(upcomingKeyDates(kd, NOW, "2026-11-20T20:00:00.000Z")).toEqual([]);
  });
});

describe("change detection", () => {
  const enriched = { description: "IV&V services.", documents: [] };

  it("reports a moved deadline, an addendum with its documents, and a new key date", () => {
    const prev = opp({
      ...enriched,
      documents: [{ filename: "RFP.pdf", url: "https://x.gov/1", description: null, postedAt: null }],
    });
    const cur = opp({
      dueAt: "2026-11-30T20:00:00.000Z",
      description: "IV&V services. Mandatory pre-bid Nov 2.",
      documents: [
        { filename: "RFP.pdf", url: "https://x.gov/1", description: null, postedAt: null },
        { filename: "Addendum No. 1.pdf", url: "https://x.gov/2", description: null, postedAt: null },
      ],
      keyDates: [
        {
          kind: "pre_bid",
          date: "2026-11-02",
          time: null,
          mandatory: true,
          note: "Mandatory pre-bid Nov 2.",
        },
      ],
    });
    expect(diffOpportunity(prev, cur, NOW).map(changeLine)).toEqual([
      "Deadline extended: Nov 20 → Nov 30",
      "Addendum posted: Addendum No. 1.pdf",
      "Added: Mandatory pre-bid conference Nov 2",
    ]);
  });

  it("flags cancellation and a posting pulled before its deadline", () => {
    expect(diffOpportunity(opp(), opp({ status: "cancelled" }), NOW).map(changeLine)).toEqual([
      "Cancelled by the agency",
    ]);
    expect(diffOpportunity(opp(), opp({ status: "closed" }), NOW)[0]?.kind).toBe("withdrawn");
    // Closed after its deadline passed is the normal end of a posting, not news.
    expect(diffOpportunity(opp(), opp({ status: "closed" }), "2026-12-01T00:00:00.000Z")).toEqual([]);
  });

  it("ignores key dates found by re-reading unchanged text, and dates already past", () => {
    const text = "IV&V services. Questions due October 6, 2026. Pre-bid conference November 2, 2026.";
    const prev = opp({ description: text, documents: [] });
    const reparsed = opp({
      description: text,
      documents: [],
      keyDates: [{ kind: "pre_bid", date: "2026-11-02", time: null, mandatory: null, note: "x" }],
    });
    expect(diffOpportunity(prev, reparsed, NOW)).toEqual([]);
    const amended = opp({
      description: `${text} Amended.`,
      documents: [],
      keyDates: [
        { kind: "questions_due", date: "2026-10-06", time: null, mandatory: null, note: "x" },
        { kind: "pre_bid", date: "2026-11-02", time: null, mandatory: null, note: "x" },
      ],
    });
    expect(diffOpportunity(prev, amended, NOW).map(changeLine)).toEqual(["Added: Pre-bid conference Nov 2"]);
  });

  it("does not report detail Radar only just started reading as a change", () => {
    const cur = opp({
      description: "Pre-bid conference October 30, 2026.",
      documents: [{ filename: "RFP.pdf", url: "https://x.gov/1", description: null, postedAt: null }],
      keyDates: [{ kind: "pre_bid", date: "2026-10-30", time: null, mandatory: null, note: "x" }],
    });
    expect(diffOpportunity(opp(), cur, NOW)).toEqual([]);
  });
});

describe("explanations", () => {
  it("rounds the distance to Strong from the displayed score", () => {
    const x = explain(
      { score: 41.6, band: "possible", reasons: [], review: null },
      { strong: 55, possible: 30 },
    );
    expect(x.headline).toBe("Possible fit, 42 of 100");
    expect(x.gap).toBe("13 points short of Strong (55).");
  });

  it("clips a long AI rationale at a clause boundary, never mid-word", () => {
    const t = `${"The scope calls for actuarial examination expertise, ".repeat(5)}and more`;
    const c = clipSentence(t, 120);
    expect(c.length).toBeLessThanOrEqual(121);
    expect(c.endsWith(".")).toBe(true);
    expect(c).not.toMatch(/\w\.$.*\w/);
    expect(clipSentence("Short.", 120)).toBe("Short.");
  });
});

describe("fallback brief", () => {
  it("writes a brief from the digest alone, leading with the strongest open match, then the soonest deadline", async () => {
    const { fallbackSummary } = await import("../src/index.js");
    const entry = (title: string, score: number, dueAt: string) => ({
      opportunity: opp({ title, dueAt, buyer: { name: "DEPT OF DEFENSE", id: null, level: "federal" } }),
      match: { score, band: score >= 55 ? "strong" : "possible" } as never,
    });
    const text = fallbackSummary({
      profileName: "ISF, Inc.",
      generatedAt: NOW,
      newMatches: [],
      closingSoon: [entry("Exam", 47, "2026-10-19T20:00:00.000Z")],
      strongOpen: [entry("IV&V", 75, "2026-10-30T20:00:00.000Z")],
      intel: [],
      secondLook: [],
    });
    expect(text).toBe(
      "Strongest open opportunity: IV&V (Dept of Defense, fit 75, due Oct 30). Closing soonest: Exam (Dept of Defense, fit 47, due Oct 19).",
    );
  });
});

describe("agency names", () => {
  it("title-cases shouting federal names, keeps acronyms, and drops a repeated office", async () => {
    const { displayAgency } = await import("../src/index.js");
    expect(displayAgency("DEPT OF DEFENSE / DEPT OF THE NAVY")).toBe("Dept of Defense / Dept of the Navy");
    expect(displayAgency("DEPT OF DEFENSE / US SPECIAL OPERATIONS COMMAND (USSOCOM)")).toBe(
      "Dept of Defense / US Special Operations Command (USSOCOM)",
    );
    expect(
      displayAgency(
        "NATIONAL AERONAUTICS AND SPACE ADMINISTRATION / NATIONAL AERONAUTICS AND SPACE ADMINISTRATION",
      ),
    ).toBe("National Aeronautics and Space Administration");
    expect(displayAgency("Dept Family And Protective Svc - 530")).toBe(
      "Dept Family And Protective Svc - 530",
    );
  });
});

describe("estimated value", () => {
  it("reads a stated value conservatively and formats it", async () => {
    const { valueFromText, formatValue, parseMoney } = await import("../src/index.js");
    expect(parseMoney("59,500.00")).toBe(59500);
    expect(parseMoney("0.00")).toBeNull();
    const v = valueFromText(
      "Proposers must carry $1,000,000 in general liability insurance. The estimated contract value is $2.5 million over three years.",
    );
    expect(v).toMatchObject({ amount: 2_500_000, basis: "posting_text" });
    expect(v?.text).toMatch(/^The estimated contract value/);
    expect(formatValue(v!)).toBe("≈$2.5M");
    expect(formatValue({ amount: 59500, basis: "agency_estimate", text: null })).toBe("$59.5K");
    expect(valueFromText("A bid bond of $50,000 is required.")).toBeNull();
    expect(valueFromText("Hourly rates up to $150 per hour.")).toBeNull();
  });
});

describe("strongest first", () => {
  it("puts every open strong match first, best fit first, and leads the brief facts with them", async () => {
    const { renderDigestHtml, renderDigestText, strongestOpen, summaryFacts, summaryPrompt } =
      await import("../src/index.js");
    const entry = (title: string, score: number, dueAt: string) => ({
      opportunity: opp({
        id: `tx-esbd:${title}`,
        title,
        dueAt,
        buyer: { name: "DEPT OF DEFENSE", id: null, level: "federal" },
      }),
      match: { score, band: score >= 55 ? "strong" : "possible", reasons: [] } as never,
    });
    const newStrong = entry("Fresh IV&V", 80, "2026-11-20T20:00:00.000Z");
    const newPossible = entry("Maybe Audit", 50, "2026-11-21T20:00:00.000Z");
    const closingStrong = entry("Closing PMO", 60, "2026-10-19T20:00:00.000Z");
    const older = entry("Older QA", 70, "2026-12-01T20:00:00.000Z");
    const d = {
      profileName: "ISF, Inc.",
      generatedAt: NOW,
      glance: { screened: 10, strong: 3, possible: 1, notFit: 6, bySource: {} },
      changed: [],
      newMatches: [newStrong, newPossible],
      closingSoon: [closingStrong],
      strongOpen: [older],
      intel: [],
      secondLook: [],
    };
    const strong = strongestOpen(d);
    expect(strong.map((e) => e.opportunity.title)).toEqual(["Fresh IV&V", "Older QA", "Closing PMO"]);
    expect(strong[0]!.tags).toEqual(["New today"]);
    expect(strong[2]!.tags).toEqual(["Closes within 7 days"]);

    const t = renderDigestText(d);
    expect(t.indexOf("Strong matches still open (3)")).toBeLessThan(t.indexOf("New matches (1)"));
    expect(t).not.toContain("Closing within 7 days");

    const html = renderDigestHtml(d);
    expect(html.indexOf("AT A GLANCE")).toBeLessThan(html.indexOf("Strong matches still open (3)"));
    expect(html.indexOf("Strong matches still open (3)")).toBeLessThan(html.indexOf("New matches (1)"));

    const facts = summaryFacts(d);
    expect(facts.split("\n")[1]).toContain("Strongest open opportunities (3)");
    expect(summaryPrompt(d)).toContain(
      "FIRST sentence must always be about the strongest open opportunities",
    );
  });
});
