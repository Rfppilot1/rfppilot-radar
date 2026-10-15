import {
  Decision,
  FirmProfile,
  Match,
  Opportunity,
  RfpPilotHandoff,
  renderDigestMarkdown,
  renderDigestText,
  secondLook,
  toHandoff,
} from "@radar/core";
import { NotFoundError, buildDigest, type Repository } from "@radar/store";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ApiKeyAuth } from "./auth.js";

export interface AppDeps {
  repo: Repository;
  auth: ApiKeyAuth;
  now?: () => string;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const ProfileInput = FirmProfile.omit({ id: true, tenantId: true });
const DecisionInput = z.object({
  opportunityId: z.string().min(3),
  decision: z.enum(["pursue", "pass", "watch"]),
  reason: z.string().max(2000).nullable().default(null),
  decidedBy: z.string().max(200).nullable().default(null),
});
const MatchesQuery = z.object({
  band: z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(",") as Match["band"][]) : undefined))
    .pipe(z.array(z.enum(["strong", "possible", "weak", "excluded"])).optional()),
  lane: z.enum(["bid", "intel"]).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const DigestQuery = z.object({
  since: z.string().datetime().optional(),
  format: z.enum(["json", "text", "markdown"]).default("json"),
});
const ProfileId = z.object({ profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });

export const MatchWithOpportunity = z.object({
  match: Match.extend({ firstMatchedAt: z.string() }),
  opportunity: Opportunity,
});

/** Public OpenAPI 3.1 document, generated from the same zod schemas the handlers validate with. */
export function openApiDocument() {
  const s = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  const auth = [{ bearer: [] }];
  const pid = { name: "profileId", in: "path", required: true, schema: { type: "string" } };
  return {
    openapi: "3.1.0",
    info: {
      title: "RFP Pilot Radar API",
      version: "1.0.0",
      description:
        "Finds, scores and routes public-sector opportunities. All /v1 routes require a tenant API key.",
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Opportunity: s(Opportunity),
        FirmProfile: s(FirmProfile),
        Match: s(Match),
        Decision: s(Decision),
        RfpPilotHandoff: s(RfpPilotHandoff),
      },
    },
    paths: {
      "/v1/profiles": {
        get: {
          summary: "List this tenant's profiles",
          security: auth,
          responses: { 200: { description: "Profiles" } },
        },
      },
      "/v1/profiles/{profileId}": {
        get: {
          summary: "Get a profile",
          security: auth,
          parameters: [pid],
          responses: { 200: { description: "Profile" }, 404: { description: "Not found" } },
        },
        put: {
          summary: "Create or replace a profile",
          security: auth,
          parameters: [pid],
          requestBody: { content: { "application/json": { schema: s(ProfileInput) } } },
          responses: { 200: { description: "Saved" } },
        },
      },
      "/v1/profiles/{profileId}/matches": {
        get: {
          summary: "Scored matches with the opportunity and the reasons for each score",
          security: auth,
          parameters: [
            pid,
            {
              name: "band",
              in: "query",
              schema: { type: "string" },
              description: "Comma-separated: strong,possible,weak,excluded",
            },
            { name: "lane", in: "query", schema: { type: "string", enum: ["bid", "intel"] } },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 500 } },
          ],
          responses: { 200: { description: "Matches" } },
        },
      },
      "/v1/profiles/{profileId}/decisions": {
        post: {
          summary: "Record pursue / pass / watch",
          security: auth,
          parameters: [pid],
          requestBody: { content: { "application/json": { schema: s(DecisionInput) } } },
          responses: { 200: { description: "Saved decision" } },
        },
      },
      "/v1/profiles/{profileId}/second-look": {
        get: {
          summary: "Passed, changed and near-miss items for a second reviewer",
          security: auth,
          parameters: [pid],
          responses: { 200: { description: "Items" } },
        },
      },
      "/v1/profiles/{profileId}/digest": {
        get: {
          summary: "Daily digest as JSON, plain text (SMS) or Markdown (email)",
          security: auth,
          parameters: [
            pid,
            { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "format", in: "query", schema: { type: "string", enum: ["json", "text", "markdown"] } },
          ],
          responses: { 200: { description: "Digest" } },
        },
      },
      "/v1/profiles/{profileId}/opportunities/{opportunityId}/handoff": {
        get: {
          summary: "The payload RFP Pilot consumes to open a solicitation workspace",
          security: auth,
          parameters: [
            pid,
            { name: "opportunityId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "Handoff",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RfpPilotHandoff" } } },
            },
          },
        },
      },
      "/v1/opportunities/{opportunityId}": {
        get: {
          summary: "One opportunity with provenance",
          security: auth,
          parameters: [{ name: "opportunityId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Opportunity" } },
        },
      },
    },
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date().toISOString());
  const app = Fastify({
    logger: deps.logger ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 256 * 1024,
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/openapi.json", async () => openApiDocument());

  // Every tenant route lives inside this plugin, so the auth hook applies by route registration, not by
  // matching the raw URL string (which percent-encoding could get around).
  app.register(
    async (v1) => {
      v1.decorateRequest("tenantId", "");
      v1.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
        const header = req.headers.authorization;
        const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
        const tenant = deps.auth.tenantFor(key);
        if (!tenant) return reply.code(401).send({ error: "unauthorized" });
        req.tenantId = tenant;
      });
      registerTenantRoutes(v1, deps.repo, now);
    },
    { prefix: "/v1" },
  );

  return app;
}

