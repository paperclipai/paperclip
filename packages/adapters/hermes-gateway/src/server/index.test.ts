import { describe, expect, it } from "vitest";
import { testEnvironment } from "./index.js";

describe("hermes_gateway testEnvironment", () => {
  it("warns when the Hermes API URL is missing", async () => {
    const result = await testEnvironment({
      adapterType: "hermes_gateway",
      config: {},
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url_missing",
        level: "warn",
        hint: expect.stringContaining("http://hermes-service:8642/v1"),
      }),
    ]);
  });

  it("fails when the Hermes API URL is invalid", async () => {
    const result = await testEnvironment({
      adapterType: "hermes_gateway",
      config: {
        url: "hermes-service:8642",
      },
    });

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
    const result = await testEnvironment({
      adapterType: "hermes_gateway",
      config: {
        url: "http://hermes-service:8642/v1",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url",
        message: "Hermes Gateway URL configured: http://hermes-service:8642",
      }),
    ]);
  });

  it("accepts a legacy full endpoint URL for backwards compatibility", async () => {
    const result = await testEnvironment({
      adapterType: "hermes_gateway",
      config: {
        url: "https://hermes-service.example/v1/chat/completions",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([
      expect.objectContaining({
        code: "hermes_api_url",
        message: "Hermes Gateway URL configured: https://hermes-service.example",
      }),
    ]);
  });
});
