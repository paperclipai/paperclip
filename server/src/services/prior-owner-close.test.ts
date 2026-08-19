import { describe, expect, it } from "vitest";
import {
  evaluatePriorOwnerTerminalCloseGrant,
  isPriorOwnerTerminalClosePatch,
  isRecoverySystemNoticePresentation,
} from "./prior-owner-close.js";

const previousOwnerAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentAssigneeAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recoveryCreatedAt = new Date("2026-08-19T12:00:00.000Z");

describe("isPriorOwnerTerminalClosePatch", () => {
  it("allows status-only done and cancelled patches", () => {
    expect(isPriorOwnerTerminalClosePatch({ status: "done" })).toBe(true);
    expect(isPriorOwnerTerminalClosePatch({ status: "cancelled" })).toBe(true);
  });

  it("allows an append-only comment alongside terminal status", () => {
    expect(isPriorOwnerTerminalClosePatch({ status: "done", comment: "Finished." })).toBe(true);
  });

  it("rejects non-terminal status and extra mutate fields", () => {
    expect(isPriorOwnerTerminalClosePatch({ status: "todo" })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "done", description: "rewrite" })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "done", assigneeAgentId: currentAssigneeAgentId })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "done", title: "retitle" })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "done", resume: true })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "done", reopen: true })).toBe(false);
    expect(isPriorOwnerTerminalClosePatch({ status: "cancelled", interrupt: true })).toBe(false);
  });
});

describe("isRecoverySystemNoticePresentation", () => {
  it("treats compact recovery notices as recovery comments", () => {
    expect(isRecoverySystemNoticePresentation({ kind: "system_notice" })).toBe(true);
    expect(isRecoverySystemNoticePresentation({ kind: "callout" })).toBe(false);
    expect(isRecoverySystemNoticePresentation(null)).toBe(false);
  });
});

describe("evaluatePriorOwnerTerminalCloseGrant", () => {
  const base = {
    actorAgentId: previousOwnerAgentId,
    currentAssigneeAgentId,
    previousOwnerAgentId,
    recoveryCreatedAt,
    checkoutRunAgentId: null as string | null,
    comments: [] as Array<{
      authorAgentId?: string | null;
      deletedAt?: Date | null;
      createdAt?: Date;
      presentation?: { kind?: string } | null;
    }>,
  };

  it("allows the previous owner after recovery steal", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant(base)).toEqual({
      allowed: true,
      reason: "allow",
    });
  });

  it("denies a peer who is not the recorded previous owner", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant({
      ...base,
      actorAgentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }).allowed).toBe(false);
  });

  it("revokes after the new owner successfully checkouts", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant({
      ...base,
      checkoutRunAgentId: currentAssigneeAgentId,
    })).toEqual({
      allowed: false,
      reason: "revoked_checkout",
    });
  });

  it("does not revoke on a stale previous-owner checkout lock", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant({
      ...base,
      checkoutRunAgentId: previousOwnerAgentId,
    }).allowed).toBe(true);
  });

  it("revokes after the new owner posts a non-recovery comment", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant({
      ...base,
      comments: [{
        authorAgentId: currentAssigneeAgentId,
        createdAt: new Date("2026-08-19T12:05:00.000Z"),
        presentation: null,
      }],
    })).toEqual({
      allowed: false,
      reason: "revoked_comment",
    });
  });

  it("does not revoke on a recovery system_notice from the new owner", () => {
    expect(evaluatePriorOwnerTerminalCloseGrant({
      ...base,
      comments: [{
        authorAgentId: currentAssigneeAgentId,
        createdAt: new Date("2026-08-19T12:01:00.000Z"),
        presentation: { kind: "system_notice" },
      }],
    }).allowed).toBe(true);
  });
});
