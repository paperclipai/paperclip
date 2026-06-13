import { describe, expect, it } from "vitest";
import {
  evaluateInviteSignUpGate,
  hashInviteSignUpToken,
} from "../auth/invite-signup-gate.js";

const NOW = 1_700_000_000_000;

type InviteOverrides = Partial<{
  revokedAt: Date | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  allowedJoinTypes: string;
}>;

function makeInvite(overrides: InviteOverrides = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    companyId: "00000000-0000-0000-0000-0000000000aa",
    inviteType: "company_join",
    tokenHash: hashInviteSignUpToken("pcp_invite_abcd1234"),
    allowedJoinTypes: overrides.allowedJoinTypes ?? "both",
    defaultsPayload: null,
    expiresAt: overrides.expiresAt ?? new Date(NOW + 60_000),
    invitedByUserId: null,
    revokedAt: overrides.revokedAt ?? null,
    acceptedAt: overrides.acceptedAt ?? null,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
  } as unknown as Parameters<typeof evaluateInviteSignUpGate>[0]["invite"];
}

describe("evaluateInviteSignUpGate", () => {
  it("allows open sign-up when invite-only mode is off", () => {
    expect(
      evaluateInviteSignUpGate({ inviteOnly: false, token: null, invite: null, now: NOW }),
    ).toEqual({ allowed: true, reason: "open_signup" });
  });

  it("rejects an invite-less sign-up when invite-only mode is on", () => {
    expect(
      evaluateInviteSignUpGate({ inviteOnly: true, token: null, invite: null, now: NOW }),
    ).toEqual({ allowed: false, reason: "missing_token" });
    expect(
      evaluateInviteSignUpGate({ inviteOnly: true, token: "   ", invite: null, now: NOW }),
    ).toEqual({ allowed: false, reason: "missing_token" });
  });

  it("rejects a token that matches no invite", () => {
    expect(
      evaluateInviteSignUpGate({ inviteOnly: true, token: "pcp_invite_x", invite: null, now: NOW }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it("accepts a valid, unexpired, unrevoked human invite", () => {
    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ allowedJoinTypes: "both" }),
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "valid_invite" });

    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ allowedJoinTypes: "human" }),
        now: NOW,
      }).allowed,
    ).toBe(true);
  });

  it("rejects a revoked invite", () => {
    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ revokedAt: new Date(NOW - 1000) }),
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it("rejects an already-accepted invite", () => {
    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ acceptedAt: new Date(NOW - 1000) }),
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it("rejects an expired invite", () => {
    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ expiresAt: new Date(NOW - 1) }),
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it("rejects an agent-only invite for human sign-up", () => {
    expect(
      evaluateInviteSignUpGate({
        inviteOnly: true,
        token: "pcp_invite_abcd1234",
        invite: makeInvite({ allowedJoinTypes: "agent" }),
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it("hashes tokens with the same scheme the invite routes use", () => {
    // sha256("pcp_invite_abcd1234") — stable, matches routes/access.ts hashToken.
    expect(hashInviteSignUpToken("pcp_invite_abcd1234")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteSignUpToken("a")).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});
