import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RadarClient } from "./client.js";

/**
 * MCP tools that let a customer's own Claude work with Radar: "what's new that fits us", "why did this
 * match", "record that we're passing", "what should a second reviewer look at", and "hand this to RFP Pilot".
 * Every tool is scoped by the API key the server was started with, so a client only sees its own tenant.
 */
export function createRadarMcpServer(client: RadarClient, defaultProfileId?: string): McpServer {
  const server = new McpServer({ name: "rfp-pilot-radar", version: "0.1.0" });
  const profileId = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional()
    .describe("Firm profile id. Defaults to the server's configured profile.");
  const pid = (p?: string) => {
    const v = p ?? defaultProfileId;
    if (!v) throw new Error("profileId is required (no default profile configured)");
    return encodeURIComponent(v);
  };
  const asText = (data: unknown) => ({
    content: [
      { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  });

  server.registerTool(
    "list_matches",
    {
      title: "List matching opportunities",
      description:
        "Open public-sector opportunities scored against the firm's profile, with the reasons behind every score. " +
        "Use lane=intel for award decisions and pre-solicitations instead of biddable notices.",
      inputSchema: {
        profileId,
        bands: z
          .string()
          .optional()
          .describe("Comma-separated bands: strong,possible,weak,excluded. Default strong,possible."),
        lane: z.enum(["bid", "intel"]).optional(),
        since: z.string().datetime().optional().describe("Only matches first found on/after this ISO time"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      asText(
        await client.get(`/v1/profiles/${pid(a.profileId)}/matches`, {
          band: a.bands,
          lane: a.lane,
          since: a.since,
          limit: a.limit ?? 25,
        }),
      ),
  );

  server.registerTool(
    "get_opportunity",
    {
      title: "Get one opportunity",
      description: "Full record for one opportunity, including the public source link and provenance.",
      inputSchema: { opportunityId: z.string().min(3) },
      annotations: { readOnlyHint: true },
    },
    async (a) => asText(await client.get(`/v1/opportunities/${encodeURIComponent(a.opportunityId)}`)),
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record pursue / pass / watch",
      description:
        "Records the firm's decision on an opportunity. Passes are kept and resurface in the second-look review if " +
        "the opportunity changes or was rated strong, so record the reason.",
      inputSchema: {
        profileId,
        opportunityId: z.string().min(3),
        decision: z.enum(["pursue", "pass", "watch"]),
        reason: z.string().max(2000).optional(),
        decidedBy: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (a) =>
      asText(
        await client.post(`/v1/profiles/${pid(a.profileId)}/decisions`, {
          opportunityId: a.opportunityId,
          decision: a.decision,
          reason: a.reason ?? null,
          decidedBy: a.decidedBy ?? null,
        }),
      ),
  );

  server.registerTool(
    "second_look",
    {
      title: "Second-look review",
      description:
        "Passed-on opportunities that were rated well or have changed since, plus near misses just under the cutoff.",
      inputSchema: { profileId },
      annotations: { readOnlyHint: true },
    },
    async (a) => asText(await client.get(`/v1/profiles/${pid(a.profileId)}/second-look`)),
  );

  server.registerTool(
    "get_digest",
    {
      title: "Daily digest",
      description:
        "New matches, items closing within 7 days, second-look items and market intel, as text or Markdown.",
      inputSchema: {
        profileId,
        since: z.string().datetime().optional(),
        format: z.enum(["text", "markdown"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      asText(
        await client.getText(`/v1/profiles/${pid(a.profileId)}/digest`, {
          since: a.since,
          format: a.format ?? "markdown",
        }),
      ),
  );

  server.registerTool(
    "get_rfp_pilot_handoff",
    {
      title: "Prepare RFP Pilot handoff",
      description:
        "The structured payload RFP Pilot uses to open a solicitation workspace: solicitation details, original document " +
        "links and filenames, fit reasons and provenance.",
      inputSchema: { profileId, opportunityId: z.string().min(3) },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      asText(
        await client.get(
          `/v1/profiles/${pid(a.profileId)}/opportunities/${encodeURIComponent(a.opportunityId)}/handoff`,
        ),
      ),
  );

  return server;
}
