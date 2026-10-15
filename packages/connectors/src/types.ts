import type { NoticeKind, Opportunity, SourceId } from "@radar/core";

export interface FetchWindow {
  /** Only return records posted or modified on/after this instant, when the source supports it. */
  since?: string;
  /** Hard cap on records per run, to bound cost and load on the source. */
  maxRecords?: number;
}

export interface ConnectorRun {
  source: SourceId;
  opportunities: Opportunity[];
  /** Records the source returned that could not be normalized; kept for diagnosis, never silently dropped. */
  rejected: { sourceRecordId: string | null; error: string }[];
  fetchedAt: string;
  /**
   * True when the run saw the source's full current list (no page cap or record cap hit, no page failed).
   * Only complete runs may close records that disappeared from the source.
   */
  complete: boolean;
  /**
   * Records this run could only fetch partially (e.g. a Florida ad whose detail request failed). The pipeline
   * keeps the stored version of these instead of overwriting richer data with a thinner copy.
   */
  partialIds?: string[];
}

export interface SourceConnector {
  readonly id: SourceId;
  /** Key into docs/SOURCES.md describing the collection basis. */
  readonly basis: string;
  fetch(window?: FetchWindow): Promise<ConnectorRun>;
}

/**
 * Derives a notice kind from leading acronyms in a title or solicitation number, for sources that do not
 * label notice types. Conservative: returns null rather than guessing.
 */
export function kindFromText(...texts: (string | null | undefined)[]): NoticeKind | null {
  const t = ` ${texts.filter(Boolean).join(" ").toUpperCase()} `;
  const rules: [RegExp, NoticeKind][] = [
    [/\b(RFQUAL|RFSOQ|SOQ|RSOQ|RFQS)\b|STATEMENTS? OF QUALIFICATIONS/, "soq"],
    [/\bITN\b|INVITATION TO NEGOTIATE/, "itn"],
    [/\bRFI\b|REQUEST FOR INFORMATION/, "rfi"],
    [/\bRFP\b|REQUEST FOR PROPOSALS?|\bRFO\b|REQUEST FOR OFFERS?/, "rfp"],
    [/\bRFQ\b|REQUEST FOR QUOT/, "rfq"],
    [/\b(ITB|IFB)\b|INVITATION (TO|FOR) BIDS?/, "itb"],
  ];
  // The earliest mention wins: "RFP ... (see the prior Request for Information)" is an RFP.
  let best: { at: number; kind: NoticeKind } | null = null;
  for (const [re, kind] of rules) {
    const m = re.exec(t);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, kind };
  }
  return best?.kind ?? null;
}

export function opportunityId(source: SourceId, sourceRecordId: string): string {
  return `${source}:${sourceRecordId}`;
}
