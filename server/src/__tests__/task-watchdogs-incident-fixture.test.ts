import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import incident from "./fixtures/watchdog-confirmation-incident-8bef17ef.json";

describe("historical watchdog confirmation incident fixture", () => {
  it("reproduces the material stop fingerprint", () => {
    const materialPayload = JSON.stringify({
      version: incident.stopSnapshot.version,
      companyId: incident.companyId,
      watchedIssueId: incident.watchdogRun.watchedIssueId,
      materialLeaves: incident.stopSnapshot.materialLeaves,
      waitsByIssueId: incident.stopSnapshot.waitsByIssueId,
    });
    const fingerprint = `task_watchdog_stop:${createHash("sha256").update(materialPayload).digest("hex")}`;

    expect(fingerprint).toBe(incident.watchdogRun.stopFingerprint);
  });

  it("preserves why the watchdog could not resolve the board-only card", () => {
    expect(incident.interactionAtStop).toMatchObject({
      id: "8bef17ef-6df4-4e52-8333-f3a789580be0",
      kind: "request_confirmation",
      status: "pending",
      effectiveResolverPolicy: "board_only",
      sourceRunId: incident.creatorRun.id,
    });
    expect(incident.watchdogAuthorizationAtStop.deniedOperations).toContain(
      "resolve_board_only_or_security_sensitive_approvals",
    );
  });

  it("records manual acceptance without changing audit attribution or retaining a current wait", () => {
    expect(incident.manualAcceptance).toMatchObject({
      status: "accepted",
      resolverPolicy: "board_only",
      resolvedByAgentId: null,
      resolvedByRunId: null,
    });
    expect(incident.manualAcceptance.resolvedByUserId).toBeTruthy();
    expect(incident.descendantPathAtVerification.at(-1)).toMatchObject({
      identifier: "PAP-17237",
      status: "done",
    });
    expect(incident.verification).toEqual({
      historicalInteractionStillPending: false,
      historicalInteractionIsCurrentWait: false,
      auditAttributionChanged: false,
    });
  });
});
