import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiKeyAuth, buildApp } from "@radar/api";
import type { Opportunity } from "@radar/core";
import { MemoryRepository, rescoreProfile } from "@radar/store";
import { describe, expect, it } from "vitest";
import { RadarClient, createRadarMcpServer } from "../src/index.js";

const NOW = "2026-10-15T14:00:00.000Z";
const KEY = "isf-key-0123456789abcdef";

const opp: Opportunity = {
  id: "tx-esbd:900001",
  source: "tx-esbd",
  sourceRecordId: "900001",
  solicitationNumber: "529-27-0001",
  title: "RFP Independent Verification and Validation (IV&V) Services",
  description: null,
  kind: "rfp",
  kindLabel: null,
  status: "open",
  buyer: { name: "Health and Human Services Commission", id: "529", level: "state" },
  state: "TX",
  postedAt: "2026-10-14T05:00:00.000Z",
  dueAt: "2026-11-20T20:00:00.000Z",
  dueTimezone: "America/Chicago",
  codes: [{ system: "NIGP", code: "91875", description: "Management Consulting" }],
  setAside: null,
  contact: null,
  documents: [],
  version: null,
  hasAddendum: false,
  provenance: {
    source: "tx-esbd",
    sourceUrl: "https://www.txsmartbuy.gov/esbd/529-27-0001",
    fetchedAt: NOW,
    contentHash: "e".repeat(64),
    basis: "tx-esbd",
  },
};

describe("Radar MCP server", () => {
  it("exposes tools that read matches and record decisions through the API, scoped to the key's tenant", async () => {
    const repo = new MemoryRepository();
    await repo.upsertOpportunities([opp], NOW);
    const profile = {
      id: "isf-main",
      tenantId: "isf",
      name: "ISF",
      states: ["TX"],
      includeFederal: true,
      codes: [{ system: "NIGP" as const, prefix: "918", weight: 1 }],
      capabilities: [{ phrase: "independent verification and validation", weight: 1 }],
      exclusions: [],
      knownBuyers: [],
      minDaysToRespond: 10,
      scoring: { weights: {}, bands: {}, kindPoints: {} },
      delivery: { email: [] },
    };
    await repo.upsertProfile(profile, NOW);
    await rescoreProfile(repo, profile, NOW);
    const app = buildApp({ repo, auth: new ApiKeyAuth([{ tenantId: "isf", key: KEY }]), now: () => NOW });

    // Route the client's fetch through Fastify's in-process injector.
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const u = new URL(String(input));
      const r = await app.inject({
        method: (init?.method ?? "GET") as "GET",
        url: u.pathname + u.search,
        headers: init?.headers as Record<string, string>,
        payload: init?.body as string | undefined,
      });
      return new Response(r.body, { status: r.statusCode, headers: r.headers as Record<string, string> });
    }) as typeof fetch;

    const server = createRadarMcpServer(new RadarClient("http://radar.test", KEY, fetchImpl), "isf-main");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "get_digest",
      "get_opportunity",
      "get_rfp_pilot_handoff",
      "list_matches",
      "record_decision",
      "second_look",
    ]);

    const list = await client.callTool({ name: "list_matches", arguments: {} });
    const text = (list.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text).matches[0].opportunity.id).toBe(opp.id);

    await client.callTool({
      name: "record_decision",
      arguments: { opportunityId: opp.id, decision: "pass", reason: "Teaming needed" },
    });
    const sl = await client.callTool({ name: "second_look", arguments: {} });
    expect((sl.content as { text: string }[])[0]!.text).toContain("Teaming needed");

    const handoff = await client.callTool({
      name: "get_rfp_pilot_handoff",
      arguments: { opportunityId: opp.id },
    });
    expect(JSON.parse((handoff.content as { text: string }[])[0]!.text).handoffVersion).toBe("1.0");
    await client.close();
  });
});
