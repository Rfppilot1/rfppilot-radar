import { z } from "zod";
import type { Match, Opportunity } from "./schema.js";

/**
 * The contract for "Send to RFP Pilot": what Radar hands RFP Pilot to open a solicitation workspace.
 *
 * Versioned so both sides can evolve independently. Documents are referenced by their original public
 * URL and original filename; Radar never merges, renames or converts a buyer's files.
 */
export const HANDOFF_VERSION = "1.0";

export const RfpPilotHandoff = z.object({
  handoffVersion: z.literal(HANDOFF_VERSION),
  radarOpportunityId: z.string(),
  tenantId: z.string(),
  solicitation: z.object({
    title: z.string(),
    solicitationNumber: z.string().nullable(),
    buyerName: z.string(),
    buyerLevel: z.enum(["federal", "state", "local", "other"]),
    state: z.string().nullable(),
    noticeType: z.string(),
    postedAt: z.string().nullable(),
    dueAt: z.string().nullable(),
    dueTimezone: z.string().nullable(),
    codes: z.array(z.object({ system: z.string(), code: z.string(), description: z.string().nullable() })),
    setAside: z.string().nullable(),
    contact: z
      .object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() })
      .nullable(),
    sourceUrl: z.string().url(),
  }),
  documents: z.array(
    z.object({
      originalFilename: z.string().nullable(),
      url: z.string().url(),
      description: z.string().nullable(),
    }),
  ),
  fit: z.object({
    score: z.number(),
    band: z.string(),
    reasons: z.array(z.string()),
    scorerVersion: z.string(),
  }),
  provenance: z.object({ source: z.string(), fetchedAt: z.string(), contentHash: z.string() }),
});
export type RfpPilotHandoff = z.infer<typeof RfpPilotHandoff>;

export function toHandoff(opp: Opportunity, match: Match, tenantId: string): RfpPilotHandoff {
  return RfpPilotHandoff.parse({
    handoffVersion: HANDOFF_VERSION,
    radarOpportunityId: opp.id,
    tenantId,
    solicitation: {
      title: opp.title,
      solicitationNumber: opp.solicitationNumber,
      buyerName: opp.buyer.name,
      buyerLevel: opp.buyer.level,
      state: opp.state,
      noticeType: opp.kindLabel ?? opp.kind,
      postedAt: opp.postedAt,
      dueAt: opp.dueAt,
      dueTimezone: opp.dueTimezone,
      codes: opp.codes,
      setAside: opp.setAside,
      contact: opp.contact,
      sourceUrl: opp.provenance.sourceUrl,
    },
    documents: opp.documents.map((d) => ({
      originalFilename: d.filename,
      url: d.url,
      description: d.description,
    })),
    fit: {
      score: match.score,
      band: match.band,
      reasons: match.reasons.map((r) => `${r.points >= 0 ? "+" : ""}${r.points} ${r.detail}`),
      scorerVersion: match.scorerVersion,
    },
    provenance: {
      source: opp.provenance.source,
      fetchedAt: opp.provenance.fetchedAt,
      contentHash: opp.provenance.contentHash,
    },
  });
}
