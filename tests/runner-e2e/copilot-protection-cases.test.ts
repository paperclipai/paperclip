import { createHash } from "node:crypto";
import { matchCopilotFixtureCommand } from "./copilot-protection-evidence.js";
import { describe, expect, it } from "vitest";
import { copilotProtectionCases, gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite, type CopilotAttachedSettlementEvidence, type CopilotDeniedWriteEvidence } from "./copilot-protection-cases.js";
const identity = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tool" };
const terminal = { observedAtMs: 50, runId: "run", turnId: "turn", status: "succeeded" as const };
const cleanup = { observedAtMs: 60, ownedProcessesRemaining: 0 };
function denied(): CopilotDeniedWriteEvidence {
  return {
    expected: identity, terminal: { ...terminal, status: "cancelled" }, cleanup, settlement: { schema: "paperclip.e2e.copilot-denial-settlement.v3", ...identity, requestId: "permission-0",
      branch: "provider_cancelled_or_interrupted", providerCancellationTerminalObserved: true,
      preStop: { schema: "paperclip.e2e.copilot-pre-stop-observation.v2" as const, ...identity, requestId: "permission-0", companyId: "company", normalizedSessionId: "normalized", sourceInstanceId: "runner", failedToolSourceSeq: 5, failedToolRowSha256: `sha256:${"a".repeat(64)}`, terminal: null, apiReadCompletedMonotonicNs: "10", cancellationRequestId: "11111111-1111-4111-8111-111111111111" }, stopDispatchMonotonicNs: "20",
      providerTerminal: { rowSha256: `sha256:${"b".repeat(64)}`, failedToolRowSha256: `sha256:${"a".repeat(64)}`, eventType: "turn.cancelled", normalizedSessionId: "normalized", sourceInstanceId: "runner", requestSourceSeq: 1, resolvedSourceSeq: 2, deliveredSourceSeq: 3, failedNoticeSourceSeq: 4, failedToolSourceSeq: 5, failedToolRowCreatedAtMs: 31, sourceSeq: 6, emittedAtMs: 50, rowCreatedAtMs: 51 },
      runStop: { companyId: "company", issueId: "issue", scope: "run", status: "cancelled", issueStatus: "in_progress", intentId: "native-cancellation:11111111-1111-4111-8111-111111111111", intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit", requestedAtMs: 40, recordedAtMs: 41, acknowledgedAtMs: 52, finishedAtMs: 53 } }, requestId: "permission-0", expectedRelativePath: "copilot-denied-nonce.txt",
    request: { ...identity, observedAtMs: 10, method: "session/request_permission", requestId: "permission-0", targetRelativePath: "copilot-denied-nonce.txt", offeredActions: ["accept", "decline"] },
    decision: { ...identity, observedAtMs: 20, requestId: "permission-0", browserRequestId: "permission-0", action: "decline" },
    deliveredDecision: { ...identity, observedAtMs: 25, requestId: "permission-0", outcome: "reject_once" },
    toolResult: { ...identity, observedAtMs: 30, status: "failed" }, nativeAttemptsForTarget: 1,
    fileObservations: [
      { phase: "before-request", observedAtMs: 0, exists: false, providerCursor: null }, { phase: "pending", observedAtMs: 15, exists: false, providerCursor: { runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "runner", sourceSeq: 1 } },
      { phase: "after-decision", observedAtMs: 25, exists: false, providerCursor: { runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "runner", sourceSeq: 4 } }, { phase: "terminal", observedAtMs: 50, exists: false, providerCursor: { runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "runner", sourceSeq: 6 } },
      { phase: "after-cleanup", observedAtMs: 60, exists: false, providerCursor: { runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "runner", sourceSeq: 6 } },
    ],
    mutationObservation: { startedAtMs: 0, endedAtMs: 60, complete: true, targetMutationCount: 0 },
  };
}
function attached(): CopilotAttachedSettlementEvidence {
  const command = "'/pinned/node' '/fixture/client.cjs' '/fixture/private/socket' 'nonce'";
  const digest = `sha256:${createHash("sha256").update(command).digest("hex")}`;
  return {
    expected: identity, terminal: { ...terminal }, cleanup: { ...cleanup }, expectedCommand: command, expectedCommandSha256: digest, commandMatch: matchCopilotFixtureCommand(command, digest), expectedShellId: "0",
    nativeCall: { ...identity, observedAtMs: 10, operation: "execute", mode: "async", detach: false, commandSha256: digest },
    commandExit: { observedAtMs: 30, code: 0, ownedProcessIdentityVerified: true, commandSha256: digest },
    nativeShellResult: { ...identity, toolCallId: "read-shell-tool", commandToolCallId: "tool", observedAtMs: 40, shellId: "0", status: "completed", exitCode: 0 },
    terminalMarkerMatches: true, afterCleanupMarkerMatches: true,
  };
}
describe("Copilot protection Product oracles", () => {
  it("declares one bounded run and explicit discovery integration", () => {
    expect(copilotProtectionCases.map(c => c.id)).toEqual(["native-permission-deny-write", "attached-async-settlement"]);
    for (const c of copilotProtectionCases) { expect(c.expectedRunCount).toBe(1); expect(c.providerTimeoutSec).toBe(120); expect(c.integration).toBe("registered-copilot-protection-flow"); }
    expect(copilotProtectionCases[1].prompt("nonce")).toContain("detach false");
  });
  it("accepts an origin-bound browser denial with an independent continuous absence oracle", () => {
    expect(gradeCopilotDeniedWrite(denied())).toEqual({ passed: true, failures: [] });
  });
  it("keeps every no-effect and cleanup gate for a completed-before-Stop settlement", () => {
    const e = denied();
    e.settlement!.branch = "provider_completed_observed_before_stop";
    e.settlement!.providerCancellationTerminalObserved = false;
    e.settlement!.providerTerminal.eventType = "turn.completed";
    e.settlement!.preStop.terminal = { eventType: "turn.completed", sourceSeq: 6, rowSha256: e.settlement!.providerTerminal.rowSha256 };
    expect(gradeCopilotDeniedWrite(e).passed).toBe(true);
    for (const mutate of [
      (v: CopilotDeniedWriteEvidence) => { v.cleanup!.ownedProcessesRemaining = 1; },
      (v: CopilotDeniedWriteEvidence) => { v.nativeAttemptsForTarget = 2; },
      (v: CopilotDeniedWriteEvidence) => { v.fileObservations[2]!.exists = true; },
      (v: CopilotDeniedWriteEvidence) => { v.mutationObservation!.targetMutationCount = 1; },
      (v: CopilotDeniedWriteEvidence) => { v.mutationObservation!.complete = false; },
      (v: CopilotDeniedWriteEvidence) => { v.deliveredDecision = null; },
      (v: CopilotDeniedWriteEvidence) => { v.toolResult!.status = "completed"; },
      (v: CopilotDeniedWriteEvidence) => { v.settlement!.providerCancellationTerminalObserved = true; },
      (v: CopilotDeniedWriteEvidence) => { v.settlement!.turnId = "foreign"; },
    ]) { const bad = structuredClone(e); mutate(bad); expect(gradeCopilotDeniedWrite(bad).passed).toBe(false); }
  });
  it.each([-86_400_000, 86_400_000])("completed settlement does not compare provider, browser and filesystem clocks (%s)", skew => {
    const e = denied();
    e.settlement!.branch = "provider_completed_observed_before_stop";
    e.settlement!.providerCancellationTerminalObserved = false;
    e.settlement!.providerTerminal.eventType = "turn.completed";
    e.settlement!.preStop.terminal = { eventType: "turn.completed", sourceSeq: 6, rowSha256: e.settlement!.providerTerminal.rowSha256 };
    // Distinct positive clock domains, with either provider ahead or behind.
    for (const n of [e.request!, e.deliveredDecision!, e.toolResult!, e.terminal!]) n.observedAtMs += 100_000_000 + skew;
    e.settlement!.providerTerminal.emittedAtMs = e.terminal!.observedAtMs;
    e.decision!.observedAtMs = 200_000_000;
    expect(gradeCopilotDeniedWrite(e).passed).toBe(true);
    e.fileObservations[1]!.providerCursor!.sourceSeq = e.settlement!.providerTerminal.resolvedSourceSeq;
    expect(gradeCopilotDeniedWrite(e).failures).toContain("filesystem-observation-order-invalid");
  });
  it.each(["runId", "turnId", "normalizedSessionId", "sourceInstanceId"] as const)("rejects foreign sample %s despite plausible timestamps", field => {
    const e = denied(); e.fileObservations[3]!.providerCursor![field] = "foreign";
    expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("rejects missing, regressed and premature causal sample cursors", () => {
    for (const mutate of [
      (e: CopilotDeniedWriteEvidence) => { e.fileObservations[2]!.providerCursor = null; },
      (e: CopilotDeniedWriteEvidence) => { e.fileObservations[2]!.providerCursor!.sourceSeq = 3; },
      (e: CopilotDeniedWriteEvidence) => { e.fileObservations[3]!.providerCursor!.sourceSeq = 5; },
      (e: CopilotDeniedWriteEvidence) => { e.fileObservations[4]!.providerCursor!.sourceSeq = 5; },
    ]) { const e = denied(); mutate(e); expect(gradeCopilotDeniedWrite(e).passed).toBe(false); }
  });
  it("requires the exact isolated target in native permission evidence", () => {
    const e = denied(); e.expectedRelativePath = "pc-denied-ABC123/copilot-denied-nonce.txt";
    expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
    e.request!.targetRelativePath = e.expectedRelativePath;
    expect(gradeCopilotDeniedWrite(e).passed).toBe(true);
    for (const path of ["../copilot-denied-nonce.txt", "other/copilot-denied-nonce.txt", "pc-denied-ABC123/../copilot-denied-nonce.txt"]) {
      e.expectedRelativePath = path; e.request!.targetRelativePath = path;
      expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
    }
  });
  it.each(["request", "decision", "deliveredDecision", "toolResult", "terminal", "cleanup", "mutationObservation", "settlement"] as const)("rejects missing %s instead of treating no write as denial", field => {
    const e = denied(); e[field] = null; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("requires explicit acknowledged cancellation for denial without relaxing successful settlement", () => {
    const e = denied(); e.settlement = null; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
    const finished = denied(); finished.terminal!.status = "succeeded"; expect(gradeCopilotDeniedWrite(finished).passed).toBe(false);
    const cancelled = attached(); cancelled.terminal!.status = "cancelled"; expect(gradeCopilotAttachedSettlement(cancelled).passed).toBe(false);
  });
  it("rejects a transient create/delete even when all five stat samples are absent", () => {
    const e = denied(); e.mutationObservation!.targetMutationCount = 2; expect(gradeCopilotDeniedWrite(e).failures).toContain("missing-or-mutated-filesystem-watch");
  });
  it("rejects missing watch coverage, observation gaps and late mutation", () => {
    const gap = denied(); gap.mutationObservation!.complete = false; expect(gradeCopilotDeniedWrite(gap).passed).toBe(false);
    const missing = denied(); missing.fileObservations.pop(); expect(gradeCopilotDeniedWrite(missing).passed).toBe(false);
    const late = denied(); late.fileObservations.at(-1)!.exists = true; expect(gradeCopilotDeniedWrite(late).passed).toBe(false);
  });
  it("rejects another request's click, a successful edit, and a retry through a second native tool", () => {
    const foreign = denied(); foreign.decision!.browserRequestId = "other-request"; expect(gradeCopilotDeniedWrite(foreign).passed).toBe(false);
    const success = denied(); success.toolResult!.status = "completed"; expect(gradeCopilotDeniedWrite(success).passed).toBe(false);
    const retried = denied(); retried.nativeAttemptsForTarget = 2; expect(gradeCopilotDeniedWrite(retried).passed).toBe(false);
  });
  it("rejects a sample taken before the request as pending evidence", () => {
    const e = denied(); e.fileObservations[1]!.providerCursor!.sourceSeq = 0; expect(gradeCopilotDeniedWrite(e).failures).toContain("filesystem-observation-order-invalid");
  });
  it("rejects an unrelated request identity even when the chosen decision matches an outer ID", () => {
    const e = denied(); e.request!.requestId = "foreign-request"; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("accepts attached async completion using a separately correlated read_bash call", () => {
    expect(gradeCopilotAttachedSettlement(attached())).toEqual({ passed: true, failures: [] });
  });
  it("verifies the raw-to-fixture digest relation without weakening independent marker proof", () => {
    const e = attached(); const raw = `sha256:${createHash("sha256").update(" " + e.expectedCommand).digest("hex")}`;
    e.nativeCall!.commandSha256 = raw; e.commandMatch = matchCopilotFixtureCommand(e.expectedCommand, raw);
    expect(e.commandMatch?.leadingWhitespace).toBe(" ");
    expect(gradeCopilotAttachedSettlement(e).passed).toBe(true);
    expect(e.nativeCall!.commandSha256).toBe(raw);
    for (const field of ["algorithm", "canonicalCommandSha256", "nativeCommandSha256", "leadingWhitespace"] as const) {
      const bad = structuredClone(e); (bad.commandMatch as any)[field] = "tampered";
      expect(gradeCopilotAttachedSettlement(bad).passed).toBe(false);
    }
    const missing = structuredClone(e); missing.commandMatch = null; expect(gradeCopilotAttachedSettlement(missing).passed).toBe(false);
    const forged = structuredClone(e); forged.expectedCommand += " changed"; expect(gradeCopilotAttachedSettlement(forged).passed).toBe(false);
    const unbound = structuredClone(e); unbound.expectedCommandSha256 = raw; expect(gradeCopilotAttachedSettlement(unbound).passed).toBe(false);
    const wrongExit = structuredClone(e); wrongExit.commandExit!.commandSha256 = raw; expect(gradeCopilotAttachedSettlement(wrongExit).passed).toBe(false);
    e.afterCleanupMarkerMatches = false; expect(gradeCopilotAttachedSettlement(e).passed).toBe(false);
  });
  it.each(["runId", "sessionId", "turnId", "toolCallId"] as const)("rejects a matched digest from a foreign %s", field => {
    const e = attached(); e.nativeCall![field] = "foreign";
    expect(gradeCopilotAttachedSettlement(e).passed).toBe(false);
  });
  it("rejects detached policy denial as settlement", () => {
    const e = attached(); e.nativeCall!.detach = true; expect(gradeCopilotAttachedSettlement(e).failures).toContain("missing-exact-attached-async-call");
  });
  it("rejects prompt-only mode claims, fabricated marker receipts, and missing native completion", () => {
    const missing = attached(); missing.nativeCall = null; expect(gradeCopilotAttachedSettlement(missing).passed).toBe(false);
    const fake = attached(); fake.commandExit!.ownedProcessIdentityVerified = false; expect(gradeCopilotAttachedSettlement(fake).passed).toBe(false);
    const incomplete = attached(); incomplete.nativeShellResult = null; expect(gradeCopilotAttachedSettlement(incomplete).passed).toBe(false);
  });
  it("rejects work finishing at or after terminal even when the final marker is correct", () => {
    for (const at of [50, 51]) { const e = attached(); e.commandExit!.observedAtMs = at; expect(gradeCopilotAttachedSettlement(e).passed).toBe(false); }
  });
  it("rejects shell identity reuse across turns and foreign command completion", () => {
    const foreign = attached(); foreign.nativeShellResult!.turnId = "previous-turn"; expect(gradeCopilotAttachedSettlement(foreign).passed).toBe(false);
    const other = attached(); other.nativeShellResult!.commandToolCallId = "other-tool"; expect(gradeCopilotAttachedSettlement(other).passed).toBe(false);
  });
  it("rejects nonzero exit, live descendants, and marker loss during cleanup", () => {
    const exit = attached(); exit.commandExit!.code = 1; expect(gradeCopilotAttachedSettlement(exit).passed).toBe(false);
    const live = attached(); live.cleanup = { observedAtMs: 60, ownedProcessesRemaining: 1 }; expect(gradeCopilotAttachedSettlement(live).passed).toBe(false);
    const marker = attached(); marker.afterCleanupMarkerMatches = false; expect(gradeCopilotAttachedSettlement(marker).passed).toBe(false);
  });
});
