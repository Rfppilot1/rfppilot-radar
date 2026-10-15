import { describe, expect, it } from "vitest";
import {
  FirmProfile,
  applyReview,
  needsReview,
  parseVerdict,
  reviewPrompt,
  scoreOpportunity,
} from "../src/index.js";
import { NOW, PROFILE, opp } from "./helpers.js";

describe("semantic review", () => {
  const weak = scoreOpportunity(opp({ title: "Random Moment Sampling", codes: [], kind: "rfp" }), PROFILE, {
    now: NOW,
  });

  it("reviews only in-scope, non-excluded, below-strong biddable matches", () => {
    expect(needsReview(weak)).toBe(true);
    expect(needsReview(scoreOpportunity(opp(), PROFILE, { now: NOW }))).toBe(false); // already strong
    expect(needsReview(scoreOpportunity(opp({ state: "GA" }), PROFILE, { now: NOW }))).toBe(false);
    expect(
      needsReview(scoreOpportunity(opp({ title: "Janitorial", codes: [] }), PROFILE, { now: NOW })),
    ).toBe(false);
    expect(needsReview(scoreOpportunity(opp({ kind: "award_decision" }), PROFILE, { now: NOW }))).toBe(false);
  });

  it("adds a labeled semantic reason, recomputes the band, and records what was reviewed", () => {
    const m = applyReview(
      weak,
      { verdict: "fit", rationale: "Time-study sampling is program evaluation work.", reviewer: "Claude" },
      { contentHash: "f".repeat(64), profileHash: "p".repeat(64) },
    );
    expect(weak.score).toBe(0); // no rule-based fit signal
    expect(m.score).toBe(45); // kind (RFP) 7 + known buyer 8 + review 30
    expect(m.band).toBe("possible");
    expect(m.reasons.at(-1)).toMatchObject({ factor: "semantic", points: 30 });
    expect(m.review).toMatchObject({ verdict: "fit", contentHash: "f".repeat(64) });
    expect(applyReview(weak, { verdict: "no", rationale: "x", reviewer: "C" }).band).toBe("weak");
  });

  it("parses verdicts strictly", () => {
    expect(parseVerdict('Sure: {"verdict":"maybe","rationale":"Partial fit."}', "C").verdict).toBe("maybe");
    expect(() => parseVerdict('{"verdict":"yes"}', "C")).toThrow(/Invalid verdict/);
    expect(() => parseVerdict("no json here", "C")).toThrow(/no JSON/);
  });

  it("builds a prompt that contains only the notice and the stated profile", () => {
    const p = reviewPrompt(opp(), FirmProfile.parse(PROFILE));
    expect(p).toContain("Independent Verification and Validation Services");
    expect(p).toContain("strategic planning");
    expect(p).toContain("Do not assume facts about the firm");
  });
});
