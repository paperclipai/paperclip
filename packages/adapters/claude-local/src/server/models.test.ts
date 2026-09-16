import { afterEach, describe, expect, it, vi } from "vitest";
import { probeClaudeModelRoute } from "./models.js";

afterEach(() => vi.restoreAllMocks());

describe("probeClaudeModelRoute", () => {
  const env = {
    ANTHROPIC_BASE_URL: "https://omni.example",
    ANTHROPIC_API_KEY: "probe-only-key",
  };

  it("reports a live model as available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "auto/claude-sonnet" }] }),
    } as Response);

    await expect(probeClaudeModelRoute("auto/claude-sonnet", env)).resolves.toBe("available");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "x-api-key": "probe-only-key",
        Authorization: "Bearer probe-only-key",
      },
    });
  });

  it("reports a static model as fallback-only when the provider catalog is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);

    await expect(probeClaudeModelRoute("claude-sonnet-4-5", env)).resolves.toBe("fallback-only");
  });

  it("reports an unknown model as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "auto/claude-sonnet" }] }),
    } as Response);

    await expect(probeClaudeModelRoute("claude-sonnet-4-5", env)).resolves.toBe("unavailable");
  });
});
