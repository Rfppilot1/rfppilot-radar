import { readFileSync } from "node:fs";
import { groupDeclarations } from "@radar/connectors";
import { renderDigestHtml, type Digest, type Opportunity } from "@radar/core";
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
