import { describe, expect, it } from "vitest";
import { resolveMaxRpcTimeoutMs } from "./plugin-worker-manager.js";

describe("resolveMaxRpcTimeoutMs", () => {
  it("defaults to 15 minutes", () => {
    expect(resolveMaxRpcTimeoutMs({})).toBe(15 * 60 * 1000);
  });

  it("honors PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS", () => {
    expect(
      resolveMaxRpcTimeoutMs({ PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS: "1800000" }),
    ).toBe(1_800_000);
  });

  it("ignores a non-numeric override", () => {
    expect(
      resolveMaxRpcTimeoutMs({ PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS: "not-a-number" }),
    ).toBe(15 * 60 * 1000);
  });

  it("ignores a non-positive override", () => {
    expect(resolveMaxRpcTimeoutMs({ PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS: "0" })).toBe(
      15 * 60 * 1000,
    );
    expect(resolveMaxRpcTimeoutMs({ PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS: "-5" })).toBe(
      15 * 60 * 1000,
    );
  });

  it("truncates a fractional override", () => {
    expect(
      resolveMaxRpcTimeoutMs({ PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS: "1200000.9" }),
    ).toBe(1_200_000);
  });
});
