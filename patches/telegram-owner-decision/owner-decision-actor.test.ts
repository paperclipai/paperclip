import { describe, expect, it, vi } from "vitest";
import {
  extractCanonicalUserId,
  normalizeBoardAccessActorState,
  ownerDecisionActorFailureMessage,
  resolveOwnerDecisionActorUserId,
} from "./owner-decision-actor.ts";

describe("Telegram owner-decision actor resolution", () => {
  it("treats identity as display-only and never uses it as actorUserId", async () => {
    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: {
        paperclipBoardApiTokenRef: "secret-1",
        identity: "Owner Display Name",
        actorUserId: null,
        companyId: "company-1",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      companyId: "company-1",
      boardApiToken: "board-token",
      fetchCliAuthMe: async () => ({
        userId: "user-canonical-1",
        user: { id: "user-canonical-1", displayName: "Owner Display Name" },
      }),
    });

    expect(result).toEqual({
      ok: true,
      actorUserId: "user-canonical-1",
      displayIdentity: "Owner Display Name",
      recovered: true,
    });
    expect(result.ok && result.actorUserId).not.toBe("Owner Display Name");
  });

  it("uses /api/cli-auth/me userId as the canonical actorUserId", async () => {
    const fetchCliAuthMe = vi.fn(async () => ({
      userId: "user-from-top-level",
      user: { id: "user-from-nested" },
    }));

    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: normalizeBoardAccessActorState({
        paperclipBoardApiTokenRef: "secret-1",
        identity: "ramwee@example.com",
        companyId: "company-1",
      }),
      companyId: "company-1",
      boardApiToken: "board-token",
      fetchCliAuthMe,
    });

    expect(fetchCliAuthMe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      actorUserId: "user-from-top-level",
      recovered: true,
    });
  });

  it("falls back to user.id when userId is absent", () => {
    expect(extractCanonicalUserId({ user: { id: "user-nested-only" } })).toBe("user-nested-only");
    expect(extractCanonicalUserId({})).toBeNull();
  });

  it("recovers legacy board-access state via token introspection without reconnect", async () => {
    const legacy = normalizeBoardAccessActorState({
      paperclipBoardApiTokenRef: "secret-legacy",
      identity: "Legacy Owner",
      // no actorUserId field in legacy payloads
      companyId: "company-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(legacy.actorUserId).toBeNull();

    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: legacy,
      companyId: "company-1",
      boardApiToken: "existing-board-token",
      fetchCliAuthMe: async () => ({ userId: "recovered-user-id" }),
    });

    expect(result).toEqual({
      ok: true,
      actorUserId: "recovered-user-id",
      displayIdentity: "Legacy Owner",
      recovered: true,
    });
  });

  it("reuses a cached actorUserId without calling /api/cli-auth/me again", async () => {
    const fetchCliAuthMe = vi.fn(async () => ({ userId: "should-not-run" }));
    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: {
        paperclipBoardApiTokenRef: "secret-1",
        identity: "Owner",
        actorUserId: "cached-user-id",
        companyId: "company-1",
        updatedAt: null,
      },
      companyId: "company-1",
      boardApiToken: "board-token",
      fetchCliAuthMe,
    });

    expect(fetchCliAuthMe).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      actorUserId: "cached-user-id",
      displayIdentity: "Owner",
      recovered: false,
    });
  });

  it("fails closed on company mismatch", async () => {
    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: {
        paperclipBoardApiTokenRef: "secret-1",
        identity: "Owner",
        actorUserId: "cached-user-id",
        companyId: "company-a",
        updatedAt: null,
      },
      companyId: "company-b",
      boardApiToken: "board-token",
      fetchCliAuthMe: async () => ({ userId: "user-1" }),
    });

    expect(result).toEqual({ ok: false, reason: "company_mismatch" });
    expect(ownerDecisionActorFailureMessage("company_mismatch")).toBe(
      "Board access company mismatch",
    );
  });

  it("fails closed when the board token is missing", async () => {
    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: {
        paperclipBoardApiTokenRef: null,
        identity: "Owner Display Name",
        actorUserId: null,
        companyId: "company-1",
        updatedAt: null,
      },
      companyId: "company-1",
      boardApiToken: null,
      fetchCliAuthMe: async () => ({ userId: "user-1" }),
    });

    expect(result).toEqual({ ok: false, reason: "missing_token" });
    expect(ownerDecisionActorFailureMessage("missing_token")).toContain("Connect board access");
  });

  it("fails closed when the board token is invalid", async () => {
    const result = await resolveOwnerDecisionActorUserId({
      boardAccess: {
        paperclipBoardApiTokenRef: "secret-1",
        identity: "Owner",
        actorUserId: null,
        companyId: null,
        updatedAt: null,
      },
      companyId: "company-1",
      boardApiToken: "bad-token",
      fetchCliAuthMe: async () => {
        throw new Error("401 unauthorized");
      },
    });

    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("documents once-only success semantics for a pending board_only request_confirmation", () => {
    // The worker rechecks kind/status/policy before respondInteraction and treats
    // applied === false as "Decision already resolved". This keeps the overlay
    // contract inspectable next to the actor-resolution tests.
    const pending = {
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "board_only",
    };
    const alreadyResolved = { ...pending, status: "accepted" as const };
    expect(pending.status === "pending" && pending.kind === "request_confirmation").toBe(true);
    expect(alreadyResolved.status === "pending").toBe(false);
  });
});
