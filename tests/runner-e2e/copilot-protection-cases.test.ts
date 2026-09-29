import { describe, expect, it } from "vitest";
import { copilotProtectionCases, gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite, type CopilotAttachedSettlementEvidence, type CopilotDeniedWriteEvidence } from "./copilot-protection-cases.js";
const identity = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tool" };
const terminal = { observedAtMs: 50, runId: "run", turnId: "turn", status: "succeeded" as const };
const cleanup = { observedAtMs: 60, ownedProcessesRemaining: 0 };
function denied(): CopilotDeniedWriteEvidence {
  return {
    expected: identity, terminal: { ...terminal, status: "cancelled" }, cleanup, cancellation: { requestedAtMs: 40, acknowledged: true, scope: "run" }, requestId: "permission-0", expectedRelativePath: "copilot-denied-nonce.txt",
    request: { ...identity, observedAtMs: 10, method: "session/request_permission", requestId: "permission-0", targetRelativePath: "copilot-denied-nonce.txt", offeredActions: ["accept", "decline"] },
    decision: { ...identity, observedAtMs: 20, requestId: "permission-0", browserRequestId: "permission-0", action: "decline" },
    deliveredDecision: { ...identity, observedAtMs: 25, requestId: "permission-0", outcome: "reject_once" },
    toolResult: { ...identity, observedAtMs: 30, status: "failed" }, nativeAttemptsForTarget: 1,
    fileObservations: [
      { phase: "before-request", observedAtMs: 0, exists: false }, { phase: "pending", observedAtMs: 15, exists: false },
      { phase: "after-decision", observedAtMs: 25, exists: false }, { phase: "terminal", observedAtMs: 50, exists: false },
      { phase: "after-cleanup", observedAtMs: 60, exists: false },
    ],
    mutationObservation: { startedAtMs: 0, endedAtMs: 60, complete: true, targetMutationCount: 0 },
  };
}
function attached(): CopilotAttachedSettlementEvidence {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    expected: identity, terminal: { ...terminal }, cleanup: { ...cleanup }, expectedCommandSha256: digest, expectedShellId: "0",
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
  it.each(["request", "decision", "deliveredDecision", "toolResult", "terminal", "cleanup", "mutationObservation"] as const)("rejects missing %s instead of treating no write as denial", field => {
    const e = denied(); e[field] = null; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("requires explicit acknowledged cancellation for denial without relaxing successful settlement", () => {
    const e = denied(); e.cancellation = null; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
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
    const e = denied(); e.fileObservations[1]!.observedAtMs = 5; expect(gradeCopilotDeniedWrite(e).failures).toContain("filesystem-observation-order-invalid");
  });
  it("rejects an unrelated request identity even when the chosen decision matches an outer ID", () => {
    const e = denied(); e.request!.requestId = "foreign-request"; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("accepts attached async completion using a separately correlated read_bash call", () => {
    expect(gradeCopilotAttachedSettlement(attached())).toEqual({ passed: true, failures: [] });
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
