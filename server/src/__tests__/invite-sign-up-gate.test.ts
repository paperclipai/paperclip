import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  INVITE_SIGN_UP_TOKEN_HEADER,
  SIGN_UP_REQUIRES_INVITE_CODE,
  SIGN_UP_REQUIRES_INVITE_MESSAGE,
  assertInviteSignUpAllowed,
  checkInviteSignUp,
  evaluateInviteSignUp,
  hashInviteSignUpToken,
  inviteSignUpAuthOptions,
} from "../auth/invite-sign-up-gate.js";

// Real time: the assert and hook paths read the clock themselves.
const NOW = Date.now();
const TOKEN = "pcp_invite_signup_gate_test";

type InviteRow = NonNullable<Parameters<typeof evaluateInviteSignUp>[0]["invite"]>;

function makeInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    companyId: "00000000-0000-4000-8000-0000000000aa",
    inviteType: "company_join",
    tokenHash: hashInviteSignUpToken(TOKEN),
    allowedJoinTypes: "both",
    defaultsPayload: null,
    expiresAt: new Date(NOW + 60_000),
    invitedByUserId: "user-1",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

/** A db stub whose invite lookup returns `rows`. */
function dbReturning(rows: InviteRow[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as unknown as Db;
  return { db, where };
}

describe("evaluateInviteSignUp", () => {
  it.each(["open", "disabled"] as const)("does not gate anything in %s mode", (mode) => {
    expect(evaluateInviteSignUp({ mode, token: null, invite: null, now: NOW })).toEqual({
      allowed: true,
      reason: "not_invite_mode",
    });
  });

  it("rejects a sign-up without a token", () => {
    for (const token of [null, "", "   "]) {
      expect(evaluateInviteSignUp({ mode: "invite", token, invite: makeInvite(), now: NOW })).toEqual({
        allowed: false,
        reason: "missing_token",
      });
    }
  });

  it("rejects a token that names no invite", () => {
    expect(evaluateInviteSignUp({ mode: "invite", token: TOKEN, invite: null, now: NOW })).toEqual({
      allowed: false,
      reason: "invalid_invite",
    });
  });

  it.each([
    ["revoked", { revokedAt: new Date(NOW - 1_000) }],
    ["accepted", { acceptedAt: new Date(NOW - 1_000) }],
    ["expired", { expiresAt: new Date(NOW - 1_000) }],
    ["expiring at this exact moment", { expiresAt: new Date(NOW) }],
    ["agent-only", { allowedJoinTypes: "agent" }],
  ] as const)("rejects a %s invite", (_label, overrides) => {
    expect(
      evaluateInviteSignUp({ mode: "invite", token: TOKEN, invite: makeInvite(overrides), now: NOW }),
    ).toEqual({ allowed: false, reason: "invalid_invite" });
  });

  it.each([
    ["human", { allowedJoinTypes: "human" }],
    ["human-or-agent", { allowedJoinTypes: "both" }],
    ["bootstrap", { inviteType: "bootstrap_ceo", companyId: null, allowedJoinTypes: "human" }],
  ] as const)("allows an active %s invite", (_label, overrides) => {
    expect(
      evaluateInviteSignUp({ mode: "invite", token: TOKEN, invite: makeInvite(overrides), now: NOW }),
    ).toEqual({ allowed: true, reason: "valid_invite" });
  });
});

describe("checkInviteSignUp", () => {
  it("looks the invite up by the sha256 token hash the invite routes store", async () => {
    // sha256("a"), the scheme `hashToken` in routes/access.ts uses for invites.tokenHash.
    expect(hashInviteSignUpToken("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    const { db, where } = dbReturning([makeInvite()]);
    await expect(checkInviteSignUp(db, { mode: "invite", token: `  ${TOKEN}  `, now: NOW })).resolves.toEqual({
      allowed: true,
      reason: "valid_invite",
    });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("skips the lookup outside invite mode and without a token", async () => {
    const { db } = dbReturning([makeInvite()]);
    await expect(checkInviteSignUp(db, { mode: "open", token: null })).resolves.toMatchObject({ allowed: true });
    await expect(checkInviteSignUp(db, { mode: "invite", token: " " })).resolves.toMatchObject({
      allowed: false,
      reason: "missing_token",
    });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("assertInviteSignUpAllowed", () => {
  async function rejection(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (err: unknown) => err as { statusCode?: number; body?: { code?: string; message?: string } },
    );
    expect(error).not.toBeNull();
    return error!;
  }

  it("throws one 403 for a missing and an unknown token, so it does not leak which invites exist", async () => {
    const { db } = dbReturning([]);
    const missing = await rejection(assertInviteSignUpAllowed(db, { mode: "invite", headers: new Headers() }));
    const unknown = await rejection(
      assertInviteSignUpAllowed(db, {
        mode: "invite",
        headers: new Headers({ [INVITE_SIGN_UP_TOKEN_HEADER]: "pcp_invite_unknown" }),
      }),
    );
    for (const error of [missing, unknown]) {
      expect(error.statusCode).toBe(403);
      expect(error.body).toMatchObject({
        code: SIGN_UP_REQUIRES_INVITE_CODE,
        message: SIGN_UP_REQUIRES_INVITE_MESSAGE,
      });
    }
    expect(unknown.body).toEqual(missing.body);
  });

  it("passes a request that carries a valid token", async () => {
    const { db } = dbReturning([makeInvite()]);
    await expect(
      assertInviteSignUpAllowed(db, {
        mode: "invite",
        headers: new Headers({ [INVITE_SIGN_UP_TOKEN_HEADER]: TOKEN }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("inviteSignUpAuthOptions user-creation backstop", () => {
  const user = { id: "u1", email: "new@example.com", name: "New", emailVerified: false };

  it("fails closed when Better Auth creates a user outside a request", async () => {
    const { db } = dbReturning([makeInvite()]);
    const before = inviteSignUpAuthOptions(db).databaseHooks.user.create.before;
    await expect(before(user, null)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a user created by a request without a valid token", async () => {
    const { db } = dbReturning([]);
    const before = inviteSignUpAuthOptions(db).databaseHooks.user.create.before;
    await expect(
      before(user, { headers: new Headers({ [INVITE_SIGN_UP_TOKEN_HEADER]: TOKEN }) }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("allows a user created by a request with a valid token", async () => {
    const { db } = dbReturning([makeInvite()]);
    const before = inviteSignUpAuthOptions(db).databaseHooks.user.create.before;
    await expect(
      before(user, { headers: new Headers({ [INVITE_SIGN_UP_TOKEN_HEADER]: TOKEN }) }),
    ).resolves.toBeUndefined();
  });
});
