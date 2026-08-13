import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_FAILED_REASON,
  EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY,
  executionWorkspaceService,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceLifecycleGeneration,
  readMetadataReopenPendingConsumptionSince,
} from "../services/execution-workspaces.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reopen tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reopen archived isolated execution workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reopen-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeExistingDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-reopen-cwd-"));
    tempDirs.push(dir);
    return dir;
  }

  async function seedCompanyProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reopen project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-reopen-project",
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  async function seedClosedWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    status?: "archived" | "cleanup_failed" | "active";
    generation?: number;
  }) {
    const workspaceId = randomUUID();
    const closed = (input.status ?? "archived") !== "active";
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      // project_primary strategy so the rebuild only checks that the directory
      // exists, with no git operation.
      strategyType: "project_primary",
      name: "reopen-workspace",
      status: input.status ?? "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      closedAt: closed ? new Date() : null,
      cleanupReason: closed ? "issue_terminal" : null,
      cleanupEligibleAt: closed ? new Date() : null,
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: input.generation ?? 1,
      },
    });
    return workspaceId;
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    workspaceId: string;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId,
      identifier: `PAP-${input.issueNumber}`,
      issueNumber: input.issueNumber,
      title: "Resume me",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: input.workspaceId,
    });
    return issueId;
  }

  async function readWorkspace(id: string) {
    return db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("reopens the archived row in place, keeps the issue link, and raises the generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4100 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(true);

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(row?.closedAt).toBeNull();
    expect(row?.cleanupReason).toBeNull();
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(4);
    // The reopen flags the row so the terminal reaper does not archive and
    // destroy the rebuilt worktree before the caller consumes it.
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);

    // The reopen never changes the issue-to-workspace link.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBe(workspaceId);
  });

  it("keeps access for every issue that shares the reopened row", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const firstIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4101 });
    const secondIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4102 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: firstIssueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(result.ok).toBe(true);

    const rows = await db.select().from(issues);
    for (const row of rows) {
      expect(row.executionWorkspaceId).toBe(workspaceId);
    }
    const workspace = await readWorkspace(workspaceId);
    expect(workspace?.status).toBe("active");
    expect(firstIssueId).not.toBe(secondIssueId);
  });

  it("fails closed and keeps the row closed when the rebuild fails", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
      generation: 2,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4103 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    const row = await readWorkspace(workspaceId);
    // The row stays closed and retryable. The generation still rises so a queued
    // cleanup with the old generation does nothing.
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe(EXECUTION_WORKSPACE_REOPEN_FAILED_REASON);
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(3);
  });

  it("refuses to reopen a workspace in another company", async () => {
    const first = await seedCompanyProject();
    const second = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId: first.companyId,
      projectId: first.projectId,
      projectWorkspaceId: first.projectWorkspaceId,
      cwd,
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      // The issue belongs to a different company than the workspace.
      issue: { id: randomUUID(), companyId: second.companyId, projectId: second.projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_reopenable");

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
  });

  it("reports success without a rebuild when the workspace is already active", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd,
      status: "active",
      generation: 5,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4104 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(false);

    const row = await readWorkspace(workspaceId);
    // No reopen ran, so the generation is unchanged.
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(5);
  });

  it("runs the destroy under the fence when the generation matches, and skips it after a reopen", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 7 });

    const svc = executionWorkspaceService(db);

    // The captured generation matches, so the destroy callback runs.
    const destroyMatches = vi.fn(async () => "destroyed");
    const matched = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyMatches,
    });
    expect(matched.skippedReopened).toBe(false);
    expect(destroyMatches).toHaveBeenCalledTimes(1);

    // Simulate a reopen: raise the generation and mark the row active.
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 8 },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // A stale cleanup captured generation 7. The fence must skip the destroy.
    const destroyStale = vi.fn(async () => "destroyed");
    const skipped = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyStale,
    });
    expect(skipped.skippedReopened).toBe(true);
    expect(destroyStale).not.toHaveBeenCalled();
  });

  it("clears the reopen-pending flag after an unconsumed reopen and stays idempotent", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4109 });

    const svc = executionWorkspaceService(db);
    // The reopen publishes the row as active and sets the reopen-pending flag.
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const reopenGeneration = reopenResult.generation;
    const reopenedRow = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(reopenedRow?.metadata as Record<string, unknown> | null)).toBe(true);
    // The reopen stamps the time it set the flag, so the reaper can age a
    // stranded flag out of the way after the grace period.
    expect(readMetadataReopenPendingConsumptionSince(reopenedRow?.metadata as Record<string, unknown> | null))
      .toBeInstanceOf(Date);

    // The caller never consumed the reopen, so clear the flag at its generation.
    const cleared = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(cleared.cleared).toBe(true);

    const clearedRow = await readWorkspace(workspaceId);
    // The flag is gone, so the terminal reaper can archive and reclaim the row.
    expect(metadataHasReopenPendingConsumption(clearedRow?.metadata as Record<string, unknown> | null)).toBe(false);
    // The clear removes the timestamp too, so no orphan key survives.
    expect((clearedRow?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY])
      .toBeUndefined();
    // The row stays active, so a retried resume can still reuse the rebuilt worktree.
    expect(clearedRow?.status).toBe("active");

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(events.some((event) => event.action === "execution_workspace.reopen_unconsumed")).toBe(true);

    // A second call finds no flag and does nothing.
    const second = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(second.cleared).toBe(false);
    const eventsAfter = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(eventsAfter.filter((event) => event.action === "execution_workspace.reopen_unconsumed").length).toBe(1);
  });

  it("does not clear a newer reopen's fence when a stale request presents an old generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4115 });

    const svc = executionWorkspaceService(db);
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const staleGeneration = reopenResult.generation;

    // Simulate a newer reopen that raised the generation and installed its own
    // fence with a fresh timestamp. This models two overlapping reopen requests.
    const newerGeneration = staleGeneration + 1;
    await db
      .update(executionWorkspaces)
      .set({
        metadata: {
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: newerGeneration,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: new Date().toISOString(),
        },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // The stale request's response-end clear presents the old generation. It must
    // not clear the newer reopen's live fence.
    const staleClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: staleGeneration,
    });
    expect(staleClear.cleared).toBe(false);
    const afterStale = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterStale?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(readExecutionWorkspaceLifecycleGeneration(afterStale?.metadata as Record<string, unknown> | null))
      .toBe(newerGeneration);

    // The newer owner clears its own fence at the matching generation.
    const ownerClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: newerGeneration,
    });
    expect(ownerClear.cleared).toBe(true);
    const afterOwner = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterOwner?.metadata as Record<string, unknown> | null)).toBe(false);
  });
});
