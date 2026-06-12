import { beforeEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("minimax_local testEnvironment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY_FILE;
  });

  it("fails cleanly when no API key is configured", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("minimax_api_key_missing");
  });

  it("passes when the hello probe returns OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: "OK" },
          },
        ],
      }),
    } as Response);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: {
        env: { MINIMAX_API_KEY: "test-key" },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "minimax_probe_passed")).toBe(true);
  });
});
