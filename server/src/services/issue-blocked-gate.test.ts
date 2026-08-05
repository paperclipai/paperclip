import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_CREATE_REQUIRES_SANCTIONED_REASON_MESSAGE,
  BLOCKED_REQUIRES_SANCTIONED_REASON_MESSAGE,
  DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE,
  ISSUE_BLOCKED_GATE_PAYLOAD_KEYS,
  blockedGateLinesCarryDate,
  dateGatedBlockerMissingExecutor,
  hasExplicitExternalOwnerAction,
  hasSanctionedNoLinkBlockReason,
  hasUnblockDescriptor,
  unblockDescriptorHasDateGate,
} from "./issue-blocked-gate.js";

// The verbatim TSMC-18564 description — one of the three cards whose 14:30 Europe/Dublin
// gate blew unexecuted on 2026-07-31. Its date sits in the sanctioned `External action:`
// line ("on or after Friday, July 31, 2026 at 14:30 Europe/Dublin"), long-date form.
const TSMC_18564_DESCRIPTION = readFileSync(
  fileURLToPath(new URL("./__fixtures__/tsmc-18564-description.txt", import.meta.url)),
  "utf8",
);

// The dateless gate lines the recovery escalation writers stamp when they have nothing to
// link (kept in sync with withRecoveryExternalGateDescription in recovery/service.ts).
const RECOVERY_STAMPED_GATE_LINES = [
  "External owner: board operator (stranded-work recovery)",
  "External action: restore a live execution path for this issue or record the manual resolution, then move it out of blocked.",
].join("\n");

describe("dateGatedBlockerMissingExecutor (TSMC-18729 Layer 2)", () => {
  it("rejects the verbatim TSMC-18564 gate with local-board and no assigneeAgentId", () => {
    // assigneeUserId: local-board carries no assigneeAgentId — the exact shape that opened onto nobody.
    expect(
      dateGatedBlockerMissingExecutor({
        description: TSMC_18564_DESCRIPTION,
        assigneeAgentId: null,
      }),
    ).toBe(true);
  });

  it("accepts the same TSMC-18564 gate once a permissioned agent lane is named", () => {
    expect(
      dateGatedBlockerMissingExecutor({
        description: TSMC_18564_DESCRIPTION,
        assigneeAgentId: "agent_live_lane",
      }),
    ).toBe(false);
  });

  it("leaves a dateless external-review wait unaffected even with no assigneeAgentId", () => {
    const datelessWait = [
      "Purpose: wait for the board to approve the launch copy.",
      "",
      "External owner: board operator",
      "External action: review the launch copy and close this blocker once approved.",
    ].join("\n");
    expect(hasExplicitExternalOwnerAction(datelessWait)).toBe(true);
    expect(blockedGateLinesCarryDate(datelessWait)).toBe(false);
    expect(
      dateGatedBlockerMissingExecutor({ description: datelessWait, assigneeAgentId: null }),
    ).toBe(false);
  });

  it("stays inert for the dateless gate lines the recovery writers stamp", () => {
    expect(blockedGateLinesCarryDate(RECOVERY_STAMPED_GATE_LINES)).toBe(false);
    expect(
      dateGatedBlockerMissingExecutor({
        description: RECOVERY_STAMPED_GATE_LINES,
        assigneeAgentId: null,
      }),
    ).toBe(false);
  });

  it("does not trip on dates that live outside the sanctioned gate lines", () => {
    const datesElsewhere = [
      "Purpose: ship the report before 2026-08-15.",
      "Acceptance: verified on or after Friday, July 31, 2026.",
      "",
      "External owner: board operator",
      "External action: review and close this blocker once approved.",
    ].join("\n");
    expect(blockedGateLinesCarryDate(datesElsewhere)).toBe(false);
    expect(
      dateGatedBlockerMissingExecutor({ description: datesElsewhere, assigneeAgentId: null }),
    ).toBe(false);
  });

  it("detects an ISO date inside the gate lines", () => {
    const isoGate = [
      "External owner: local-board",
      "External action: on or after 2026-07-31, wake a lane and close this blocker.",
    ].join("\n");
    expect(blockedGateLinesCarryDate(isoGate)).toBe(true);
    expect(
      dateGatedBlockerMissingExecutor({ description: isoGate, assigneeAgentId: null }),
    ).toBe(true);
    expect(
      dateGatedBlockerMissingExecutor({ description: isoGate, assigneeAgentId: "agent_x" }),
    ).toBe(false);
  });

  it("treats a non-string or empty description as non-blocking", () => {
    expect(blockedGateLinesCarryDate(undefined)).toBe(false);
    expect(blockedGateLinesCarryDate("")).toBe(false);
    expect(dateGatedBlockerMissingExecutor({ description: null, assigneeAgentId: null })).toBe(false);
  });

  it("names the required field in the rejection message", () => {
    expect(DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE).toMatch(/assigneeAgentId/);
  });
});

describe("first-class unblockDescriptor date gate (TSMC-19681)", () => {
  const dateGateDescriptor = {
    owner: "board" as const,
    action: "Wait until the sprint window opens",
    blockedUntil: "2026-08-10T14:00:00.000Z",
  };

  it("treats a validated unblockDescriptor as a sanctioned no-link block without blockedByIssueIds", () => {
    expect(hasUnblockDescriptor(dateGateDescriptor)).toBe(true);
    expect(hasSanctionedNoLinkBlockReason({
      description: "no external lines",
      unblockDescriptor: dateGateDescriptor,
    })).toBe(true);
    expect(hasSanctionedNoLinkBlockReason({
      description: null,
      unblockDescriptor: { owner: "board", action: "External review" },
    })).toBe(true);
    expect(hasSanctionedNoLinkBlockReason({
      description: null,
      unblockDescriptor: { owner: "board", action: "   " },
    })).toBe(false);
    expect(hasSanctionedNoLinkBlockReason({ description: null, unblockDescriptor: null })).toBe(false);
  });

  it("recognizes blockedUntil as a first-class date gate and still requires assigneeAgentId", () => {
    expect(unblockDescriptorHasDateGate(dateGateDescriptor)).toBe(true);
    expect(unblockDescriptorHasDateGate({
      owner: "board",
      action: "External review",
      blockedUntil: null,
    })).toBe(false);
    expect(unblockDescriptorHasDateGate({
      owner: "board",
      action: "External review",
      blockedUntil: "not-a-timestamp",
    })).toBe(false);
    expect(dateGatedBlockerMissingExecutor({
      description: null,
      assigneeAgentId: null,
      unblockDescriptor: dateGateDescriptor,
    })).toBe(true);
    expect(dateGatedBlockerMissingExecutor({
      description: null,
      assigneeAgentId: "agent_live_lane",
      unblockDescriptor: dateGateDescriptor,
    })).toBe(false);
  });

  it("exports the issue read payload key contract for blocked-gate consumers", () => {
    expect([...ISSUE_BLOCKED_GATE_PAYLOAD_KEYS]).toEqual([
      "status",
      "unblockDescriptor",
      "blockedBy",
      "blockedTransitionAt",
      "blockedOwnerNotifiedAt",
      "monitorNextCheckAt",
      "executionPolicy",
    ]);
    expect(BLOCKED_REQUIRES_SANCTIONED_REASON_MESSAGE).toMatch(/unblockDescriptor/);
    expect(BLOCKED_CREATE_REQUIRES_SANCTIONED_REASON_MESSAGE).toMatch(/unblockDescriptor/);
    expect(DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE).toMatch(/blockedUntil/);
  });
});
