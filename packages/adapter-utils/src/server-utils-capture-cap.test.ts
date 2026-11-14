import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_BYTES_ENV,
  resolveMaxCaptureBytes,
} from "./server-utils.js";

describe("resolveMaxCaptureBytes", () => {
  it("keeps the 4 MB default when unset or invalid", () => {
    expect(MAX_CAPTURE_BYTES).toBe(4 * 1024 * 1024);
    expect(resolveMaxCaptureBytes({})).toBe(MAX_CAPTURE_BYTES);
    for (const value of ["", " ", "0", "-1", "1.5", "1MB", "abc", "1e6", "99999999999999999999"]) {
      expect(resolveMaxCaptureBytes({ [MAX_CAPTURE_BYTES_ENV]: value })).toBe(MAX_CAPTURE_BYTES);
    }
  });

  it("reads a positive whole number of bytes", () => {
    expect(resolveMaxCaptureBytes({ [MAX_CAPTURE_BYTES_ENV]: "1048576" })).toBe(1_048_576);
    expect(resolveMaxCaptureBytes({ [MAX_CAPTURE_BYTES_ENV]: " 2048 " })).toBe(2048);
  });
});

describe("appendWithCap default cap", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the configured cap and keeps the tail", async () => {
    vi.stubEnv(MAX_CAPTURE_BYTES_ENV, "8");
    vi.resetModules();
    const { appendWithCap } = await import("./server-utils.js");
    expect(appendWithCap("abcdef", "ghijkl")).toBe("efghijkl");
    expect(appendWithCap("abcdef", "ghijkl", 4)).toBe("ijkl");
  });

  it("keeps 4 MB when the setting is invalid", async () => {
    vi.stubEnv(MAX_CAPTURE_BYTES_ENV, "not-a-number");
    vi.resetModules();
    const { appendWithCap } = await import("./server-utils.js");
    const big = "x".repeat(MAX_CAPTURE_BYTES);
    expect(appendWithCap(big, "yz").length).toBe(MAX_CAPTURE_BYTES);
    expect(appendWithCap("abcdef", "ghijkl")).toBe("abcdefghijkl");
  });
});
