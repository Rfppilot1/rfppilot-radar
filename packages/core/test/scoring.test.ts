import { describe, expect, it } from "vitest";
import { BANDS, scoreOpportunity, SCORER_VERSION } from "../src/index.js";
import { NOW, PROFILE, opp } from "./helpers.js";

describe("scoreOpportunity", () => {
  it("rates a code + capability + known-buyer RFP as strong, and every point has a reason", () => {
    const m = scoreOpportunity(opp(), PROFILE, { now: NOW });
    expect(m.band).toBe("strong");
    expect(m.lane).toBe("bid");
    expect(m.scorerVersion).toBe(SCORER_VERSION);
    const sum = m.reasons.reduce((s, r) => s + r.points, 0);
    expect(m.score).toBeCloseTo(Math.min(100, sum), 5);
    expect(m.reasons.map((r) => r.factor)).toEqual(
      expect.arrayContaining(["code", "capability", "buyer", "kind"]),
    );
  });

  it("excludes opportunities outside the target states", () => {
    const m = scoreOpportunity(opp({ state: "GA" }), PROFILE, { now: NOW });
    expect(m.band).toBe("excluded");
    expect(m.reasons.some((r) => r.factor === "geography")).toBe(true);
  });

  it("includes federal work with no stated place of performance, and excludes out-of-state federal work", () => {
    const fed = { buyer: { name: "FEMA", id: null, level: "federal" as const } };
    expect(scoreOpportunity(opp({ ...fed, state: null }), PROFILE, { now: NOW }).band).not.toBe("excluded");
    expect(scoreOpportunity(opp({ ...fed, state: "CA" }), PROFILE, { now: NOW }).band).toBe("excluded");
    expect(
      scoreOpportunity(opp({ ...fed, state: null }), { ...PROFILE, includeFederal: false }, { now: NOW })
        .band,
    ).toBe("excluded");
  });

  it("excludes past-due bids and penalizes tight timelines", () => {
    expect(scoreOpportunity(opp({ dueAt: "2026-10-14T00:00:00.000Z" }), PROFILE, { now: NOW }).band).toBe(
      "excluded",
    );
    const tight = scoreOpportunity(opp({ dueAt: "2026-10-20T00:00:00.000Z" }), PROFILE, { now: NOW });
    expect(tight.reasons.find((r) => r.factor === "timing")?.points).toBeLessThan(0);
  });

  it("excludes exclusion-term matches unless the fit is otherwise strong", () => {
    const m = scoreOpportunity(
      opp({ title: "Janitorial Services", codes: [], buyer: { name: "DPS", id: "405", level: "state" } }),
      PROFILE,
      { now: NOW },
    );
    expect(m.band).toBe("excluded");
  });

  it("gives zero to records with no code or capability signal, even with kind and buyer points", () => {
    const m = scoreOpportunity(opp({ title: "Fleet Vehicles", codes: [] }), PROFILE, { now: NOW });
    expect(m.score).toBe(0);
    expect(m.band).toBe("weak");
  });

  it("routes award decisions to the intel lane and does not exclude them for being closed", () => {
    const m = scoreOpportunity(opp({ kind: "award_decision", status: "closed" }), PROFILE, { now: NOW });
    expect(m.lane).toBe("intel");
    expect(m.band).not.toBe("excluded");
  });

  it("weights title capability matches above description-only matches", () => {
    const inTitle = scoreOpportunity(opp({ codes: [], title: "Strategic Planning Services" }), PROFILE, {
      now: NOW,
    });
    const inBody = scoreOpportunity(
      opp({ codes: [], title: "Professional Services", description: "Includes strategic planning." }),
      PROFILE,
      { now: NOW },
    );
    expect(inTitle.score).toBeGreaterThan(inBody.score);
  });

  it("uses band thresholds consistently", () => {
    const m = scoreOpportunity(opp(), PROFILE, { now: NOW });
    expect(m.score >= BANDS.strong).toBe(m.band === "strong");
  });
});

describe("profile and lane rules", () => {
  it("normalizes state codes to upper case and rejects bad ones", async () => {
    const { FirmProfile } = await import("../src/index.js");
    expect(FirmProfile.parse({ ...PROFILE, states: ["fl", " tx "] }).states).toEqual(["FL", "TX"]);
    expect(() => FirmProfile.parse({ ...PROFILE, states: ["Florida"] })).toThrow();
  });

  it("treats unlabeled notices as biddable and intel kinds as intel, consistently", async () => {
    const { isBiddable } = await import("../src/index.js");
    expect(scoreOpportunity(opp({ kind: "other" }), PROFILE, { now: NOW }).lane).toBe("bid");
    expect(isBiddable("other")).toBe(true);
    expect(scoreOpportunity(opp({ kind: "informational" }), PROFILE, { now: NOW }).lane).toBe("intel");
    expect(isBiddable("informational")).toBe(false);
  });
});
