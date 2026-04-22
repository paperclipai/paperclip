import { describe, it, expect, vi } from "vitest";
import { makeClassifierProbe } from "../src/classifier-probe.js";

describe("makeClassifierProbe", () => {
  it("returns reachable on 2xx", async () => {
    const probe = makeClassifierProbe({
      url: "http://x", timeoutMs: 1000,
      fetchFn: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    await expect(probe()).resolves.toBe("reachable");
  });
  it("returns unreachable on fetch error", async () => {
    const probe = makeClassifierProbe({
      url: "http://x", timeoutMs: 1000,
      fetchFn: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await expect(probe()).resolves.toBe("unreachable");
  });
});
