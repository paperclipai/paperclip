/**
 * Helper-level tests for archiveTerminalIssueExecutionWorkspace.
 *
 * These tests exercise the REAL helper function (not mocked) through the
 * heartbeat service, using embedded Postgres for the DB and mocked
 * workspace-runtime leaf functions to avoid filesystem/shell side effects.
 *
 * Proves: cleanup-command parity, linked-issue safety, cleanup_failed semantics.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// ---------------------------------------------------------------------------
// Module-level mocks — intercept workspace-runtime leaf functions
// ---------------------------------------------------------------------------

const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() =>
  vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
);

const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return {
    ...original,
    cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
    stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres archive-helper tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCompanyAndProject(db: Db) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "TestCo",
    issuePrefix: "TST",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "TestProject",
    status: "in_progress",
    executionWorkspacePolicy: { enabled: true },
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    sourceType: "local_path",
    isPrimary: true,
    cwd: "/tmp/test-primary",
    cleanupCommand: "echo project-ws-cleanup",
  });

  return { companyId, projectId, projectWorkspaceId };
}

async function insertWorkspace(
  db: Db,
  ids: { companyId: string; projectId: string; projectWorkspaceId: string },
  overrides: Record<string, unknown> = {},
) {
  const workspaceId = randomUUID();
  await db.insert(executionWorkspaces).values({
    id: workspaceId,
    companyId: ids.companyId,
    projectId: ids.projectId,
    projectWorkspaceId: ids.projectWorkspaceId,
    mode: "isolated",
    strategyType: "git_worktree",
    name: "test-workspace",
    status: "active",
    providerType: "git_worktree",
    cwd: "/tmp/test-workspace",
    metadata: { createdByRuntime: true },
    ...overrides,
  });
  return workspaceId;
}

async function insertIssue(
  db: Db,
  companyId: string,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Test issue",
    status: "done",
    identifier: `TST-${Math.floor(Math.random() * 10000)}`,
    issueNumber: Math.floor(Math.random() * 10000),
    executionWorkspaceId: workspaceId,
    ...overrides,
  });
  return issueId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("archiveTerminalIssueExecutionWorkspace (helper-level)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-archive-helper-");
    db = createDb(tempDb.connectionString);
    svc = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // -----------------------------------------------------------------------
  // P1: cleanup-command parity
  // -----------------------------------------------------------------------

  it("passes workspace-config cleanupCommand to cleanupExecutionWorkspaceArtifacts", async () => {
    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids, {
      metadata: {
        createdByRuntime: true,
        config: { cleanupCommand: "pkill -f vite || true" },
      },
    });
    // All linked issues terminal
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });

    const result = await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    expect(result.archived).toBe(true);
    expect(mockCleanupExecutionWorkspaceArtifacts).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockCleanupExecutionWorkspaceArtifacts.mock.calls as any)[0]?.[0] as Record<string, unknown>;
    expect(call.cleanupCommand).toBe("pkill -f vite || true");
  });

  it("passes workspace-config teardownCommand with fallback to project policy", async () => {
    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids, {
      metadata: {
        createdByRuntime: true,
        config: { teardownCommand: "bash teardown.sh" },
      },
    });
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });

    await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockCleanupExecutionWorkspaceArtifacts.mock.calls as any)[0]?.[0] as Record<string, unknown>;
    expect(call.teardownCommand).toBe("bash teardown.sh");
  });

  it("passes projectWorkspace with its cleanupCommand", async () => {
    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids);
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });

    await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockCleanupExecutionWorkspaceArtifacts.mock.calls as any)[0]?.[0] as Record<string, unknown>;
    expect(call.projectWorkspace).toEqual({
      cwd: "/tmp/test-primary",
      cleanupCommand: "echo project-ws-cleanup",
    });
  });

  // -----------------------------------------------------------------------
  // P2: linked-issue safety
  // -----------------------------------------------------------------------

  it("does NOT archive when active linked issues exist", async () => {
    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids);
    // One terminal, one active
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });
    await insertIssue(db, ids.companyId, workspaceId, { status: "in_progress" });

    const result = await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    expect(result.archived).toBe(false);
    expect(result.warnings).toEqual(["1 linked issue(s) still active"]);
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();

    // Verify workspace status unchanged
    const ws = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0]);
    expect(ws?.status).toBe("active");
  });

  it("archives when ALL linked issues are terminal", async () => {
    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids);
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });
    await insertIssue(db, ids.companyId, workspaceId, { status: "cancelled" });

    const result = await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    expect(result.archived).toBe(true);
  });

  // -----------------------------------------------------------------------
  // P3: cleanup_failed semantics
  // -----------------------------------------------------------------------

  it("sets status to cleanup_failed when cleanupExecutionWorkspaceArtifacts returns cleaned:false", async () => {
    mockCleanupExecutionWorkspaceArtifacts.mockResolvedValueOnce({
      cleaned: false,
      warnings: ["worktree removal failed"],
    });

    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids);
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });

    const result = await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    expect(result.archived).toBe(true);
    expect(result.warnings).toEqual(["worktree removal failed"]);

    const ws = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0]);
    expect(ws?.status).toBe("cleanup_failed");
    expect(ws?.cleanupReason).toBe("worktree removal failed");
  });

  it("sets status to cleanup_failed when cleanupExecutionWorkspaceArtifacts throws", async () => {
    mockCleanupExecutionWorkspaceArtifacts.mockRejectedValueOnce(
      new Error("unexpected shell error"),
    );

    const ids = await seedCompanyAndProject(db);
    const workspaceId = await insertWorkspace(db, ids);
    await insertIssue(db, ids.companyId, workspaceId, { status: "done" });

    const result = await svc.archiveTerminalIssueExecutionWorkspace({
      executionWorkspaceId: workspaceId,
      companyId: ids.companyId,
    });

    expect(result.archived).toBe(true);
    expect(result.warnings).toEqual(["unexpected shell error"]);

    const ws = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0]);
    expect(ws?.status).toBe("cleanup_failed");
    expect(ws?.cleanupReason).toBe("unexpected shell error");
  });
});
