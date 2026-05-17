import { describe, expect, it } from "vitest";
import { companyInviteExpiresAt } from "../routes/access.js";

describe("companyInviteExpiresAt", () => {
  it("sets invite expiration to 72 hours after invite creation time", () => {
    const createdAtMs = Date.parse("2026-03-06T00:00:00.000Z");
    const expiresAt = companyInviteExpiresAt(createdAtMs);
    expect(expiresAt.toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("uses ttlSeconds * 1000 when provided", () => {
    const createdAtMs = Date.parse("2026-03-06T00:00:00.000Z");
    const expiresAt = companyInviteExpiresAt(createdAtMs, 1800);
    expect(expiresAt.getTime() - createdAtMs).toBe(1800 * 1000);
  });

  it("falls back to the 72h default when ttlSeconds is undefined", () => {
    const createdAtMs = Date.parse("2026-03-06T00:00:00.000Z");
    const expiresAt = companyInviteExpiresAt(createdAtMs, undefined);
    expect(expiresAt.getTime() - createdAtMs).toBe(72 * 60 * 60 * 1000);
  });
});
