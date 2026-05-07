import { describe, expect, it, vi } from "vitest";
import {
  callDeepseekChat,
  DeepseekHttpError,
  resolveDeepseekApiKey,
} from "./execute.js";

describe("resolveDeepseekApiKey", () => {
  it("prefers explicit config.apiKey", () => {
    const key = resolveDeepseekApiKey({
      config: { apiKey: "sk-direct" },
      processEnv: { DEEPSEEK_API_KEY: "sk-fallback" },
    });
    expect(key).toBe("sk-direct");
  });

  it("reads from config.env plain binding", () => {
    const key = resolveDeepseekApiKey({
      config: { env: { DEEPSEEK_API_KEY: { type: "plain", value: "sk-from-env" } } },
      processEnv: {},
    });
    expect(key).toBe("sk-from-env");
  });

  it("reads from config.env raw string", () => {
    const key = resolveDeepseekApiKey({
      config: { env: { DEEPSEEK_API_KEY: "sk-raw" } },
      processEnv: {},
    });
    expect(key).toBe("sk-raw");
  });

  it("falls back to process env", () => {
    const key = resolveDeepseekApiKey({
      config: {},
      processEnv: { DEEPSEEK_API_KEY: "sk-process" },
    });
    expect(key).toBe("sk-process");
  });

  it("returns null when no key is configured", () => {
    expect(
      resolveDeepseekApiKey({
        config: {},
        processEnv: {},
      }),
    ).toBeNull();
  });

  it("ignores secret_ref bindings (server cannot dereference here)", () => {
    const key = resolveDeepseekApiKey({
      config: {
        env: { DEEPSEEK_API_KEY: { type: "secret_ref", secretId: "sec_123" } },
      },
      processEnv: { DEEPSEEK_API_KEY: "sk-process" },
    });
    expect(key).toBe("sk-process");
  });
});

describe("callDeepseekChat", () => {
  it("posts a chat completion request and returns assistant text + usage", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-test");
      expect(headers["content-type"]).toBe("application/json");
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("deepseek-chat");
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "ping" },
      ]);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: "cmpl-1",
            model: "deepseek-chat",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "pong" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
      } as unknown as Response;
    });

    const result = await callDeepseekChat({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
      systemPrompt: "You are helpful.",
      userPrompt: "ping",
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.text).toBe("pong");
    expect(result.finishReason).toBe("stop");
    expect(result.modelEcho).toBe("deepseek-chat");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("captures reasoning_content for deepseek-reasoner", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "the answer is 4",
                  reasoning_content: "2 + 2 = 4",
                },
              },
            ],
          }),
      }) as unknown as Response,
    );

    const result = await callDeepseekChat({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-reasoner",
      systemPrompt: "",
      userPrompt: "what is 2+2",
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.text).toBe("the answer is 4");
    expect(result.reasoning).toBe("2 + 2 = 4");
  });

  it("throws DeepseekHttpError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"invalid api key"}}',
      }) as unknown as Response,
    );

    await expect(
      callDeepseekChat({
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-bad",
        model: "deepseek-chat",
        systemPrompt: "",
        userPrompt: "ping",
        temperature: 0.2,
        maxTokens: 256,
        timeoutMs: 5_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DeepseekHttpError);
  });

  it("omits the system message when systemPrompt is empty", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }),
      } as unknown as Response;
    });

    await callDeepseekChat({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
      systemPrompt: "   ",
      userPrompt: "ping",
      temperature: 0.2,
      maxTokens: 256,
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
