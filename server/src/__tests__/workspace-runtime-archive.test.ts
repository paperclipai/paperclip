import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Mock: activity-log (used by archiveExecutionWorkspaceForTerminalIssue)
// ---------------------------------------------------------------------------

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// DB stub — queues results for successive select/update calls
// ---------------------------------------------------------------------------

function createDbStub(options: {
  selectResults: unknown[][];
  updateBehaviors?: Array<"resolve" | "throw">;
}) {
  let selectIdx = 0;
  let updateIdx = 0;
  const updateSetCalls: Record<string, unknown>[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = options.selectResults[selectIdx++] ?? [];
          return Promise.resolve(rows);
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((setArg: Record<string, unknown>) => {
        updateSetCalls.push(setArg);
        return {
          where: vi.fn(() => {
            const behavior = options.updateBehaviors?.[updateIdx++];
            if (behavior === "throw") {
              return Promise.reject(new Error("simulated DB failure"));
            }
            return Promise.resolve();
          }),
        };
      }),
    })),
  };

  return { db: db as unknown as Db, updateSetCalls };
}

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "company-1",
    status: "active",
    cwd: null,
    providerType: "project_primary",
    providerRef: null,
    branchName: null,
    repoUrl: null,
    baseRef: null,
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import the function under test AFTER mocks are declared
// ---------------------------------------------------------------------------

const { archiveExecutionWorkspaceForTerminalIssue } = await import(
  "../services/workspace-runtime.js"
);

// ---------------------------------------------------------------------------
// Tests: archiveExecutionWorkspaceForTerminalIssue helper internals
// ---------------------------------------------------------------------------

describe("archiveExecutionWorkspaceForTerminalIssue (helper-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- company-scoped query ----

  it("returns not-found when workspace exists but companyId does not match (query-time scoping)", async () => {
    const { db } = createDbStub({
      selectResults: [
        [], // company-scoped query returns no rows (id matches but companyId doesn't)
      ],
    });

    const result = await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "wrong-company",
    });

    expect(result.archived).toBe(false);
    expect(result.warnings).toContain("workspace not found");
    // Verify select was called (the query runs) but no updates happen
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  // ---- multi-issue guard ----

  it("does not archive when linked issues are still active", async () => {
    const { db, updateSetCalls } = createDbStub({
      selectResults: [
        [makeWorkspace()], // workspace found
        [
          { id: "issue-1", status: "done" },
          { id: "issue-2", status: "in_progress" }, // still active
        ],
      ],
    });

    const result = await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
    });

    expect(result.archived).toBe(false);
    expect(result.warnings).toEqual(["1 linked issue(s) still active"]);
    // No update should happen — the guard returns before any DB mutation
    expect(updateSetCalls).toHaveLength(0);
  });

  it("archives when all linked issues are terminal", async () => {
    const { db, updateSetCalls } = createDbStub({
      selectResults: [
        [makeWorkspace()],
        [
          { id: "issue-1", status: "done" },
          { id: "issue-2", status: "cancelled" },
        ],
      ],
    });

    const result = await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
    });

    expect(result.archived).toBe(true);
    expect(updateSetCalls[0]).toEqual(
      expect.objectContaining({ status: "archived" }),
    );
  });

  // ---- cleanup_failed fallback ----

  it("sets cleanup_failed when stop-services throws", async () => {
    const { db, updateSetCalls } = createDbStub({
      selectResults: [
        [makeWorkspace()],
        [{ id: "issue-1", status: "done" }], // all terminal
      ],
      updateBehaviors: [
        "resolve", // 1st update: set status=archived
        "throw",   // 2nd update: markPersistedRuntimeServicesStopped → throws
        "resolve", // 3rd update: catch block sets cleanup_failed
      ],
    });

    const result = await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
      actor: { actorType: "system", actorId: "system", agentId: null, runId: null },
    });

    // Function still returns archived:true (the workspace was set to archived
    // then to cleanup_failed, but the return value reflects the intent succeeded)
    expect(result.archived).toBe(true);

    // Verify cleanup_failed was set via the catch-block update
    const cleanupFailedUpdate = updateSetCalls.find(
      (call) => call.status === "cleanup_failed",
    );
    expect(cleanupFailedUpdate).toBeDefined();
    expect(cleanupFailedUpdate!.cleanupReason).toBe("simulated DB failure");
  });

  // ---- activity log emission ----

  it("emits execution_workspace.updated activity log with terminal_issue_transition trigger", async () => {
    const { db } = createDbStub({
      selectResults: [
        [makeWorkspace()],
        [{ id: "issue-1", status: "done" }],
      ],
    });

    await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
      actor: {
        actorType: "user",
        actorId: "user-1",
        agentId: "agent-1",
        runId: "run-1",
      },
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "execution_workspace.updated",
        entityType: "execution_workspace",
        entityId: "ws-1",
        details: expect.objectContaining({
          trigger: "terminal_issue_transition",
        }),
      }),
    );
  });

  it("does not emit activity log when no actor is provided", async () => {
    const { db } = createDbStub({
      selectResults: [
        [makeWorkspace()],
        [{ id: "issue-1", status: "cancelled" }],
      ],
    });

    await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
      // no actor
    });

    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("includes cleanupWarnings in activity log when cleanup has warnings", async () => {
    const { db } = createDbStub({
      selectResults: [
        [makeWorkspace()],
        [{ id: "issue-1", status: "done" }],
      ],
      updateBehaviors: [
        "resolve", // archive
        "throw",   // stop services throws → catch sets cleanup_failed
        "resolve", // catch block update
      ],
    });

    await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
      actor: { actorType: "system", actorId: "system", agentId: null, runId: null },
    });

    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        details: expect.objectContaining({
          trigger: "terminal_issue_transition",
          cleanupWarnings: ["simulated DB failure"],
        }),
      }),
    );
  });

  // ---- idempotency ----

  it("returns early without mutation when workspace is already archived", async () => {
    const { db, updateSetCalls } = createDbStub({
      selectResults: [[makeWorkspace({ status: "archived" })]],
    });

    const result = await archiveExecutionWorkspaceForTerminalIssue({
      db,
      executionWorkspaceId: "ws-1",
      companyId: "company-1",
    });

    expect(result.archived).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(updateSetCalls).toHaveLength(0);
  });
});
