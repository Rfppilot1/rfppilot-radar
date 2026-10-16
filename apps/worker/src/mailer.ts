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
}

export interface Mailer {
  send(mail: Mail): Promise<{ id: string | null }>;
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error("RESEND_API_KEY is required");
    if (!/@/.test(from))
      throw new Error("RADAR_EMAIL_FROM must be an email address, e.g. Radar <radar@rfppilot.com>");
  }

  async send(mail: Mail): Promise<{ id: string | null }> {
    if (mail.to.length === 0) return { id: null };
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
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
    if (!res.ok) throw new Error(`Resend API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { id?: string };
    return { id: body.id ?? null };
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
