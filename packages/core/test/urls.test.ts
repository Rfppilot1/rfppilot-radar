import { describe, expect, it } from "vitest";
import { isPublicUrl, toHandoff, type Match, type Opportunity } from "../src/index.js";

describe("isPublicUrl", () => {
  it("accepts public http(s) links", () => {
    for (const u of [
      "https://www.txsmartbuy.gov/esbd/file.pdf",
      "http://bids.example.org/a?b=1",
      "https://8.8.8.8/x",
    ])
      expect(isPublicUrl(u), u).toBe(true);
  });

  it("rejects other schemes, private and metadata addresses, intranet names and disguised IPs", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://example.org/a",
      "javascript:alert(1)",
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/",
      "http://10.0.0.5/",
      "http://172.20.1.1/",
      "http://192.168.1.10/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost/",
      "http://api.localhost/",
      "http://intranet/",
      "http://db.internal/",
      "http://2130706433/",
      "http://0x7f.1/",
      "https://user:pw@example.org/",
      "not a url",
    ])
      expect(isPublicUrl(u), u).toBe(false);
  });

  it("keeps only public document links in the RFP Pilot handoff", () => {
    const opp = {
      id: "tx-esbd:1",
      title: "T",
      solicitationNumber: null,
      buyer: { name: "B", id: null, level: "state" },
      state: "TX",
      kind: "rfp",
      kindLabel: null,
      postedAt: null,
      dueAt: null,
      dueTimezone: null,
      codes: [],
      setAside: null,
      contact: null,
      documents: [
        {
          filename: "RFP.pdf",
          url: "https://www.txsmartbuy.gov/f/RFP.pdf",
          description: null,
          postedAt: null,
        },
        { filename: "x", url: "http://169.254.169.254/latest", description: null, postedAt: null },
      ],
      provenance: {
        source: "tx-esbd",
        sourceUrl: "https://www.txsmartbuy.gov/esbd/1",
        fetchedAt: "2026-10-15T14:00:00.000Z",
        contentHash: "a".repeat(64),
      },
    } as unknown as Opportunity;
    const match = { score: 50, band: "strong", reasons: [], scorerVersion: "x" } as unknown as Match;
    expect(toHandoff(opp, match, "isf").documents.map((d) => d.originalFilename)).toEqual(["RFP.pdf"]);
  });
});
