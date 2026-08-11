import { describe, expect, it } from "vitest";
import { resolveDefaultAcpEngineWarmHandleIdleMs } from "./constants.js";

describe("resolveDefaultAcpEngineWarmHandleIdleMs", () => {
  it("defaults to 0 (feature off) when env var is unset", () => {
    expect(resolveDefaultAcpEngineWarmHandleIdleMs({})).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(resolveDefaultAcpEngineWarmHandleIdleMs({ ACPX_ENGINE_WARM_HANDLE_IDLE_MS: "" })).toBe(0);
  });

  it("flips the fleet warm when a positive numeric value is provided", () => {
    expect(
      resolveDefaultAcpEngineWarmHandleIdleMs({ ACPX_ENGINE_WARM_HANDLE_IDLE_MS: "120000" }),
    ).toBe(120000);
  });

  it("floors fractional milliseconds", () => {
    expect(
      resolveDefaultAcpEngineWarmHandleIdleMs({ ACPX_ENGINE_WARM_HANDLE_IDLE_MS: "1500.9" }),
    ).toBe(1500);
  });

  it("falls back to 0 for non-numeric or negative input", () => {
    expect(resolveDefaultAcpEngineWarmHandleIdleMs({ ACPX_ENGINE_WARM_HANDLE_IDLE_MS: "abc" })).toBe(0);
    expect(resolveDefaultAcpEngineWarmHandleIdleMs({ ACPX_ENGINE_WARM_HANDLE_IDLE_MS: "-5" })).toBe(0);
  });
});
