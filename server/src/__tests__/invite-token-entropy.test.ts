import { describe, expect, it } from "vitest";
import { createInviteToken } from "../routes/access.js";

const PREFIX = "pcp_invite_";

describe("createInviteToken", () => {
  it("keeps the human-readable pcp_invite_ prefix", () => {
    expect(createInviteToken().startsWith(PREFIX)).toBe(true);
  });

  it("carries at least 128 bits of randomness", () => {
    const suffix = createInviteToken().slice(PREFIX.length);
    // base64url over 32 random bytes => 43 chars, 256 bits of entropy. Each
    // base64url char is 6 bits, so >= 22 chars guarantees >= 128 bits.
    expect(suffix.length).toBeGreaterThanOrEqual(22);
    expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
    const bits = suffix.length * 6;
    expect(bits).toBeGreaterThanOrEqual(128);
  });

  it("produces unique, non-repeating tokens", () => {
    const tokens = new Set(
      Array.from({ length: 1000 }, () => createInviteToken()),
    );
    expect(tokens.size).toBe(1000);
  });
});
