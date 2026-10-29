import "server-only";
import type { Decision, FirmProfile, Match, Opportunity } from "@radar/core";

/**
 * Server-side client for the Radar API. The key lives only in the web server's environment and is never sent
 * to the browser: pages are rendered on the server and Yes/No answers go through a server action.
 */
export interface MatchItem {
  match: Match & { firstMatchedAt: string; firstGoodAt?: string | null };
  opportunity: Opportunity;
}

export interface Glance {
  screened: number;
  strong: number;
  possible: number;
  notFit: number;
  bySource: Record<string, number>;
}

/** Matches fetched per load. The API says when there are more (`truncated`); pages then mark figures as partial. */
export const API_PAGE_LIMIT = 2000;

function config() {
  const url = process.env.RADAR_API_URL;
  const key = process.env.RADAR_API_KEY;
  const profileId = process.env.RADAR_PROFILE_ID;
  if (!url || !key || !profileId)
    throw new Error("RADAR_API_URL, RADAR_API_KEY and RADAR_PROFILE_ID must be set for the web app");
  return { url, key, profileId };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, key } = config();
  const res = await fetch(new URL(path, url), {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Radar API ${res.status} on ${path}`);
  return (await res.json()) as T;
}

const pid = () => encodeURIComponent(config().profileId);

export async function getProfile(): Promise<FirmProfile> {
  return call<FirmProfile>(`/v1/profiles/${pid()}`);
}

/** Open strong and possible matches (the API returns only open, not-yet-due notices). */
export async function getMatches(): Promise<{ items: MatchItem[]; truncated: boolean }> {
  const r = await call<{ matches: MatchItem[]; truncated?: boolean }>(
    `/v1/profiles/${pid()}/matches?band=strong,possible&limit=${API_PAGE_LIMIT}`,
  );
  return { items: r.matches, truncated: r.truncated ?? r.matches.length >= API_PAGE_LIMIT };
}

export async function getGlance(): Promise<Glance | null> {
  const d = await call<{ glance?: Glance }>(`/v1/profiles/${pid()}/digest?format=json`);
  return d.glance ?? null;
}

export async function getDecisions(): Promise<Pick<Decision, "opportunityId" | "decision">[]> {
  const r = await call<{ decisions: Pick<Decision, "opportunityId" | "decision">[] }>(
    `/v1/profiles/${pid()}/decisions`,
  );
  return r.decisions;
}

export async function recordDecision(
  opportunityId: string,
  decision: "watch" | "pass",
  decidedBy: string,
): Promise<void> {
  await call(`/v1/profiles/${pid()}/decisions`, {
    method: "POST",
    body: JSON.stringify({ opportunityId, decision, reason: null, decidedBy }),
  });
}
