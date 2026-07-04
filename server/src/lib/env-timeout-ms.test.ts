import { describe, expect, it } from "vitest";
import { resolveEnvTimeoutMs } from "./env-timeout-ms.js";

const DEFAULT_REAP_STALE_MS = 5 * 60 * 1000;

describe("resolveEnvTimeoutMs", () => {
  it("returns the default when the variable is unset", () => {
    expect(resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {})).toBe(
      DEFAULT_REAP_STALE_MS,
    );
  });

  it("honors a valid override", () => {
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "3600000",
      }),
    ).toBe(3_600_000);
  });

  it("ignores a blank or whitespace-only value", () => {
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "   ",
      }),
    ).toBe(DEFAULT_REAP_STALE_MS);
  });

  it("ignores a non-numeric override", () => {
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "not-a-number",
      }),
    ).toBe(DEFAULT_REAP_STALE_MS);
  });

  it("ignores a non-positive override", () => {
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "0",
      }),
    ).toBe(DEFAULT_REAP_STALE_MS);
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "-5",
      }),
    ).toBe(DEFAULT_REAP_STALE_MS);
  });

  it("truncates a fractional override", () => {
    expect(
      resolveEnvTimeoutMs("PAPERCLIP_HEARTBEAT_REAP_STALE_MS", DEFAULT_REAP_STALE_MS, {
        PAPERCLIP_HEARTBEAT_REAP_STALE_MS: "600000.9",
      }),
    ).toBe(600_000);
  });
});
