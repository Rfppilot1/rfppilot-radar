import { FirmProfile, type Opportunity } from "@radar/core";
import { describe, expect, it } from "vitest";
import { AnthropicReviewer } from "../src/anthropic-reviewer.js";

describe("AnthropicReviewer", () => {
  it("calls the Messages API with the review prompt and parses the verdict", async () => {
    let body: { model: string; messages: { content: string }[] } | undefined;
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      headers = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"verdict":"fit","rationale":"Evaluation study."}' }],
        }),
      );
    }) as unknown as typeof fetch;
    const r = new AnthropicReviewer("sk-test", "test-model", fetchImpl);
    const opp = {
      title: "Healthy SNAP Evaluation",
      buyer: { name: "DCF", id: null, level: "state" },
      state: "FL",
      kind: "rfi",
      kindLabel: "Request for Information",
      codes: [],
      description: null,
    } as unknown as Opportunity;
    const v = await r.review(
      opp,
      FirmProfile.parse({
        id: "p1",
        tenantId: "t1",
        name: "Firm",
        states: ["FL"],
        codes: [],
        capabilities: [{ phrase: "program evaluation" }],
      }),
    );
    expect(v).toEqual({ verdict: "fit", rationale: "Evaluation study.", reviewer: "Claude (test-model)" });
    expect(body?.model).toBe("test-model");
    expect(body?.messages[0]?.content).toContain("Healthy SNAP Evaluation");
    expect(headers["x-api-key"]).toBe("sk-test");
  });
});
