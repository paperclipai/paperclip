import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeEndpoint } from "../src/server/llm-client.js";

describe("probeEndpoint", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns ok:true when server responds 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m" }] }),
    }));

    const result = await probeEndpoint("http://localhost:1234", 500);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with reason when connection refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }),
    ));

    const result = await probeEndpoint("http://localhost:9999", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("returns ok:false with reason on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ));

    const result = await probeEndpoint("http://slow-host:1234", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timeout|abort/i);
    }
  });

  it("returns ok:false with reason on HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await probeEndpoint("http://localhost:1234", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("500");
    }
  });

  it("never throws — always returns a ProbeResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { throw new Error("boom"); }));
    await expect(probeEndpoint("http://x", 100)).resolves.toHaveProperty("ok", false);
  });
});
