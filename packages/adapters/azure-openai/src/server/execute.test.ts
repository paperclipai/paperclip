import { describe, expect, it } from "vitest";
import { buildRequestUrl, buildChatMessages, parseChatCompletionStream } from "./execute.js";
import { computeCostUsd, resolveModelPrice } from "./pricing.js";

describe("buildRequestUrl", () => {
  it("formats an Azure OpenAI deployment URL", () => {
    expect(
      buildRequestUrl({
        endpoint: "https://my-resource.openai.azure.com/",
        deployment: "gpt-4o",
        apiVersion: "2024-10-21",
        deploymentKind: "azure_openai",
      }),
    ).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    );
  });

  it("URL-encodes deployment names with special characters", () => {
    const url = buildRequestUrl({
      endpoint: "https://x.openai.azure.com",
      deployment: "my dep/1",
      apiVersion: "2024-10-21",
      deploymentKind: "azure_openai",
    });
    expect(url).toContain("/deployments/my%20dep%2F1/");
  });

  it("uses the flat Foundry serverless URL when deploymentKind is azure_ai_foundry", () => {
    expect(
      buildRequestUrl({
        endpoint: "https://my-proj.eastus2.inference.ai.azure.com/",
        deployment: "",
        apiVersion: "irrelevant",
        deploymentKind: "azure_ai_foundry",
      }),
    ).toBe("https://my-proj.eastus2.inference.ai.azure.com/chat/completions");
  });
});

describe("buildChatMessages", () => {
  it("omits the system message when systemPrompt is blank", () => {
    expect(buildChatMessages({ systemPrompt: "   ", prompt: "hi" })).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("prepends the system message when provided", () => {
    expect(buildChatMessages({ systemPrompt: "You are a bot.", prompt: "hi" })).toEqual([
      { role: "system", content: "You are a bot." },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("parseChatCompletionStream", () => {
  function toStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  it("accumulates content deltas and reports usage from the final frame", async () => {
    const frames = [
      `data: ${JSON.stringify({
        model: "gpt-4o-2024-08-06",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: ", world" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const deltas: string[] = [];
    const parsed = await parseChatCompletionStream(toStream(frames), (d) => {
      deltas.push(d);
    });
    expect(deltas.join("")).toBe("Hello, world");
    expect(parsed.outputText).toBe("Hello, world");
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.reportedModel).toBe("gpt-4o-2024-08-06");
    expect(parsed.usage?.prompt_tokens).toBe(12);
    expect(parsed.usage?.completion_tokens).toBe(3);
    expect(parsed.usage?.prompt_tokens_details?.cached_tokens).toBe(4);
  });

  it("ignores malformed JSON frames", async () => {
    const frames = [
      "data: not-json\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const parsed = await parseChatCompletionStream(toStream(frames), async () => {});
    expect(parsed.outputText).toBe("ok");
  });
});

describe("pricing", () => {
  it("resolves exact known models", () => {
    expect(resolveModelPrice("gpt-4o-mini")?.inputPer1M).toBe(0.15);
  });

  it("resolves versioned deployment names by longest-prefix match", () => {
    expect(resolveModelPrice("gpt-4o-2024-08-06")?.inputPer1M).toBe(2.5);
    expect(resolveModelPrice("gpt-4o-mini-2024-07-18")?.inputPer1M).toBe(0.15);
  });

  it("returns null for unknown models so cost stays honest", () => {
    expect(resolveModelPrice("does-not-exist")).toBeNull();
    expect(
      computeCostUsd("does-not-exist", { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull();
  });

  it("prices cached input tokens separately", () => {
    const cost = computeCostUsd("gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 500_000,
    });
    // 500K uncached * $2.5/1M + 500K cached * $1.25/1M = 1.25 + 0.625
    expect(cost).toBeCloseTo(1.875, 6);
  });
});
