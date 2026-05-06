import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudflare_workers_ai adapter", () => {
  it("routes through AI Gateway and parses OpenAI-compatible chat completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: "Gateway finished the task.",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-gateway",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CEO",
        adapterType: "cloudflare_workers_ai",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        accountId: "acc-123",
        apiToken: "token-123",
        gatewayId: "default",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(result.model).toBe("@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(result.summary).toBe("Gateway finished the task.");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc-123/default/compat/chat/completions",
    );
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({ "cf-aig-authorization": "Bearer token-123" });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct",
      stream: false,
      messages: [
        {
          role: "user",
        },
      ],
    });
  });

  it("defaults to qwen2.5-coder and parses wrapped Workers AI responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        result: {
          response: "Direct REST call finished the task.",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-direct",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CEO",
        adapterType: "cloudflare_workers_ai",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        accountId: "acc-456",
        apiToken: "token-456",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(result.model).toBe("@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(result.summary).toBe("Direct REST call finished the task.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-456/ai/run/%40cf/qwen/qwen2.5-coder-32b-instruct",
    );
  });

  it("reports chat timeouts as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })),
    );

    const result = await execute({
      runId: "run-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CEO",
        adapterType: "cloudflare_workers_ai",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        accountId: "acc-789",
        apiToken: "token-789",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("verifies the token and reports the resolved route in environment tests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "active",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company_1",
      adapterType: "cloudflare_workers_ai",
      config: {
        accountId: "acc-999",
        apiToken: "token-999",
        gatewayId: "default",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "cloudflare_workers_ai_gateway_enabled",
        }),
        expect.objectContaining({
          code: "cloudflare_workers_ai_run_url_resolved",
          message: "Resolved run endpoint: https://gateway.ai.cloudflare.com/v1/acc-999/default/compat/chat/completions",
        }),
        expect.objectContaining({
          code: "cloudflare_workers_ai_token_verify_ok",
          message: "Cloudflare API token verified (active).",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer token-999" }),
      }),
    );
  });
});
