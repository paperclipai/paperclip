import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmCheck } from "../checks/llm-check.js";

const ORIGINAL_ENV = { ...process.env };

describe("llmCheck", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("uses the OpenAI /v1 models endpoint by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const result = await llmCheck({
      llm: {
        provider: "openai",
        apiKey: "sk-test",
      },
    } as never);

    expect(result).toEqual({
      name: "LLM provider",
      status: "pass",
      message: "OpenAI API key is valid",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      }),
    );
  });
});
