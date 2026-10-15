import { fetchDisasterSignals, type DisasterSignal, type HttpClient } from "@radar/connectors";
import type { DigestSignal } from "@radar/core";

/** Turns FEMA declarations into digest signals. Only Public Assistance declarations drive procurement. */
export function toDigestSignals(signals: DisasterSignal[]): DigestSignal[] {
  return signals
    .filter((s) => s.publicAssistance)
    .map((s) => {
      const counties = s.counties.length
        ? `${s.counties.slice(0, 6).join(", ")}${s.counties.length > 6 ? ` +${s.counties.length - 6} more` : ""}`
        : "statewide";
      const day = new Date(s.declaredAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      return {
        title: `${s.declaration}: ${titleCase(s.title)} (${s.state})`,
        detail: `${s.incidentType}, declared ${day}, Public Assistance open in ${counties}. Recovery, debris and grant-management procurements typically follow.`,
        date: s.declaredAt,
        sourceUrl: s.sourceUrl,
      };
    });
}

export async function recentSignals(
  http: HttpClient,
  states: string[],
  sinceIso: string,
): Promise<DigestSignal[]> {
  const all: DisasterSignal[] = [];
  for (const st of [...new Set(states)]) all.push(...(await fetchDisasterSignals(http, st, sinceIso)));
  return toDigestSignals(all).sort((a, b) => b.date.localeCompare(a.date));
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase());
}
