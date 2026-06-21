import { describe, expect, it } from "vitest";
import { resolveHostVersion } from "../app";
import { serverVersion } from "../version";

describe("resolveHostVersion", () => {
  it("falls back to the server package version when no host version is provided", () => {
    expect(resolveHostVersion()).toBe(serverVersion);
    expect(resolveHostVersion(undefined)).toBe(serverVersion);
  });

  it("never falls back to the 0.0.0 placeholder", () => {
    expect(resolveHostVersion()).not.toBe("0.0.0");
  });

  it("preserves an explicitly provided host version", () => {
    expect(resolveHostVersion("2026.525.0")).toBe("2026.525.0");
  });
});
