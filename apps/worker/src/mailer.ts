/**
 * Sends the daily digest by email through Resend (https://resend.com). Enabled when RESEND_API_KEY and
 * RADAR_EMAIL_FROM are set; otherwise the worker only writes digest files.
 */
export interface Mail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** mailto: or https: unsubscribe target, sent as the List-Unsubscribe header. */
  unsubscribe?: string;
  /**
   * Sent as Resend's Idempotency-Key: a retry with the same key within 24 hours returns the first result
   * instead of sending a second email.
   */
  idempotencyKey?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<{ id: string | null; duplicate?: boolean }>;
}

/**
 * Marks every subject from this environment, e.g. "[STAGING]", so a staging email is never mistaken for the
 * real one. Idempotency keys are untouched. A blank prefix returns the mailer as it is.
 */
export function withSubjectPrefix(mailer: Mailer, prefix: string | undefined): Mailer {
  const p = (prefix ?? "").trim().slice(0, 40);
  if (!p) return mailer;
  return { send: (mail) => mailer.send({ ...mail, subject: `${p} ${mail.subject}` }) };
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!apiKey) throw new Error("RESEND_API_KEY is required");
    if (!/@/.test(from))
      throw new Error("RADAR_EMAIL_FROM must be an email address, e.g. Radar <radar@rfppilot.com>");
  }

  /**
   * Sends one email. Transient failures (network, 429, 5xx) are retried with the same idempotency key, so a
   * retry can never deliver twice. A 409 `invalid_idempotent_request` means an email with this key was already
   * accepted (an earlier attempt whose delivery was not recorded): it is reported as sent, `duplicate: true`.
   */
  async send(mail: Mail): Promise<{ id: string | null; duplicate?: boolean }> {
    if (mail.to.length === 0) return { id: null };
    const attempts = mail.idempotencyKey ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.post(mail);
      } catch (err) {
        if (attempt >= attempts) throw err;
        await this.sleep(attempt * 2000);
        continue;
      }
      if (res.ok) {
        const body = (await res.json()) as { id?: string };
        return { id: body.id ?? null };
      }
      const text = await res.text();
      if (res.status === 409 && mail.idempotencyKey && /invalid_idempotent_request/.test(text))
        return { id: null, duplicate: true };
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await this.sleep(attempt * 2000);
        continue;
      }
      throw new Error(`Resend API ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private post(mail: Mail): Promise<Response> {
    return this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(mail.idempotencyKey ? { "idempotency-key": mail.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(mail.unsubscribe ? { headers: { "List-Unsubscribe": `<${mail.unsubscribe}>` } } : {}),
      }),
    });
  }
}

export function digestSubject(
  profileName: string,
  newCount: number,
  closingCount: number,
  dateIso: string,
): string {
  const day = new Date(dateIso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
  const parts = [`${newCount} new`];
  if (closingCount) parts.push(`${closingCount} closing soon`);
  return `Radar ${day}: ${parts.join(", ")} for ${profileName}`;
}

/**
 * Operator-set recipients from RADAR_RECIPIENTS, so addresses never live in the repository or profile files.
 * Format: `tenant/profile=a@x.com,b@y.com;tenant2/profile2=c@z.com`. A profile listed here gets exactly these
 * recipients; a profile not listed keeps the recipients stored with it.
 */
export function parseRecipients(spec: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of (spec ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = entry.indexOf("=");
    const key = entry.slice(0, eq).trim();
    if (eq < 1 || !/^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key))
      throw new Error(`RADAR_RECIPIENTS entry "${entry.slice(0, 40)}" must look like tenant/profile=a@x.com`);
    const emails = entry
      .slice(eq + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const e of emails)
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e))
        throw new Error(`RADAR_RECIPIENTS has an invalid address for ${key}`);
    out.set(key, emails);
  }
  return out;
}

export function recipientsFor(
  overrides: Map<string, string[]>,
  tenantId: string,
  profileId: string,
  stored: string[],
): string[] {
  return overrides.get(`${tenantId}/${profileId}`) ?? stored;
}
