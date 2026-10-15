import {
  parseVerdict,
  reviewPrompt,
  type FirmProfile,
  type Opportunity,
  type RelevanceReviewer,
  type ReviewVerdict,
} from "@radar/core";

/**
 * RelevanceReviewer backed by the Anthropic Messages API. Enabled only when ANTHROPIC_API_KEY is set.
 * Results should be cached by (opportunity content hash, profile version) by the caller to bound cost.
 */
export class AnthropicReviewer implements RelevanceReviewer {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.RADAR_REVIEW_MODEL ?? "claude-haiku-5-5",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `Claude (${model})`;
  }

  async review(opp: Opportunity, profile: FirmProfile): Promise<ReviewVerdict> {
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 200,
        messages: [{ role: "user", content: reviewPrompt(opp, profile) }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return parseVerdict(text, this.id);
  }
}
