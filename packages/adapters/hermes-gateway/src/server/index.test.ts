import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./index.js";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

function createTestContext(config: Record<string, unknown>): AdapterEnvironmentTestContext {
  return {
    companyId: "company-1",
    adapterType: "hermes_gateway",
    config,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hermes_gateway testEnvironment", () => {
  it("fails when the Hermes API URL is missing", async () => {
    const result = await testEnvironment(createTestContext({}));

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url_missing",
        level: "error",
        hint: expect.stringContaining("http://hermes-gateway.local/v1"),
      }),
    ]);
  });

  it("fails when the Hermes API URL is invalid", async () => {
    const result = await testEnvironment(createTestContext({
      url: "hermes-gateway.local",
    }));

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url_invalid",
        level: "error",
        hint: expect.stringContaining("preferably ending in /v1"),
      }),
    ]);
  });

  it("checks a /v1 base URL through the models endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment(createTestContext({
      url: "http://hermes-gateway.local/v1",
    }));

    expect(result.status).toBe("pass");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://hermes-gateway.local/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_reachable",
        message: "Hermes Gateway API reachable at http://hermes-gateway.local/v1/models",
      }),
    ]);
  });

  it("derives the models endpoint from legacy full endpoint URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment(createTestContext({
      url: "https://hermes-service.example/v1/chat/completions",
      apiKey: "Bearer secret-token",
    }));

    expect(result.status).toBe("pass");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hermes-service.example/v1/models",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });

  it("fails when the Hermes API rejects authentication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));

    const result = await testEnvironment(createTestContext({
      url: "http://hermes-gateway.local/v1",
      apiKey: "bad-token",
    }));

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_auth_failed",
        level: "error",
        hint: expect.stringContaining("API key"),
      }),
    ]);
  });

  it("warns when the API is reachable but does not expose /models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

    const result = await testEnvironment(createTestContext({
      url: "http://hermes-gateway.local/v1",
    }));

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_models_unavailable",
        level: "warn",
      }),
    ]);
  });

  it("fails when the Hermes API cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const result = await testEnvironment(createTestContext({
      url: "http://hermes-gateway.local/v1",
    }));

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_unreachable",
        level: "error",
      }),
    ]);
  });
});
