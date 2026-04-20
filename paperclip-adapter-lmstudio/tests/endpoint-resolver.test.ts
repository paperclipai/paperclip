import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePrimaryOrFallback } from "../src/server/endpoint-resolver.js";
import * as llmClient from "../src/server/llm-client.js";

describe("resolvePrimaryOrFallback", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("uses primary when primary probe ok", async () => {
    vi.spyOn(llmClient, "probeEndpoint").mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://primary:1234", model: "big" });
      expect(result.usingFallback).toBe(false);
    }
  });

  it("falls back when primary probe fails and fallback probe ok", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://fallback:1234", model: "small" });
      expect(result.usingFallback).toBe(true);
      expect(result.primaryFailureReason).toContain("ECONNREFUSED");
    }
  });

  it("uses primary model name as fallback model when fallbackModel is empty", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "timeout" })
      .mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://fallback:1234", model: "big" });
    }
  });

  it("returns error when no fallback configured and primary fails", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "",
      fallbackModel: "",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("primary");
      expect(result.errorMessage).toContain("ECONNREFUSED");
    }
  });

  it("returns error when both primary and fallback fail", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: false, reason: "timeout after 500ms" });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("primary");
      expect(result.errorMessage).toContain("ECONNREFUSED");
      expect(result.errorMessage).toContain("fallback");
      expect(result.errorMessage).toContain("timeout");
    }
  });

  it("skips primary probe only once — does not re-probe", async () => {
    const probeSpy = vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: true });

    await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
  });
});
