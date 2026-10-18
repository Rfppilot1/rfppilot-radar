import type { FirmProfileInput, Opportunity } from "../src/index.js";

export const NOW = "2026-10-15T14:00:00.000Z";

export function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "tx-esbd:1",
    source: "tx-esbd",
    sourceRecordId: "1",
    solicitationNumber: "RFP 1",
    title: "Independent Verification and Validation Services",
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
    keyDates: [],
    estimatedValue: null,
    provenance: {
      source: "tx-esbd",
      sourceUrl: "https://www.txsmartbuy.gov/esbd/RFP%201",
      fetchedAt: NOW,
      contentHash: "a".repeat(64),
      basis: "tx-esbd",
    },
    ...over,
  };
}

export const PROFILE: FirmProfileInput = {
  id: "isf-main",
  tenantId: "isf",
  name: "ISF",
  states: ["FL", "TX"],
  codes: [
    { system: "NIGP", prefix: "918", weight: 1, label: "Consulting services" },
    { system: "NAICS", prefix: "541611", weight: 1 },
  ],
  capabilities: [
    { phrase: "independent verification and validation", weight: 1 },
    { phrase: "strategic planning", weight: 1 },
    { phrase: "organizational assessment", weight: 0.8 },
  ],
  exclusions: ["janitorial", "mowing"],
  knownBuyers: ["Health and Human Services Commission"],
  minDaysToRespond: 10,
};
