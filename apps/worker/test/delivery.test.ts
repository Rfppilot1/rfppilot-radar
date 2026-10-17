import { readFileSync } from "node:fs";
import { groupDeclarations } from "@radar/connectors";
import { explain, renderDigestHtml, type Digest, type Opportunity } from "@radar/core";
import { describe, expect, it } from "vitest";
import { ResendMailer, digestSubject } from "../src/mailer.js";
import { toDigestSignals } from "../src/signals.js";

const NOW = "2026-10-15T14:00:00.000Z";

describe("email delivery", () => {
  it("posts to Resend with the digest and refuses bad configuration", async () => {
    let req: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      req = { url, init };
      return new Response(JSON.stringify({ id: "em_1" }));
    }) as unknown as typeof fetch;
    const m = new ResendMailer("re_test", "Radar <radar@rfppilot.com>", fetchImpl);
    expect(await m.send({ to: ["monica@example.com"], subject: "s", html: "<p>h</p>", text: "t" })).toEqual({
      id: "em_1",
    });
    expect(req!.url).toBe("https://api.resend.com/emails");
    expect((req!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(req!.init.body as string)).toMatchObject({
      to: ["monica@example.com"],
      from: "Radar <radar@rfppilot.com>",
    });
    expect(await m.send({ to: [], subject: "s", html: "", text: "" })).toEqual({ id: null });
    await m.send({
      to: ["a@b.co"],
      subject: "s",
      html: "h",
      text: "t",
      unsubscribe: "mailto:u@rfppilot.com?subject=unsubscribe",
    });
    expect(JSON.parse(req!.init.body as string).headers).toEqual({
      "List-Unsubscribe": "<mailto:u@rfppilot.com?subject=unsubscribe>",
    });
    expect(() => new ResendMailer("", "x@y.z")).toThrow(/RESEND_API_KEY/);
    expect(() => new ResendMailer("k", "nobody")).toThrow(/RADAR_EMAIL_FROM/);
  });

  it("writes a short subject line", () => {
    expect(digestSubject("ISF", 3, 1, NOW)).toBe("Radar Oct 15: 3 new, 1 closing soon for ISF");
  });

  it("escapes posting text in the HTML email and only links https URLs", () => {
    const o = {
      id: "x:1",
      source: "tx-esbd",
      title: '<script>alert("x")</script> Study',
      buyer: { name: "A & B", id: null, level: "state" },
      kind: "rfp",
      kindLabel: null,
      dueAt: null,
      provenance: { sourceUrl: "javascript:alert(1)" },
    } as unknown as Opportunity;
    const d: Digest = {
      profileName: "ISF",
      generatedAt: NOW,
      newMatches: [{ opportunity: o, match: { score: 61, reasons: [], band: "strong" } as never }],
      closingSoon: [],
      intel: [],
      secondLook: [],
    };
    const html = renderDigestHtml(d);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain('href="#"');
  });
});

it("leads with an at-a-glance panel and colors scores by fit band", () => {
  const o = (id: string, title: string, dueAt: string | null) =>
    ({
      id,
      source: "fl-mfmp",
      title,
      buyer: { name: "DMS", id: null, level: "state" },
      kind: "rfp",
      kindLabel: null,
      dueAt,
      provenance: { sourceUrl: `https://example.gov/${id}` },
    }) as unknown as Opportunity;
  const strong = {
    opportunity: o("a", "Strategy study", null),
    match: { score: 72, reasons: [], band: "strong" } as never,
  };
  const maybe = {
    opportunity: o("b", "Audit support", "2026-10-18T20:00:00.000Z"),
    match: { score: 41, reasons: [], band: "possible" } as never,
  };
  const d: Digest = {
    profileName: "ISF",
    generatedAt: NOW,
    glance: {
      screened: 634,
      strong: 3,
      possible: 19,
      notFit: 612,
      bySource: { "tx-esbd": 477, "fl-mfmp": 157 },
    },
    newMatches: [strong, maybe],
    closingSoon: [maybe],
    intel: [],
    secondLook: [],
  };
  const html = renderDigestHtml(d);
  expect(html.indexOf("AT A GLANCE")).toBeLessThan(html.indexOf("New matches"));
  expect(html).toContain("634 open solicitations");
  expect(html).toContain("Texas 477 · Florida 157");
  expect(html).toContain("Top match:");
  expect(html).toContain("Next deadline:");
  expect(html).toMatch(/background:#1E8E3E;color:#FFFFFF;[^>]*>72 · Strong</);
  expect(html).toMatch(/background:#F2B705;color:#3A2C00;[^>]*>41 · Possible</);
  expect(html).toContain("14 points short of Strong (55)");
});

describe("score explanation", () => {
  it("lists signed points, largest first, with the AI rationale in plain words", () => {
    const x = explain(
      {
        score: 74,
        band: "strong",
        review: null,
        reasons: [
          { factor: "kind", points: 5, detail: "Notice type: RFP" },
          { factor: "capability", points: 24, detail: 'Matches capabilities: "strategic planning" (title)' },
          { factor: "exclusion", points: -10, detail: 'Contains excluded term(s): "staffing"' },
          {
            factor: "semantic",
            points: 15,
            detail: "Claude (claude-haiku-5-5) review (fit): Core strategy work.",
          },
          { factor: "timing", points: 0, detail: "ok" },
        ],
      },
      { strong: 55, possible: 30 },
    );
    expect(x.headline).toBe("Strong fit, 74 of 100");
    expect(x.rows.map((r) => `${r.sign}${r.points} ${r.label}: ${r.text}`)).toEqual([
      '+24 Capability match: "strategic planning" (title)',
      "+15 AI review: Fit. Core strategy work.",
      "+5 Notice type: RFP",
      '−10 Excluded term: "staffing"',
    ]);
  });
});

describe("FEMA signals", () => {
  it("keeps only Public Assistance declarations and describes them", () => {
    const rows = JSON.parse(
      readFileSync(
        new URL("../../../packages/connectors/test/fixtures/openfema.verbatim.json", import.meta.url),
        "utf8",
      ),
    );
    const s = toDigestSignals(
      groupDeclarations(
        [
          ...rows,
          { ...rows[0], disasterNumber: 9999, femaDeclarationString: "EM-9999-FL", paProgramDeclared: false },
        ],
        "FL",
      ),
    );
    expect(s.map((x) => x.title)).toEqual([
      "FM-5632-FL: Cow Creek Fire (FL)",
      "FM-5631-FL: Railroad Complex Fire (FL)",
    ]);
    expect(s[1]!.detail).toContain("Putnam, Clay");
  });
});

describe("operator-set recipients", () => {
  it("parses RADAR_RECIPIENTS and overrides only the profiles it lists", async () => {
    const { parseRecipients, recipientsFor } = await import("../src/mailer.js");
    const m = parseRecipients(" isf/isf-main = ben@rfppilot.com, monica@example.com ; other/p1=a@b.co ");
    expect(recipientsFor(m, "isf", "isf-main", [])).toEqual(["ben@rfppilot.com", "monica@example.com"]);
    expect(recipientsFor(m, "other", "p1", ["x@y.co"])).toEqual(["a@b.co"]);
    expect(recipientsFor(m, "isf", "second", ["kept@y.co"])).toEqual(["kept@y.co"]);
    expect(parseRecipients(undefined).size).toBe(0);
    expect(() => parseRecipients("isf-main=ben@rfppilot.com")).toThrow(/tenant\/profile/);
    expect(() => parseRecipients("isf/isf-main=not-an-email")).toThrow(/invalid address/);
  });
});
