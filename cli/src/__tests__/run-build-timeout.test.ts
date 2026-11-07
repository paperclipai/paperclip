import { describe, expect, it } from "vitest";
import { resolveDevBuildDepsTimeoutMs } from "../commands/run.js";

describe("resolveDevBuildDepsTimeoutMs", () => {
  it("defaults to a ceiling long enough for slow cold builds", () => {
    expect(resolveDevBuildDepsTimeoutMs({})).toBe(20 * 60_000);
  });

  it("honours a positive PAPERCLIP_DEV_BUILD_TIMEOUT_MS override", () => {
    expect(resolveDevBuildDepsTimeoutMs({ PAPERCLIP_DEV_BUILD_TIMEOUT_MS: "1800000" })).toBe(1_800_000);
  });

  it("ignores invalid overrides", () => {
    for (const value of ["", "abc", "0", "-5", "1500000.5"]) {
      expect(resolveDevBuildDepsTimeoutMs({ PAPERCLIP_DEV_BUILD_TIMEOUT_MS: value })).toBe(20 * 60_000);
    }
  });
});
