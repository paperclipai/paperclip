import { describe, expect, it } from "vitest";
import { buildPaperclipWakePayload, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot } from "./heartbeat/run-preparation.js";
import {
  DIAGNOSTIC_SMOKE_CAPABILITY_WARNING,
  annotateDiagnosticSmokeSnapshot,
  diagnosticSmokeCheckoutBlock,
  diagnosticSmokeCoalesceConflict,
  isDiagnosticSmokeWake,
  readSnapshotTaskBinding,
} from "./diagnostic-smoke-capability-policy.js";

describe("diagnostic smoke capability", () => {
  it("recognizes only the _smoke wake suffix", () => {
    expect(isDiagnosticSmokeWake("claude_reauth_smoke")).toBe(true);
    expect(isDiagnosticSmokeWake("post_restore_smoke")).toBe(true);
    expect(isDiagnosticSmokeWake(" heartbeat_timer ")).toBe(false);
    expect(isDiagnosticSmokeWake("smoke_test_started")).toBe(false);
    expect(isDiagnosticSmokeWake(null)).toBe(false);
  });

  it("reads issueId before taskId and ignores blanks", () => {
    expect(readSnapshotTaskBinding({ issueId: " issue-1 ", taskId: "task-2" })).toBe("issue-1");
    expect(readSnapshotTaskBinding({ taskId: " task-2 " })).toBe("task-2");
    expect(readSnapshotTaskBinding({ issueId: "  " })).toBeNull();
    expect(readSnapshotTaskBinding(null)).toBeNull();
  });

  it("warns an unbound diagnostic smoke and blocks checkout before any task binding", () => {
    const snapshot: Record<string, unknown> = { wakeReason: "claude_reauth_smoke" };
    annotateDiagnosticSmokeSnapshot(snapshot);
    expect(snapshot.diagnosticsOnly).toBe(true);
    expect(snapshot.diagnosticsOnlyCapability).toBe(DIAGNOSTIC_SMOKE_CAPABILITY_WARNING);
    expect(diagnosticSmokeCheckoutBlock(snapshot)).toBe(DIAGNOSTIC_SMOKE_CAPABILITY_WARNING);
  });

  it("leaves a task-bound smoke writable and clears a stale diagnostic flag", () => {
    const snapshot: Record<string, unknown> = {
      wakeReason: "claude_reauth_smoke",
      issueId: "issue-1",
      taskId: "issue-1",
      diagnosticsOnly: true,
      diagnosticsOnlyCapability: "stale",
    };
    annotateDiagnosticSmokeSnapshot(snapshot);
    expect(snapshot.diagnosticsOnly).toBeUndefined();
    expect(snapshot.diagnosticsOnlyCapability).toBeUndefined();
    expect(diagnosticSmokeCheckoutBlock(snapshot)).toBeNull();
  });

  it("does not block timer or ordinary unscoped runs", () => {
    for (const wakeReason of ["heartbeat_timer", "issue_assigned", null]) {
      const snapshot: Record<string, unknown> = { wakeReason };
      annotateDiagnosticSmokeSnapshot(snapshot);
      expect(snapshot.diagnosticsOnly).toBeUndefined();
      expect(diagnosticSmokeCheckoutBlock(snapshot)).toBeNull();
    }
  });

  it("persists the warning when smoke dispatch has no task id", () => {
    const enriched = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "claude_reauth_smoke",
      source: "on_demand",
      triggerDetail: "manual",
      payload: { reason: "claude_reauth_smoke" },
    });
    expect(enriched.contextSnapshot).toMatchObject({
      wakeReason: "claude_reauth_smoke",
      diagnosticsOnly: true,
      diagnosticsOnlyCapability: DIAGNOSTIC_SMOKE_CAPABILITY_WARNING,
    });
    expect(enriched.contextSnapshot.issueId).toBeUndefined();
  });

  it("binds an explicit smoke task and does not mark the run diagnostic-only", () => {
    const enriched = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "claude_reauth_smoke",
      source: "assignment",
      triggerDetail: "system",
      payload: { issueId: "issue-1" },
    });
    expect(enriched.contextSnapshot.issueId).toBe("issue-1");
    expect(enriched.contextSnapshot.taskId).toBe("issue-1");
    expect(enriched.contextSnapshot.diagnosticsOnly).toBeUndefined();
    expect(diagnosticSmokeCheckoutBlock(enriched.contextSnapshot)).toBeNull();
  });

  it("keeps an unbound timer from sharing a run with an unbound smoke", () => {
    const smoke: Record<string, unknown> = { wakeReason: "claude_reauth_smoke" };
    const timer: Record<string, unknown> = { wakeReason: "heartbeat_timer" };
    annotateDiagnosticSmokeSnapshot(smoke);
    annotateDiagnosticSmokeSnapshot(timer);
    expect(diagnosticSmokeCoalesceConflict(smoke, timer)).toBe(true);
    expect(diagnosticSmokeCoalesceConflict(timer, smoke)).toBe(true);
    expect(diagnosticSmokeCoalesceConflict(smoke, { wakeReason: "post_restore_smoke", diagnosticsOnly: true })).toBe(false);
    expect(diagnosticSmokeCoalesceConflict(timer, { wakeReason: "issue_assigned" })).toBe(false);

    const merged = mergeCoalescedContextSnapshot(smoke, timer);
    expect(merged.wakeReason).toBe("heartbeat_timer");
    expect(merged.diagnosticsOnly).toBeUndefined();
    expect(diagnosticSmokeCheckoutBlock(merged)).toBeNull();

    const kept = mergeCoalescedContextSnapshot(smoke, { wakeReason: "post_restore_smoke" });
    expect(diagnosticSmokeCheckoutBlock(kept)).toBe(DIAGNOSTIC_SMOKE_CAPABILITY_WARNING);
  });

  it("puts the capability warning on a smoke wake that has no issue or comments", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "claude_reauth_smoke",
        diagnosticsOnly: true,
        diagnosticsOnlyCapability: DIAGNOSTIC_SMOKE_CAPABILITY_WARNING,
      },
      wakeCommentRows: [],
    });
    expect(payload).toMatchObject({
      reason: "claude_reauth_smoke",
      diagnosticsOnlyCapability: DIAGNOSTIC_SMOKE_CAPABILITY_WARNING,
      issue: null,
    });
    expect(await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
      wakeCommentRows: [],
    })).toBeNull();
  });
});
