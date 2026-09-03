import { describe, expect, it } from "vitest";
import { resolveGeminiSandboxFlag } from "./execute.js";

describe("resolveGeminiSandboxFlag", () => {
  it("passes --sandbox=none when the adapter config leaves sandbox off", () => {
    expect(resolveGeminiSandboxFlag({ configuredSandbox: false, usesManagedSandbox: false })).toEqual({
      sandboxArg: "--sandbox=none",
      suppressedReason: null,
    });
  });

  it("honors an explicit sandbox request on a local target", () => {
    expect(resolveGeminiSandboxFlag({ configuredSandbox: true, usesManagedSandbox: false })).toEqual({
      sandboxArg: "--sandbox",
      suppressedReason: null,
    });
  });

  it("suppresses the sandbox request inside a managed sandbox and says why", () => {
    const result = resolveGeminiSandboxFlag({ configuredSandbox: true, usesManagedSandbox: true });
    expect(result.sandboxArg).toBe("--sandbox=none");
    expect(result.suppressedReason).toContain("managed sandbox");
    expect(result.suppressedReason).toContain("adapterConfig.sandbox");
  });

  it("needs no suppression note when the managed sandbox run never asked for one", () => {
    expect(resolveGeminiSandboxFlag({ configuredSandbox: false, usesManagedSandbox: true })).toEqual({
      sandboxArg: "--sandbox=none",
      suppressedReason: null,
    });
  });
});

