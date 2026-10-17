import { describe, expect, it } from "vitest";
import {
  renderDigestMarkdown,
  renderDigestText,
  scoreOpportunity,
  secondLook,
  toHandoff,
  type Decision,
} from "../src/index.js";
import { NOW, PROFILE, opp } from "./helpers.js";

const decision = (over: Partial<Decision> = {}): Decision => ({
  opportunityId: "tx-esbd:1",
  profileId: "isf-main",
  decision: "pass",
  reason: "Too small",
  decidedBy: "monica",
  decidedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("secondLook", () => {
  it("surfaces strong or possible items the firm passed on, with the pass reason", () => {
    const o = opp();
    const m = scoreOpportunity(o, PROFILE, { now: NOW });
    const items = secondLook({
      opportunities: new Map([[o.id, o]]),
      matches: [m],
      decisions: [decision()],
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.why).toBe("passed");
    expect(items[0]!.note).toContain("Too small");
  });

  it("flags passed items that changed since the decision first", () => {
    const o = opp();
    const m = scoreOpportunity(o, PROFILE, { now: NOW });
    const items = secondLook({
      opportunities: new Map([[o.id, o]]),
      matches: [m],
      decisions: [decision()],
      hashAtDecision: new Map([[o.id, "b".repeat(64)]]),
      now: NOW,
    });
    expect(items[0]!.why).toBe("changed");
  });

  it("ignores passes older than the review window and pursued items", () => {
    const o = opp();
    const m = scoreOpportunity(o, PROFILE, { now: NOW });
    const old = secondLook({
      opportunities: new Map([[o.id, o]]),
      matches: [m],
      decisions: [decision({ decidedAt: "2026-01-01T00:00:00.000Z" })],
      now: NOW,
    });
    const pursued = secondLook({
      opportunities: new Map([[o.id, o]]),
      matches: [m],
      decisions: [decision({ decision: "pursue" })],
      now: NOW,
    });
    expect(old).toHaveLength(0);
    expect(pursued).toHaveLength(0);
  });

  it("surfaces undecided near misses just under the cutoff", () => {
    const o = opp();
    const m = { ...scoreOpportunity(o, PROFILE, { now: NOW }), score: 27, band: "weak" as const };
    const items = secondLook({ opportunities: new Map([[o.id, o]]), matches: [m], decisions: [], now: NOW });
    expect(items[0]!.why).toBe("near_miss");
  });
});

describe("digest and handoff", () => {
  const o = opp();
  const m = scoreOpportunity(o, PROFILE, { now: NOW });
  const digest = {
    profileName: "ISF",
    generatedAt: NOW,
    newMatches: [{ opportunity: o, match: m }],
    closingSoon: [],
    intel: [],
    secondLook: [],
  };

  it("renders a text digest with title, buyer, due date and fit", () => {
    const t = renderDigestText(digest);
    expect(t).toContain("New matches (1)");
    expect(t).toContain(o.title);
    expect(t).toContain("Health and Human Services Commission");
    expect(t).toMatch(/fit \d+/);
  });

  it("renders markdown that links to the public source page and explains the match", () => {
    const md = renderDigestMarkdown(digest);
    expect(md).toContain(`](${o.provenance.sourceUrl})`);
    expect(md).toMatch(/fit, \d+ of 100/);
  });

  it("builds a valid RFP Pilot handoff that keeps original document names", () => {
    const h = toHandoff(
      {
        ...o,
        documents: [
          { filename: "Bid_254855_IR.doc", url: "https://example.gov/f", description: null, postedAt: null },
        ],
      },
      m,
      "isf",
    );
    expect(h.handoffVersion).toBe("1.0");
    expect(h.documents[0]!.originalFilename).toBe("Bid_254855_IR.doc");
    expect(h.solicitation.sourceUrl).toBe(o.provenance.sourceUrl);
  });
});
