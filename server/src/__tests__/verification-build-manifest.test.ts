import { describe, it, expect, vi } from "vitest";
import { fetchBuildManifest, waitForSha } from "../services/verification/build-manifest.js";

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "error",
    json: async () => body,
  } as Response;
}

describe("fetchBuildManifest", () => {
  it("parses valid manifest", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ sha: "abc123", deployedAt: "2026-04-13T00:00:00Z" }),
    );
    const result = await fetchBuildManifest("https://viracue.ai", fetchImpl);
    expect(result.sha).toBe("abc123");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://viracue.ai/__build.json",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("strips trailing slash from base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ sha: "abc", deployedAt: "t" }),
    );
    await fetchBuildManifest("https://viracue.ai/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://viracue.ai/__build.json",
      expect.any(Object),
    );
  });

  it("throws on non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({}, false, 404));
    await expect(fetchBuildManifest("https://x.com", fetchImpl)).rejects.toThrow(/404/);
  });

  it("throws on missing sha field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ deployedAt: "t" }),
    );
    await expect(fetchBuildManifest("https://x.com", fetchImpl)).rejects.toThrow(/missing required/);
  });

  it("throws on missing deployedAt field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ sha: "abc" }));
    await expect(fetchBuildManifest("https://x.com", fetchImpl)).rejects.toThrow(/missing required/);
  });
});

describe("waitForSha", () => {
  it("returns matched=true when SHA matches on first try", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ sha: "abc", deployedAt: "t" }),
    );
    const result = await waitForSha({ baseUrl: "https://x.com", expectedSha: "abc", fetchImpl });
    expect(result.matched).toBe(true);
    expect(result.deployedSha).toBe("abc");
  });

  it("returns matched=false when SHA never matches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse({ sha: "def", deployedAt: "t" }),
    );
    const result = await waitForSha({
      baseUrl: "https://x.com",
      expectedSha: "abc",
      maxAttempts: 3,
      delayMs: 0,
      fetchImpl,
      sleep: async () => undefined,
    });
    expect(result.matched).toBe(false);
    expect(result.deployedSha).toBe("def");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("matches on a later attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ sha: "old", deployedAt: "t" }))
      .mockResolvedValueOnce(makeResponse({ sha: "old", deployedAt: "t" }))
      .mockResolvedValueOnce(makeResponse({ sha: "new", deployedAt: "t" }));
    const result = await waitForSha({
      baseUrl: "https://x.com",
      expectedSha: "new",
      maxAttempts: 5,
      delayMs: 0,
      fetchImpl,
      sleep: async () => undefined,
    });
    expect(result.matched).toBe(true);
    expect(result.deployedSha).toBe("new");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