function registerTenantRoutes(app: FastifyInstance, repo: Repository, now: () => string) {
  const tenantOf = (req: FastifyRequest) => {
    // Defense in depth: the hook guarantees this, but never run a tenant query with an empty tenant.
    if (!req.tenantId) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    return req.tenantId;
  };
  const profileOr404 = async (tenantId: string, profileId: string) => {
    const p = await repo.getProfile(tenantId, profileId);
    if (!p) throw new NotFoundError("Profile");
    return p;
  };

  app.get("/profiles", async (req) => ({ profiles: await repo.listProfiles(tenantOf(req)) }));

  app.get("/profiles/:profileId", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    return profileOr404(tenantOf(req), profileId);
  });

  app.put("/profiles/:profileId", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    const body = ProfileInput.parse(req.body);
    const profile = FirmProfile.parse({ ...body, id: profileId, tenantId: tenantOf(req) });
    await repo.upsertProfile(profile, now());
    return profile;
  });

  app.get("/profiles/:profileId/matches", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    const q = MatchesQuery.parse(req.query);
    const tenantId = tenantOf(req);
    const matches = await repo.listMatches(tenantId, profileId, {
      bands: q.band ?? ["strong", "possible"],
      lane: q.lane,
      firstGoodSince: q.since,
      activeAt: now(),
      limit: q.limit,
    });
    const opps = await repo.getOpportunities(matches.map((m) => m.opportunityId));
    return {
      matches: matches
        .filter((m) => opps.has(m.opportunityId))
        .map((m) => ({ match: m, opportunity: opps.get(m.opportunityId)! })),
    };
  });

  app.post("/profiles/:profileId/decisions", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    const body = DecisionInput.parse(req.body);
    return repo.saveDecision(tenantOf(req), { ...body, profileId, decidedAt: now() });
  });

  app.get("/profiles/:profileId/second-look", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    const tenantId = tenantOf(req);
    const at = now();
    const matches = await repo.listMatches(tenantId, profileId, {
      bands: ["strong", "possible", "weak"],
      activeAt: at,
      limit: 5000,
    });
    const decisions = await repo.listDecisions(tenantId, profileId);
    const opps = await repo.getOpportunities(matches.map((m) => m.opportunityId));
    const items = secondLook({
      opportunities: opps,
      matches,
      decisions,
      hashAtDecision: new Map(decisions.map((d) => [d.opportunityId, d.hashAtDecision])),
      now: at,
    });
    return { items };
  });

  app.get("/profiles/:profileId/digest", async (req, reply) => {
    const { profileId } = ProfileId.parse(req.params);
    const q = DigestQuery.parse(req.query);
    const tenantId = tenantOf(req);
    await profileOr404(tenantId, profileId);
    const at = now();
    // Read-only view: defaults to "since the last delivered digest" (or 24 hours) and does not record a run.
    const since =
      q.since ??
      (await repo.lastDigestAt(tenantId, profileId)) ??
      new Date(Date.parse(at) - 86_400_000).toISOString();
    const digest = await buildDigest(repo, tenantId, profileId, { since, now: at });
    if (q.format === "text") return reply.type("text/plain; charset=utf-8").send(renderDigestText(digest));
    if (q.format === "markdown")
      return reply.type("text/markdown; charset=utf-8").send(renderDigestMarkdown(digest));
    return digest;
  });

  app.get("/profiles/:profileId/opportunities/:opportunityId/handoff", async (req) => {
    const { profileId } = ProfileId.parse(req.params);
    const { opportunityId } = z.object({ opportunityId: z.string().min(3) }).parse(req.params);
    const tenantId = tenantOf(req);
    const match = await repo.getMatch(tenantId, profileId, opportunityId);
    const opp = await repo.getOpportunity(opportunityId);
    if (!match || !opp) throw new NotFoundError("Match");
    return toHandoff(opp, match, tenantId);
  });

  app.get("/opportunities/:opportunityId", async (req) => {
    tenantOf(req);
    const { opportunityId } = z.object({ opportunityId: z.string().min(3) }).parse(req.params);
    const opp = await repo.getOpportunity(opportunityId);
    if (!opp) throw new NotFoundError("Opportunity");
    return opp;
  });
}
