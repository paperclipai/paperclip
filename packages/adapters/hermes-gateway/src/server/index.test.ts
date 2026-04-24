import { describe, expect, it } from "vitest";
import { testEnvironment } from "./index.js";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

function createTestContext(config: Record<string, unknown>): AdapterEnvironmentTestContext {
  return {
    companyId: "company-1",
    adapterType: "hermes_gateway",
    config,
  };
}

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

  it("accepts a /v1 base URL", async () => {
    const result = await testEnvironment(createTestContext({
      url: "http://hermes-gateway.local/v1",
    }));

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url",
        message: "Hermes Gateway URL configured: http://hermes-gateway.local",
      }),
    ]);
  });

  it("accepts a legacy full endpoint URL for backwards compatibility", async () => {
    const result = await testEnvironment(createTestContext({
      url: "https://hermes-service.example/v1/chat/completions",
    }));

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url",
        message: "Hermes Gateway URL configured: https://hermes-service.example",
      }),
    ]);
  });
});
