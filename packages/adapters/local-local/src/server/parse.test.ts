import { describe, expect, it } from "vitest";
import { parseLocalLLMResponse } from "./parse.js";

describe("parseLocalLLMResponse", () => {
  it("parses a complete OpenAI-compatible chat completion response", () => {
    const response = {
      id: "chatcmpl-123",
      model: "qwen/qwen3.5-9b",
      choices: [
        {
          message: { content: "Hello from LM Studio" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
      },
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("Hello from LM Studio");
    expect(result.model).toBe("qwen/qwen3.5-9b");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 0,
    });
  });

  it("handles response with missing usage", () => {
    const response = {
      model: "deepseek-r1:8b",
      choices: [
        {
          message: { content: "Some response" },
          finish_reason: "stop",
        },
      ],
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("Some response");
    expect(result.model).toBe("deepseek-r1:8b");
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("handles response with empty choices", () => {
    const response = {
      model: "qwen2.5-coder:7b",
      choices: [],
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("");
    expect(result.model).toBe("qwen2.5-coder:7b");
  });

  it("handles response with no choices array", () => {
    const response = {
      model: "test-model",
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("");
    expect(result.model).toBe("test-model");
  });

  it("handles response with no model field", () => {
    const response = {
      choices: [
        {
          message: { content: "Hello" },
        },
      ],
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("Hello");
    expect(result.model).toBe("unknown");
  });

  it("handles response with empty content", () => {
    const response = {
      model: "qwen/qwen3.5-9b",
      choices: [
        {
          message: { content: "" },
          finish_reason: "stop",
        },
      ],
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("");
  });

  it("handles choice with missing message", () => {
    const response = {
      model: "test-model",
      choices: [
        {
          finish_reason: "stop",
        },
      ],
    };

    const result = parseLocalLLMResponse(response);
    expect(result.summary).toBe("");
  });
});
