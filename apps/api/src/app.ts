import {
  Decision,
  FEEDBACK_REASON_MAX,
  FirmProfile,
  Match,
  Opportunity,
  RfpPilotHandoff,
  renderDigestMarkdown,
  renderDigestText,
  secondLook,
  toHandoff,
  resolveScoring,
  verifyFeedbackToken,
  voteToDecision,
  decisionToVote,
  type FeedbackVote,
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
  /** Secret for the email yes/no links (RADAR_FEEDBACK_SECRET). Without it the /feedback pages are off. */
  feedbackSecret?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

/** Email delivery is set by an operator (worker CLI), never through the tenant API, so a key holder cannot
 * make Radar send mail to arbitrary addresses. */
const ProfileInput = FirmProfile.omit({ id: true, tenantId: true, delivery: true });
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
    logger: deps.logger
      ? {
          redact: ["req.headers.authorization"],
          // Feedback links carry a signed token in the query string; never write it to the logs.
          serializers: {
            req: (req: { method: string; url: string; id?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url.replace(/([?&]token=)[^&]*/g, "$1[redacted]"),
            }),
          },
        }
      : false,
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
  if (deps.feedbackSecret) registerFeedbackRoutes(app, deps.repo, deps.feedbackSecret, now);
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
    const body = ProfileInput.strict().parse(req.body);
    const tenantId = tenantOf(req);
    const existing = await repo.getProfile(tenantId, profileId);
    const profile = FirmProfile.parse({ ...body, id: profileId, tenantId, delivery: existing?.delivery });
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
    const profile = await repo.getProfile(tenantId, profileId);
    const items = secondLook({
      opportunities: opps,
      matches,
      decisions,
      hashAtDecision: new Map(decisions.map((d) => [d.opportunityId, d.hashAtDecision])),
      now: at,
      possibleCutoff: profile ? resolveScoring(profile).bands.possible : undefined,
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

const FeedbackQuery = z.object({ token: z.string().max(2000), v: z.enum(["yes", "no"]).optional() });
const FeedbackForm = z.object({
  token: z.string().max(2000),
  vote: z.enum(["yes", "no"]),
  reason: z
    .string()
    .max(FEEDBACK_REASON_MAX * 4)
    .optional()
    .transform((r) => {
      const t = (r ?? "").replace(/\s+/g, " ").trim().slice(0, FEEDBACK_REASON_MAX);
      return t || null;
    }),
});

/**
 * Public yes/no pages behind the signed links in the email. GET only shows the form (mail scanners open every
 * link, so opening one must never count as a vote); POST records the vote as a decision for that profile.
 * The token fixes tenant, profile, opportunity and recipient, so the form cannot be pointed elsewhere.
 */
function registerFeedbackRoutes(app: FastifyInstance, repo: Repository, secret: string, now: () => string) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  const page = (reply: FastifyReply, status: number, title: string, inner: string) =>
    reply
      .code(status)
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(feedbackPage(title, inner));
  const invalid = (reply: FastifyReply) =>
    page(
      reply,
      400,
      "Link expired",
      `<p>This feedback link is invalid or has expired. Use the buttons in a recent Radar email.</p>`,
    );

  const load = async (token: string) => {
    const c = verifyFeedbackToken(token, secret, now());
    if (!c) return null;
    const profile = await repo.getProfile(c.t, c.p);
    const opp = profile ? await repo.getOpportunity(c.o) : null;
    if (!profile || !opp) return null;
    const match = await repo.getMatch(c.t, c.p, c.o).catch(() => null);
    const prior = (await repo.listDecisions(c.t, c.p)).find((d) => d.opportunityId === c.o) ?? null;
    return { c, profile, opp, match, prior };
  };

  app.get("/feedback", async (req, reply) => {
    const q = FeedbackQuery.safeParse(req.query);
    const ctx = q.success ? await load(q.data.token) : null;
    if (!q.success || !ctx) return invalid(reply);
    const chosen: FeedbackVote | undefined =
      q.data.v ?? (ctx.prior ? decisionToVote(ctx.prior.decision) : undefined);
    return page(reply, 200, "Is this a good fit?", feedbackForm(ctx, q.data.token, chosen));
  });

  app.post("/feedback", async (req, reply) => {
    const f = FeedbackForm.safeParse(req.body);
    const ctx = f.success ? await load(f.data.token) : null;
    if (!f.success || !ctx) return invalid(reply);
    await repo.saveDecision(ctx.c.t, {
      opportunityId: ctx.c.o,
      profileId: ctx.c.p,
      decision: voteToDecision(f.data.vote),
      reason: f.data.reason,
      decidedBy: ctx.c.r,
      decidedAt: now(),
    });
    const msg =
      f.data.vote === "yes"
        ? "Thanks. Radar will keep tracking this bid and will learn from your answer."
        : "Thanks. Radar will stop showing this bid (unless the posting changes) and will learn from your answer.";
    return page(
      reply,
      200,
      "Thanks",
      `<p><b>${esc(ctx.opp.title)}</b></p><p>${esc(msg)}</p>` +
        `<p><a href="/feedback?token=${encodeURIComponent(f.data.token)}">Change your answer</a></p>`,
    );
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function feedbackForm(
  ctx: {
    opp: Opportunity;
    match: Match | null;
    profile: FirmProfile;
    prior: { decision: Decision["decision"]; reason: string | null } | null;
  },
  token: string,
  chosen?: FeedbackVote,
): string {
  const o = ctx.opp;
  const due = o.dueAt
    ? new Date(o.dueAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
      })
    : "no due date";
  const fit = ctx.match ? ` · fit ${Math.round(ctx.match.score)}` : "";
  const radio = (v: FeedbackVote, label: string) =>
    `<label class="opt"><input type="radio" name="vote" value="${v}" required${chosen === v ? " checked" : ""}> ${label}</label>`;
  return (
    `<p class="muted">${esc(ctx.profile.name)}</p>` +
    `<h2><a href="${/^https:\/\//.test(o.provenance.sourceUrl) ? esc(o.provenance.sourceUrl) : "#"}" rel="noopener">${esc(o.title)}</a></h2>` +
    `<p class="muted">${esc(o.buyer.name)} · due ${esc(due)}${esc(fit)}</p>` +
    (ctx.prior
      ? `<p class="note">You already answered: ${ctx.prior.decision === "pass" ? "No" : "Yes"}. You can change it below.</p>`
      : "") +
    `<form method="post" action="/feedback">` +
    `<input type="hidden" name="token" value="${esc(token)}">` +
    `<p><b>Is this a good fit for you?</b></p>` +
    radio("yes", "Yes, good fit") +
    radio("no", "No, not a fit") +
    `<p><label for="reason"><b>Why?</b> <span class="muted">(optional, one sentence; it helps Radar learn)</span></label></p>` +
    `<textarea id="reason" name="reason" maxlength="${FEEDBACK_REASON_MAX}" rows="3" placeholder="e.g. We don't do construction oversight, or: exactly our IV&amp;V work">${esc(ctx.prior?.reason ?? "")}</textarea>` +
    `<p><button type="submit">Save answer</button></p>` +
    `</form>`
  );
}

function feedbackPage(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · RFP Pilot Radar</title><style>
body{margin:0;background:#F4F9FD;color:#1B2433;font:15px/1.5 Inter,Segoe UI,Arial,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:16px}
.head{background:linear-gradient(135deg,#1795C3,#1A75C8 55%,#0E2F6C);color:#fff;border-radius:10px;padding:12px 16px}
.head small{display:block;font-size:11px;letter-spacing:1.5px;color:#7FE3F5;font-weight:700}
.card{background:#fff;border:1px solid #D3E1EC;border-radius:10px;padding:16px;margin-top:12px}
h2{font-size:17px;margin:4px 0}h2 a{color:#0E2F6C;text-decoration:none}
.muted{color:#556175;font-size:13px;margin:2px 0}.note{background:#E8F1FB;border-radius:6px;padding:6px 10px;font-size:13px}
.opt{display:block;border:1px solid #D3E1EC;border-radius:8px;padding:10px 12px;margin:6px 0;cursor:pointer}
textarea{width:100%;box-sizing:border-box;border:1px solid #B8C9D9;border-radius:8px;padding:8px;font:inherit}
button{background:#1A75C8;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}
</style></head><body><div class="wrap"><div class="head"><small>RFP PILOT RADAR</small>${esc(title)}</div><div class="card">${inner}</div></div></body></html>`;
}
