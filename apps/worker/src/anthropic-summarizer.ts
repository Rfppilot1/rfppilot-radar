import { cleanSummary, summaryFacts, summaryPrompt, type Digest } from "@radar/core";

/**
 * Writes the "Today in brief" lines for a digest with the Anthropic Messages API. Enabled only when
 * ANTHROPIC_API_KEY is set; one call per digest.
 *
 * Guard: every number in the summary must appear in the facts it was given. A summary that fails the check is
 * dropped (the email goes out without it) rather than shown with a figure nobody can trace.
 */
export class AnthropicSummarizer {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.RADAR_SUMMARY_MODEL ?? "claude-sonnet-5-5",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async summarize(d: Digest): Promise<string | null> {
    if (!d.newMatches.length && !d.changed?.length && !d.closingSoon.length && !d.strongOpen?.length)
      return null;
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: summaryPrompt(d) }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    const text = (body.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const summary = cleanSummary(text);
    if (!summary) throw new Error(`Summary empty (stop_reason=${body.stop_reason ?? "unknown"})`);
    const untraceable = untraceableNumbers(summary, summaryFacts(d));
    if (untraceable.length)
      throw new Error(`Summary dropped: numbers not in the digest (${untraceable.join(", ")})`);
    return summary;
  }
}

/** Numbers in `summary` that do not appear anywhere in `facts`. */
export function untraceableNumbers(summary: string, facts: string): string[] {
  const known = new Set(facts.match(/\d[\d,]*(?:\.\d+)?/g)?.map((n) => n.replace(/,/g, "")) ?? []);
  return (summary.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((n) => n.replace(/,/g, ""))
    .filter((n) => !known.has(n));
}
