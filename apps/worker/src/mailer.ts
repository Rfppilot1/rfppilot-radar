/**
 * Sends the daily digest by email through Resend (https://resend.com). Enabled when RESEND_API_KEY and
 * RADAR_EMAIL_FROM are set; otherwise the worker only writes digest files.
 */
export interface Mail {
  to: string[];
  subject: string;
  html: string;
  text: string;
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
