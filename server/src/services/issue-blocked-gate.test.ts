import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE,
  blockedGateLinesCarryDate,
  dateGatedBlockerMissingExecutor,
  hasExplicitExternalOwnerAction,
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
