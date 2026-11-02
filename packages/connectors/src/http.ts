/**
 * Polite HTTP client used by every connector: identifies itself, spaces requests per host, times out,
 * and retries only on transient failures (429 and 5xx) with exponential backoff that honors Retry-After.
 */
export interface HttpClientOptions {
  userAgent: string;
  /** Minimum milliseconds between requests to the same host. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Largest response body read, in bytes (default 25 MB). A bigger body fails the request without retry. */
  maxBytes?: number;
  /** Aborts every request (and any pending retry) made through this client, e.g. a per-source deadline. */
  signal?: AbortSignal;
  /**
   * Keep cookies the server sets and send them back on later requests to the same host, for sources that need
   * a session (ASP.NET forms). Off by default: API sources must not carry state between requests.
   */
  cookies?: boolean;
}

export class HttpError extends Error {
  /** The request URL with any API key redacted, safe to log or serialize. */
  readonly url: string;
  constructor(
    readonly status: number,
    url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${redact(url)}`);
    this.name = "HttpError";
    this.url = redact(url);
  }
}

/** Upper bound on a server-requested Retry-After, so a hostile or broken header cannot stall a run. */
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** A failure that retrying cannot fix (oversized body, the client's own deadline). */
export class HttpAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpAbortError";
  }
}

export class HttpClient {
  private readonly lastByHost = new Map<string, number>();
  private readonly jar = new Map<string, Map<string, string>>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const text = await this.text(url, {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Expected JSON from ${redact(url)}, got: ${text.slice(0, 120)}`);
    }
  }

  /** Fetches and reads the whole body under one timeout, retrying only transient failures. */
  async text(url: string, init: RequestInit = {}): Promise<string> {
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      this.checkAborted(url);
      await this.throttle(url);
      this.checkAborted(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
      let status: number;
      let body: string;
      let retryAfter: number;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: this.opts.signal
            ? AbortSignal.any([controller.signal, this.opts.signal])
            : controller.signal,
          headers: { "user-agent": this.opts.userAgent, ...this.cookieHeader(url), ...(init.headers ?? {}) },
        });
        this.keepCookies(url, res);
        status = res.status;
        retryAfter = Number(res.headers.get("retry-after"));
        body = await readCapped(res, this.opts.maxBytes ?? DEFAULT_MAX_BYTES, url);
      } catch (err) {
        if (err instanceof HttpAbortError) throw err;
        this.checkAborted(url);
        if (attempt >= maxRetries) throw err;
        await this.pause(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) return body;
      const transient = status === 429 || status >= 500;
      if (!transient || attempt >= maxRetries) throw new HttpError(status, url, body.slice(0, 500));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      await this.pause(Math.min(MAX_RETRY_AFTER_MS, wait));
    }
  }

  /** Sleeps, but wakes as soon as the client's signal aborts, so a deadline is not overrun by a long wait. */
  private async pause(ms: number): Promise<void> {
    const signal = this.opts.signal;
    if (!signal) return this.sleep(ms);
    if (signal.aborted) return;
    let onAbort = () => {};
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((r) => {
        onAbort = () => r();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    signal.removeEventListener("abort", onAbort);
  }

  /** Drops any cookies held for every host, e.g. to start a fresh server session. */
  clearCookies(): void {
    this.jar.clear();
  }

  private cookieHeader(url: string): Record<string, string> {
    if (!this.opts.cookies) return {};
    const held = this.jar.get(new URL(url).host);
    if (!held || held.size === 0) return {};
    return { cookie: [...held].map(([k, v]) => `${k}=${v}`).join("; ") };
  }

  private keepCookies(url: string, res: Response) {
    if (!this.opts.cookies) return;
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const set = headers.getSetCookie?.() ?? [];
    if (set.length === 0) return;
    const host = new URL(url).host;
    const held = this.jar.get(host) ?? new Map<string, string>();
    for (const line of set) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === "";
      if (expired) held.delete(name);
      else held.set(name, value);
    }
    this.jar.set(host, held);
  }

  private checkAborted(url: string) {
    if (this.opts.signal?.aborted)
      throw new HttpAbortError(`Stopped before ${redact(url)}: source time limit reached`);
  }

  private async throttle(url: string): Promise<void> {
    const host = new URL(url).host;
    const min = this.opts.minIntervalMs ?? 1000;
    const last = this.lastByHost.get(host) ?? 0;
    const wait = last + min - Date.now();
    if (wait > 0) await this.pause(wait);
    this.lastByHost.set(host, Date.now());
  }
}

/** Reads a response body, failing once it passes `max` bytes instead of holding an unbounded body in memory. */
async function readCapped(res: Response, max: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new HttpAbortError(`Response from ${redact(url)} is ${declared} bytes, over the ${max}-byte limit`);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new HttpAbortError(`Response from ${redact(url)} passed the ${max}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** Removes API keys from URLs before they reach logs or error messages. */
export function redact(url: string): string {
  return url.replace(/([?&](api_key|apikey|key|token)=)[^&]+/gi, "$1***");
}
