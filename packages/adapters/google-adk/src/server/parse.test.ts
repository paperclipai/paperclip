import { describe, expect, it } from "vitest";
import { parseGoogleAdkJsonl } from "./parse.js";

describe("parseGoogleAdkJsonl", () => {
  it("keeps only the final model message as the summary", () => {
    const stdout = [
      JSON.stringify({
        content: {
          role: "model",
          parts: [{ text: '{"decision":"FREEFORM","user_request":"what is 1+1?"}' }],
        },
      }),
      JSON.stringify({
        content: {
          role: "model",
          parts: [{ text: "1 + 1 = **2**" }],
        },
      }),
    ].join("\n");

    const parsed = parseGoogleAdkJsonl(stdout);

    expect(parsed.summary).toBe("1 + 1 = **2**");
  });

  it("still captures tool calls, tool results, and usage", () => {
    const stdout = [
      JSON.stringify({
        content: {
          role: "model",
          parts: [{ functionCall: { name: "calculator", args: { a: 1, b: 1 } } }],
        },
      }),
      JSON.stringify({
        content: {
          role: "user",
          parts: [{ functionResponse: { name: "calculator", response: { result: 2 } } }],
        },
        usageMetadata: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 },
      }),
      JSON.stringify({
        content: {
          role: "model",
          parts: [{ text: "done" }],
        },
      }),
    ].join("\n");

    const parsed = parseGoogleAdkJsonl(stdout);

    expect(parsed.summary).toBe("done");
    expect(parsed.toolCalls).toEqual([{ name: "calculator", input: { a: 1, b: 1 } }]);
    expect(parsed.toolResults).toEqual([{ name: "calculator", output: { result: 2 } }]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 });
  });

  it("treats compact workflow failure events as run failures", () => {
    const parsed = parseGoogleAdkJsonl([
      JSON.stringify({ event: "intake.completed", node: "facebook_intake", status: "failed" }),
      JSON.stringify({ event: "run.failed", node: "facebook_failure", message: "intake failed" }),
    ].join("\n"));

    expect(parsed.errorMessage).toBe("intake failed");
  });

  it("preserves nested failure details when a terminal event has no message", () => {
    const parsed = parseGoogleAdkJsonl([
      JSON.stringify({ error: { detail: "The image provider rejected the request" } }),
      JSON.stringify({ event: "run.failed", details: { error: { code: "image_provider_error" } } }),
    ].join("\n"));

    expect(parsed.errorMessage).toBe("image_provider_error");
  });

  it("does not replace a prior error with the generic run.failed fallback", () => {
    const parsed = parseGoogleAdkJsonl([
      JSON.stringify({ error: { message: "Missing campaign brief" } }),
      JSON.stringify({ event: "run.failed" }),
    ].join("\n"));

    expect(parsed.errorMessage).toBe("Missing campaign brief");
  });

  it("does not treat advisory messages on successful compact events as errors", () => {
    const parsed = parseGoogleAdkJsonl([
      JSON.stringify({
        event: "ugc.resources.checked",
        node: "facebook_ugc",
        route: "OK",
        status: "missing",
        message: "No Markdown campaigns found; continuing without UGC grounding",
      }),
      JSON.stringify({ event: "run.completed", node: "facebook_complete", status: "success" }),
    ].join("\n"));

    expect(parsed.errorMessage).toBeNull();
  });

  it("preserves the terminal structured workflow result", () => {
    const parsed = parseGoogleAdkJsonl(JSON.stringify({
      event: "run.completed",
      node: "instagram_complete",
      status: "success",
      result: {
        status: "success",
        cms_draft: { post_id: 127 },
      },
    }));

    expect(parsed.finalResult).toEqual({
      status: "success",
      cms_draft: { post_id: 127 },
    });
  });

  it("captures compact grounding sources and their source-specific outcomes as tools", () => {
    const parsed = parseGoogleAdkJsonl([
      JSON.stringify({
        event: "source_grounding.started",
        node: "social_media_grounding_agent",
        details: { platform: "instagram", sources: ["partnerpal"], mode: "campaign_planning" },
      }),
      JSON.stringify({
        event: "source_grounding.completed",
        node: "instagram_grounding",
        status: "ok",
        details: {
          sources: ["partnerpal"],
          outcomes: {
            partnerpal: {
              status: "ok",
              query: "campaign activation ideas",
              matches: 1,
              items: [{ excerpt: "A practical campaign activation idea." }],
            },
          },
        },
      }),
    ].join("\n"));

    expect(parsed.toolCalls).toEqual([{
      name: "partnerpal",
      input: { platform: "instagram", mode: "campaign_planning" },
    }]);
    expect(parsed.toolResults).toEqual([{
      name: "partnerpal",
      output: expect.objectContaining({
        query: "campaign activation ideas",
        matches: 1,
        items: [{ excerpt: "A practical campaign activation idea." }],
      }),
    }]);
  });
});
