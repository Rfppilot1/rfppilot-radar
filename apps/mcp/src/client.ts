/** Thin, typed HTTP client for the Radar API. The MCP server and the RFP Pilot integration both use it. */
export class RadarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    if (!apiKey) throw new Error("RADAR_API_KEY is required");
  }

  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return this.send<T>(u, { method: "GET" });
  }

  async getText(path: string, query: Record<string, string | undefined> = {}): Promise<string> {
    const u = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v) u.searchParams.set(k, v);
    const res = await this.fetchImpl(u, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Radar API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.text();
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.send<T>(new URL(path, this.baseUrl), { method: "POST", body: JSON.stringify(body) });
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
  }

  private async send<T>(u: URL, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(u, {
      ...init,
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Radar API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}
