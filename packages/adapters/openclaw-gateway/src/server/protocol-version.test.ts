import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./execute.js";

// Pin the wire-protocol version this adapter speaks to openclaw's gateway.
//
// Why this test exists:
//   openclaw has upgraded its gateway protocol from v3 to v4 in v2026.6+.
//   When the constant drifted out of sync, every `openclaw_gateway` connect
//   failed with `protocol mismatch` before any work could happen, silently
//   bricking the adapter for anyone on a current openclaw.
//
// If you bump this number, you must also bump (or re-confirm compatibility
// with) openclaw's MIN_CLIENT_PROTOCOL_VERSION. The current openclaw build
// accepts minProtocol <= 4 <= maxProtocol.
//
// See packages/adapters/openclaw-gateway/src/server/execute.ts for the
// constant declaration and the two call sites that consume it.
describe("PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("is at least 4 (matches openclaw v2026.6+ MIN_CLIENT_PROTOCOL_VERSION)", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });

  it("matches the v4 wire-frame expected by current openclaw gateway", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });
});
