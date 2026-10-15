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

export class HttpClient {
  private readonly lastByHost = new Map<string, number>();
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
      await this.throttle(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
      let status: number;
      let body: string;
      let retryAfter: number;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { "user-agent": this.opts.userAgent, ...(init.headers ?? {}) },
        });
        status = res.status;
        retryAfter = Number(res.headers.get("retry-after"));
        body = await res.text();
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await this.sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) return body;
      const transient = status === 429 || status >= 500;
      if (!transient || attempt >= maxRetries) throw new HttpError(status, url, body.slice(0, 500));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      await this.sleep(Math.min(MAX_RETRY_AFTER_MS, wait));
    }
  }

  private async throttle(url: string): Promise<void> {
    const host = new URL(url).host;
    const min = this.opts.minIntervalMs ?? 1000;
    const last = this.lastByHost.get(host) ?? 0;
    const wait = last + min - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastByHost.set(host, Date.now());
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** Removes API keys from URLs before they reach logs or error messages. */
export function redact(url: string): string {
  return url.replace(/([?&](api_key|apikey|key|token)=)[^&]+/gi, "$1***");
}
