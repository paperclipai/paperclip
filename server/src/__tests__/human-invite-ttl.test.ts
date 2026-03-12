import { describe, it, expect } from "vitest";
import { companyInviteExpiresAt } from "../routes/access.js";
import { HUMAN_INVITE_TTL_MS } from "@paperclipai/shared";

describe("Human Invite TTL", () => {
  const AGENT_TTL = 10 * 60 * 1000; // 10 min

  it("defaults to 10-minute agent TTL", () => {
    const now = Date.now();
    const expires = companyInviteExpiresAt(now);
    expect(expires.getTime()).toBe(now + AGENT_TTL);
  });

  it("accepts custom TTL for human invites", () => {
    const now = Date.now();
    const expires = companyInviteExpiresAt(now, HUMAN_INVITE_TTL_MS);
    expect(expires.getTime()).toBe(now + 24 * 60 * 60 * 1000);
  });

  it("HUMAN_INVITE_TTL_MS is 24 hours", () => {
    expect(HUMAN_INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
