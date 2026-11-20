import { afterEach, describe, expect, it, vi } from "vitest";
import { companyInviteExpiresAt } from "../routes/access.js";

describe("companyInviteExpiresAt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets invite expiration to 72 hours after invite creation time by default", () => {
    const createdAtMs = Date.parse("2026-03-06T00:00:00.000Z");
    const expiresAt = companyInviteExpiresAt(createdAtMs);
    expect(expiresAt.toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("respects PAPERCLIP_INVITE_TTL_HOURS override", () => {
    vi.stubEnv("PAPERCLIP_INVITE_TTL_HOURS", "168");
    const createdAtMs = Date.parse("2026-03-06T00:00:00.000Z");
    const expiresAt = companyInviteExpiresAt(createdAtMs);
    expect(expiresAt.toISOString()).toBe("2026-03-13T00:00:00.000Z");
  });
});
