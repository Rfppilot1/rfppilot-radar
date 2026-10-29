/**
 * Local demo API for building and screenshotting the web app without a database or live sources.
 * Every record here is synthetic (ids start with "demo:"); it never runs in staging or production.
 *
 *   pnpm --filter @radar/api demo      # API on :8090, tenant "isf", key below
 */
import { readFileSync } from "node:fs";
import type { FirmProfile, Opportunity } from "@radar/core";
import { MemoryRepository, rescoreProfile } from "@radar/store";
import { ApiKeyAuth, buildApp } from "../src/index.js";

const NOW = process.env.RADAR_NOW ?? "2026-10-20T14:00:00.000Z";
const KEY = "demo-key-0123456789abcdef";

const TITLES: [string, string, string][] = [
  ["Organizational Assessment and Strategic Planning Services", "itn", "801015"],
  ["Management Consulting Services for Process Improvement", "rfp", "801015"],
  ["Program Evaluation and Performance Measurement", "rfp", "801016"],
  ["Strategic Plan Update and Community Engagement", "rfq", "801015"],
  ["Operational Efficiency Study", "rfp", "801015"],
  ["Change Management and Training Services", "itn", "801016"],
  ["IT Strategic Plan and Systems Assessment", "rfp", "811115"],
  ["Grant Management Consulting Services", "rfq", "801015"],
  ["Organizational Staffing and Compensation Study", "rfp", "801016"],
  ["Customer Experience Assessment", "rfi", "801015"],
];

const BUYERS: [string, "state" | "local", "FL" | "TX"][] = [
  ["Agency for Health Care Administration", "state", "FL"],
  ["Florida Department of Transportation", "state", "FL"],
  ["Department of Management Services", "state", "FL"],
  ["Orange County Board of County Commissioners", "local", "FL"],
  ["City of Orlando", "local", "FL"],
  ["School District of Palm Beach County", "local", "FL"],
  ["Hillsborough County", "local", "FL"],
  ["City of Tampa", "local", "FL"],
  ["Miami-Dade County", "local", "FL"],
  ["Broward County Public Schools", "local", "FL"],
  ["City of Tallahassee", "local", "FL"],
  ["JEA", "local", "FL"],
  ["Pinellas County", "local", "FL"],
  ["University of Central Florida", "local", "FL"],
  ["Seminole County Public Schools", "local", "FL"],
  ["Lee County", "local", "FL"],
  ["Volusia County", "local", "FL"],
  ["Texas Health and Human Services Commission", "state", "TX"],
  ["Texas Department of Transportation", "state", "TX"],
  ["City of Houston", "local", "TX"],
  ["Harris County", "local", "TX"],
  ["City of Austin", "local", "TX"],
  ["Dallas County", "local", "TX"],
  ["City of San Antonio", "local", "TX"],
  ["Fort Worth Independent School District", "local", "TX"],
  ["Travis County", "local", "TX"],
  ["City of El Paso", "local", "TX"],
  ["Lubbock County", "local", "TX"],
  ["Regional Mobility Authority", "local", "TX"],
];

const FED = [
  "Department of Veterans Affairs",
  "Federal Emergency Management Agency",
  "Department of the Army",
];

function opp(i: number): Opportunity {
  const [title, kind, unspsc] = TITLES[i % TITLES.length]!;
  const federal = i % 11 === 10;
  const [buyer, level, state] = federal
    ? [FED[i % FED.length]!, "federal" as const, i % 2 ? "FL" : "TX"]
    : BUYERS[(i * 7) % BUYERS.length]!;
  const due = new Date(Date.parse(NOW) + (2 + ((i * 5) % 40)) * 86_400_000);
  due.setUTCHours(19, 0, 0, 0);
  return {
    id: `demo:${1000 + i}`,
    source: federal ? "sam-gov" : state === "FL" ? "fl-mfmp" : "tx-esbd",
    sourceRecordId: String(1000 + i),
    solicitationNumber: `${kind.toUpperCase()} 26-${String(100 + i)}`,
    title,
    description: "Synthetic demo record.",
    kind: kind as Opportunity["kind"],
    kindLabel: null,
    status: "open",
    buyer: { name: buyer, id: null, level },
    state,
    postedAt: new Date(Date.parse(NOW) - ((i * 3) % 12) * 86_400_000).toISOString(),
    dueAt: due.toISOString(),
    dueTimezone: state === "TX" ? "America/Chicago" : "America/New_York",
    codes: federal
      ? [{ system: "NAICS", code: "541611", description: null }]
      : [{ system: "UNSPSC", code: `${unspsc}00`, description: null }],
    setAside: null,
    contact: { name: "Procurement Office", email: "procurement@example.gov", phone: null },
    documents: [
      {
        filename: `${kind.toUpperCase()} 26-${100 + i}.pdf`,
        url: "https://example.gov/doc.pdf",
        description: null,
        postedAt: null,
      },
    ],
    version: 1,
    hasAddendum: i % 6 === 0,
    keyDates:
      i % 4 === 0
        ? [
            {
              kind: "pre_bid",
              date: due.toISOString().slice(0, 10),
              time: "10:00 AM",
              mandatory: i % 8 === 0,
              note: "Pre-bid meeting.",
            },
          ]
        : [],
    estimatedValue:
      i % 3 === 0
        ? { amount: 150_000 + ((i * 97_000) % 2_400_000), basis: "agency_estimate", text: null }
        : null,
    provenance: {
      source: federal ? "sam-gov" : state === "FL" ? "fl-mfmp" : "tx-esbd",
      sourceUrl: "https://example.gov/notice",
      fetchedAt: NOW,
      contentHash: i.toString(16).padStart(2, "0").repeat(32),
      basis: "demo",
    },
  };
}

const repo = new MemoryRepository();
await repo.upsertOpportunities(
  Array.from({ length: 90 }, (_, i) => opp(i)),
  NOW,
);
const profile = JSON.parse(
  readFileSync(new URL("../../../profiles/isf.example.json", import.meta.url), "utf8"),
) as FirmProfile;
await repo.upsertProfile(profile, NOW);
await rescoreProfile(repo, profile, NOW);
const app = buildApp({
  repo,
  auth: new ApiKeyAuth([{ tenantId: profile.tenantId, key: KEY }]),
  now: () => NOW,
});
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8090) });
console.log(`Demo API on :8090 with synthetic data. RADAR_API_KEY=${KEY} RADAR_PROFILE_ID=${profile.id}`);
