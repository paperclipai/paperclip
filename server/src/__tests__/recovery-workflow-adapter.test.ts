/**
 * Tests for recoveryWorkflowAdapter
 *
 * Strategy: pure unit tests — all deps fully mocked via vi.fn().
 * No real DB or drizzle-orm needed (deps are injected, not imported).
 *
 * Approach: FALLBACK (not clean planAttempt split).
 * escalateStrandedAssignedIssue is too entangled (interleaved reads + writes:
 * agent resolution, comment dedup, activity log, wakeup enqueue) to extract a
 * pure planAttempt safely. dry-run is read-only, active calls existing fn.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryWorkflowAdapter } from "../services/recovery-workflow-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-21T00:00:00.000Z");
  return {
    id: overrides.id ?? randomUUID(),
    companyId: "company-1",
    sourceIssueId: "issue-1",
    recoveryIssueId: null,
    kind: "stranded_assigned_issue",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-owner",
    ownerUserId: null,
    previousOwnerAgentId: "agent-original",
    returnOwnerAgentId: "agent-original",
    cause: "stranded_assigned_issue",
    fingerprint: "source_scoped_recovery:company-1:issue-1:stranded_assigned_issue",
    evidence: {},
    nextAction: "Restore a live execution path.",
    wakePolicy: { type: "wake_owner", reason: "source_scoped_recovery_action", ownerAgentId: "agent-owner" },
    monitorPolicy: null,
    attemptCount: overrides.attemptCount ?? 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    assigneeAgentId: "agent-original",
    assigneeUserId: null,
    status: "todo",
    identifier: "PAP-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoveryWorkflowAdapter", () => {
  const COMPANY_ID = "company-1";
  const ACTION_ID = randomUUID();
  const SOURCE_ISSUE_ID = "issue-1";
  const HEARTBEAT_INTERVAL_MS = 30_000;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- getState ------------------------------------------------------------

  describe("getState", () => {
    it("returns null when no active recovery action exists", async () => {
      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: vi.fn(),
        getActiveForIssue: vi.fn().mockResolvedValue(null),
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(null),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const state = await adapter.getState(COMPANY_ID, SOURCE_ISSUE_ID);
      expect(state).toBeNull();
    });

    it("returns active=true with attemptCount when action exists", async () => {
      const action = makeActionRow({ id: ACTION_ID, attemptCount: 3 });
      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: vi.fn(),
        getActiveForIssue: vi.fn().mockResolvedValue(action),
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(null),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const state = await adapter.getState(COMPANY_ID, SOURCE_ISSUE_ID);
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.attemptCount).toBe(3);
      expect(state!.status).toBe("active");
    });

    it("returns null when getActiveForIssue returns null (resolved action not surfaced)", async () => {
      // getActiveForIssue only returns active/escalated rows — null means none active
      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: vi.fn(),
        getActiveForIssue: vi.fn().mockResolvedValue(null),
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(null),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const state = await adapter.getState(COMPANY_ID, SOURCE_ISSUE_ID);
      expect(state).toBeNull();
    });
  });

  // ---- performAttempt: dry-run ---------------------------------------------

  describe("performAttempt(mode='dry')", () => {
    it("returns { active, attemptCount, nextIntervalMs } with NO writes", async () => {
      const existingAction = makeActionRow({ id: ACTION_ID, attemptCount: 2 });
      const escalateSpy = vi.fn();
      const fetchIssueSpy = vi.fn();
      const fetchLatestRunSpy = vi.fn();
      const resolveActiveSpy = vi.fn();

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: vi.fn().mockResolvedValue(existingAction),
        resolveActiveForIssue: resolveActiveSpy,
        fetchIssue: fetchIssueSpy,
        fetchLatestRun: fetchLatestRunSpy,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const result = await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 3,
        mode: "dry",
      });

      // Returns plan-like result based on current action state
      expect(result.active).toBe(true);
      expect(result.attemptCount).toBe(2); // not incremented — dry
      expect(result.nextIntervalMs).toBe(HEARTBEAT_INTERVAL_MS);
      expect(typeof result.status).toBe("string");

      // No write-paths called
      expect(escalateSpy).not.toHaveBeenCalled();
      expect(resolveActiveSpy).not.toHaveBeenCalled();
      expect(fetchIssueSpy).not.toHaveBeenCalled();
      expect(fetchLatestRunSpy).not.toHaveBeenCalled();
    });

    it("returns active=false (with 0 attemptCount) when no action exists in dry mode", async () => {
      const escalateSpy = vi.fn();
      const resolveActiveSpy = vi.fn();

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: vi.fn().mockResolvedValue(null),
        resolveActiveForIssue: resolveActiveSpy,
        fetchIssue: vi.fn(),
        fetchLatestRun: vi.fn(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const result = await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 1,
        mode: "dry",
      });

      expect(result.active).toBe(false);
      // Unified sentinel: dry no-action returns "not_found" (same as active path)
      expect(result.status).toBe("not_found");
      expect(result.attemptCount).toBe(0);
      expect(result.nextIntervalMs).toBe(HEARTBEAT_INTERVAL_MS);
      expect(escalateSpy).not.toHaveBeenCalled();
      expect(resolveActiveSpy).not.toHaveBeenCalled();
    });
  });

  // ---- performAttempt: active ----------------------------------------------

  describe("performAttempt(mode='active')", () => {
    it("calls escalateStrandedAssignedIssue exactly once when not yet at attemptNumber", async () => {
      // existing action has attemptCount=1, attemptNumber=2 → should escalate
      const existingAction = makeActionRow({ id: ACTION_ID, attemptCount: 1 });
      const updatedAction = makeActionRow({ id: ACTION_ID, attemptCount: 2 });
      const escalateSpy = vi.fn().mockResolvedValue({ id: SOURCE_ISSUE_ID, status: "blocked" });

      // getActiveForIssue returns existing (count=1) first, then updated (count=2) after escalation
      const getActiveForIssueSpy = vi.fn()
        .mockResolvedValueOnce(existingAction)  // idempotency check
        .mockResolvedValueOnce(updatedAction);  // read-back after escalation

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: getActiveForIssueSpy,
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(makeIssueRow()),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const result = await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 2,
        mode: "active",
      });

      expect(escalateSpy).toHaveBeenCalledTimes(1);
      expect(result.active).toBe(true);
      expect(result.attemptCount).toBe(2);
      expect(result.nextIntervalMs).toBe(HEARTBEAT_INTERVAL_MS);
    });

    it("is idempotent: same attemptNumber when action.attemptCount >= attemptNumber skips escalation", async () => {
      // action already at attemptCount=2, caller sends attemptNumber=2 → dedup
      const existingAction = makeActionRow({ id: ACTION_ID, attemptCount: 2 });
      const escalateSpy = vi.fn();
      const getActiveForIssueSpy = vi.fn().mockResolvedValue(existingAction);

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: getActiveForIssueSpy,
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn(),
        fetchLatestRun: vi.fn(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      // First call — deduped (count=2 >= attemptNumber=2)
      await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 2,
        mode: "active",
      });

      // Second call — also deduped
      await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 2,
        mode: "active",
      });

      // escalate should NOT be called — both deduplicated
      expect(escalateSpy).not.toHaveBeenCalled();
    });

    it("passes the issue's status as previousStatus to escalation", async () => {
      const existingAction = makeActionRow({ id: ACTION_ID, attemptCount: 0 });
      const updatedAction = makeActionRow({ id: ACTION_ID, attemptCount: 1 });
      const escalateSpy = vi.fn().mockResolvedValue({ id: SOURCE_ISSUE_ID, status: "blocked" });

      const getActiveForIssueSpy = vi.fn()
        .mockResolvedValueOnce(existingAction)
        .mockResolvedValueOnce(updatedAction);

      const issueRow = makeIssueRow({ status: "in_progress" });

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: getActiveForIssueSpy,
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(issueRow),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 1,
        mode: "active",
      });

      expect(escalateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ previousStatus: "in_progress" }),
      );
    });

    it("threads the configured recoveryCause through to escalation", async () => {
      const existingAction = makeActionRow({ id: ACTION_ID, attemptCount: 0 });
      const updatedAction = makeActionRow({ id: ACTION_ID, attemptCount: 1 });
      const escalateSpy = vi.fn().mockResolvedValue({ id: SOURCE_ISSUE_ID, status: "blocked" });

      const getActiveForIssueSpy = vi.fn()
        .mockResolvedValueOnce(existingAction)
        .mockResolvedValueOnce(updatedAction);

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: escalateSpy,
        getActiveForIssue: getActiveForIssueSpy,
        resolveActiveForIssue: vi.fn(),
        fetchIssue: vi.fn().mockResolvedValue(makeIssueRow()),
        fetchLatestRun: vi.fn().mockResolvedValue(null),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        recoveryCause: "successful_run_missing_state",
      });

      await adapter.performAttempt({
        companyId: COMPANY_ID,
        actionId: ACTION_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        attemptNumber: 1,
        mode: "active",
      });

      expect(escalateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryCause: "successful_run_missing_state" }),
      );
    });
  });

  // ---- resolve / escalate wrappers ----------------------------------------

  describe("resolve", () => {
    it("delegates to resolveActiveForIssue with the provided input", async () => {
      const resolvedAction = makeActionRow({ id: ACTION_ID, status: "resolved", outcome: "restored" });
      const resolveActiveSpy = vi.fn().mockResolvedValue(resolvedAction);

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: vi.fn(),
        getActiveForIssue: vi.fn(),
        resolveActiveForIssue: resolveActiveSpy,
        fetchIssue: vi.fn(),
        fetchLatestRun: vi.fn(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const result = await adapter.resolve({
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        actionId: ACTION_ID,
        status: "resolved",
        outcome: "restored",
      });

      expect(resolveActiveSpy).toHaveBeenCalledTimes(1);
      expect(resolveActiveSpy).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        actionId: ACTION_ID,
        status: "resolved",
        outcome: "restored",
      });
      expect(result).toEqual(resolvedAction);
    });
  });

  describe("escalate", () => {
    it("calls resolveActiveForIssue with status=cancelled, outcome=escalated", async () => {
      const cancelledAction = makeActionRow({ id: ACTION_ID, status: "cancelled", outcome: "escalated" });
      const resolveActiveSpy = vi.fn().mockResolvedValue(cancelledAction);

      const adapter = recoveryWorkflowAdapter({
        escalateStrandedAssignedIssue: vi.fn(),
        getActiveForIssue: vi.fn(),
        resolveActiveForIssue: resolveActiveSpy,
        fetchIssue: vi.fn(),
        fetchLatestRun: vi.fn(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      });

      const result = await adapter.escalate({
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        actionId: ACTION_ID,
      });

      expect(resolveActiveSpy).toHaveBeenCalledTimes(1);
      expect(resolveActiveSpy).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        actionId: ACTION_ID,
        status: "cancelled",
        outcome: "escalated",
      });
      expect(result).toEqual(cancelledAction);
    });
  });
});
