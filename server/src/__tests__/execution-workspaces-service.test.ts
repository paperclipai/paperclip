import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executionWorkspaceService,
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.ts";
import { executionWorkspaceReaperService } from "../services/execution-workspace-reaper.ts";

const execFileAsync = promisify(execFile);

describe("execution workspace config helpers", () => {
  it("reads typed config from persisted metadata", () => {
    expect(readExecutionWorkspaceConfig({
      source: "project_primary",
      config: {
        environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      teardownCommand: "bash ./scripts/teardown-worktree.sh",
      cleanupCommand: "pkill -f vite || true",
      desiredState: null,
      serviceStates: null,
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev", port: 3100 }],
      },
    });
  });

  it("merges config patches without dropping unrelated metadata", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        createdByRuntime: false,
        config: {
          environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          cleanupCommand: "pkill -f vite || true",
        },
      },
      {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    )).toEqual({
      source: "project_primary",
      createdByRuntime: false,
      config: {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        desiredState: null,
        serviceStates: null,
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    });
  });

  it("clears a persisted environment selection when patching it to null", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        config: {
          environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        },
      },
      {
        environmentId: null,
      },
    )).toEqual({
      source: "project_primary",
    });
  });

  it("clears the nested config block when requested", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        config: {
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      null,
    )).toEqual({
      source: "project_primary",
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo(repoRoot?: string) {
  repoRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-execution-workspace-"));
  await fs.mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("executionWorkspaceService.getCloseReadiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspaces-service-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows archiving shared workspace sessions with warnings even when issues are still open", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: "/tmp/paperclip-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/paperclip-primary",
      metadata: {
        config: {
          teardownCommand: "bash ./scripts/teardown.sh",
        },
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Still working",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
    });

    const readiness = await svc.getCloseReadiness(executionWorkspaceId);

    expect(readiness).toMatchObject({
      workspaceId: executionWorkspaceId,
      state: "ready_with_warnings",
      isSharedWorkspace: true,
      isProjectPrimaryWorkspace: true,
      isDestructiveCloseAllowed: true,
    });
    expect(readiness?.blockingReasons).toEqual([]);
    expect(readiness?.warnings).toEqual(expect.arrayContaining([
      "This workspace is still linked to an open issue. Archiving it will detach this shared workspace session from those issues, but keep the underlying project workspace available.",
      "This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.",
    ]));
  });

  it("clears matching environment selections transactionally without touching other workspaces", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const matchingWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const untouchedWorkspaceId = randomUUID();
    const environmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace cleanup",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(executionWorkspaces).values([
      {
        id: matchingWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Matching workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-a",
        metadata: {
          source: "manual",
          config: {
            environmentId,
            cleanupCommand: "echo clean",
          },
        },
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Different environment",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-b",
        metadata: {
          source: "manual",
          config: {
            environmentId: randomUUID(),
          },
        },
      },
      {
        id: untouchedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "No environment",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-c",
        metadata: {
          source: "manual",
        },
      },
    ]);

    const cleared = await svc.clearEnvironmentSelection(companyId, environmentId);

    expect(cleared).toBe(1);

    const rows = await db
      .select({
        id: executionWorkspaces.id,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [matchingWorkspaceId, otherWorkspaceId, untouchedWorkspaceId]));

    const byId = new Map(rows.map((row) => [row.id, row.metadata as Record<string, unknown> | null]));
    expect(readExecutionWorkspaceConfig(byId.get(matchingWorkspaceId) ?? null)).toMatchObject({
      environmentId: null,
      cleanupCommand: "echo clean",
    });
    expect(readExecutionWorkspaceConfig(byId.get(otherWorkspaceId) ?? null)).toMatchObject({
      environmentId: expect.any(String),
    });
    expect(readExecutionWorkspaceConfig(byId.get(untouchedWorkspaceId) ?? null)).toBeNull();
  });

  it("limits reusable summaries to open non-shared execution workspaces", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const openWorkspaceId = randomUUID();
    const sharedWorkspaceId = randomUUID();
    const closedWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reusable workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(executionWorkspaces).values([
      {
        id: openWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Open isolated workspace",
        status: "idle",
        providerType: "git_worktree",
        cwd: "/tmp/open-workspace",
        branchName: "paperclip/open",
      },
      {
        id: sharedWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Shared session",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/project-primary",
      },
      {
        id: closedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Closed isolated workspace",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/closed-workspace",
        closedAt: new Date("2026-05-23T20:00:00.000Z"),
      },
    ]);

    const summaries = await svc.listSummaries(companyId, {
      projectId,
      reuseEligible: true,
    });

    expect(summaries).toEqual([
      expect.objectContaining({
        id: openWorkspaceId,
        name: "Open isolated workspace",
        mode: "isolated_workspace",
        status: "idle",
        cwd: "/tmp/open-workspace",
        branchName: "paperclip/open",
      }),
    ]);
  });

  it("dry-runs conservative reaper candidates, archived no-ops, and active issue exclusions", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceDoneIssueId = randomUUID();
    const terminalWorkspaceId = randomUUID();
    const missingSourceWorkspaceId = randomUUID();
    const archivedWorkspaceId = randomUUID();
    const activeStatuses = ["backlog", "todo", "in_progress", "in_review", "blocked"];
    const activeWorkspaceIds = activeStatuses.map(() => randomUUID());
    const existingWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reaper-existing-"));
    tempDirs.add(existingWorkspacePath);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace reaper",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(issues).values({
      id: sourceDoneIssueId,
      companyId,
      projectId,
      title: "Finished source issue",
      status: "done",
      priority: "medium",
      identifier: "PAP-1",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: terminalWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: sourceDoneIssueId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Terminal source",
        status: "active",
        providerType: "local_fs",
        cwd: path.join(os.tmpdir(), `missing-terminal-${randomUUID()}`),
      },
      {
        id: missingSourceWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Missing source",
        status: "idle",
        providerType: "local_fs",
        cwd: existingWorkspacePath,
      },
      {
        id: archivedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Already archived",
        status: "archived",
        providerType: "local_fs",
        cwd: path.join(os.tmpdir(), `missing-archived-${randomUUID()}`),
      },
      ...activeWorkspaceIds.map((workspaceId, index) => ({
        id: workspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: `Active linked ${activeStatuses[index]}`,
        status: "active",
        providerType: "local_fs",
        cwd: path.join(os.tmpdir(), `missing-active-${workspaceId}`),
      })),
    ]);
    await db.insert(issues).values(activeWorkspaceIds.map((workspaceId, index) => ({
      id: randomUUID(),
      companyId,
      projectId,
      title: `Linked ${activeStatuses[index]}`,
      status: activeStatuses[index],
      priority: "medium",
      executionWorkspaceId: workspaceId,
      identifier: `PAP-${index + 2}`,
    })));

    const report = await executionWorkspaceReaperService(db).reap(companyId);
    const byId = new Map(report.items.map((item) => [item.workspaceId, item]));

    expect(report).toMatchObject({
      dryRun: true,
      deleteFiles: false,
      checkedCount: 8,
      candidateCount: 2,
      archivedCount: 0,
      excludedActiveCount: 5,
      noopArchivedCount: 1,
    });
    expect(byId.get(terminalWorkspaceId)).toMatchObject({
      workspaceStatus: "active",
      sourceIssueIdentifier: "PAP-1",
      sourceIssueStatus: "done",
      reason: "source_issue_terminal",
      reasons: ["source_issue_terminal", "path_missing"],
      pathExists: false,
      activeLinkedCount: 0,
      plannedAction: "archive_record",
      archived: false,
    });
    expect(byId.get(missingSourceWorkspaceId)).toMatchObject({
      workspaceStatus: "idle",
      sourceIssueIdentifier: null,
      sourceIssueStatus: null,
      reason: "source_issue_missing",
      reasons: ["source_issue_missing"],
      pathExists: true,
      activeLinkedCount: 0,
      plannedAction: "archive_record",
    });
    expect(byId.get(archivedWorkspaceId)).toMatchObject({
      reason: "already_archived",
      plannedAction: "noop_already_archived",
    });
    for (const workspaceId of activeWorkspaceIds) {
      expect(byId.get(workspaceId)).toMatchObject({
        reason: "active_linked",
        pathExists: false,
        activeLinkedCount: 1,
        plannedAction: "exclude_active_linked",
        archived: false,
      });
    }

    const rows = await db
      .select({
        id: executionWorkspaces.id,
        status: executionWorkspaces.status,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [terminalWorkspaceId, missingSourceWorkspaceId]));
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "idle"]);
  });

  it("archives only eligible reaper candidates when dryRun is false", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceDoneIssueId = randomUUID();
    const candidateWorkspaceId = randomUUID();
    const activeWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace reaper apply",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(issues).values({
      id: sourceDoneIssueId,
      companyId,
      projectId,
      title: "Finished source issue",
      status: "cancelled",
      priority: "medium",
      identifier: "PAP-20",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: candidateWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: sourceDoneIssueId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Candidate",
        status: "active",
        providerType: "local_fs",
        cwd: path.join(os.tmpdir(), `missing-candidate-${randomUUID()}`),
      },
      {
        id: activeWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Active linked",
        status: "active",
        providerType: "local_fs",
        cwd: path.join(os.tmpdir(), `missing-active-${randomUUID()}`),
      },
    ]);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Still active",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: activeWorkspaceId,
      identifier: "PAP-21",
    });

    const report = await executionWorkspaceReaperService(db).reap(companyId, { dryRun: false });
    const rows = await db
      .select({
        id: executionWorkspaces.id,
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [candidateWorkspaceId, activeWorkspaceId]));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(report).toMatchObject({
      dryRun: false,
      candidateCount: 1,
      archivedCount: 1,
      excludedActiveCount: 1,
    });
    expect(report.items.find((item) => item.workspaceId === candidateWorkspaceId)).toMatchObject({
      plannedAction: "archive_record",
      archived: true,
    });
    expect(byId.get(candidateWorkspaceId)).toMatchObject({
      status: "archived",
      cleanupReason: "reaper:source_issue_terminal,path_missing",
    });
    expect(byId.get(candidateWorkspaceId)?.closedAt).toBeInstanceOf(Date);
    expect(byId.get(activeWorkspaceId)).toMatchObject({
      status: "active",
    });
  });

  it("revalidates apply candidates before archiving", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceDoneIssueId = randomUUID();
    const sourceActiveIssueId = randomUUID();
    const firstWorkspaceId = "00000000-0000-4000-8000-000000000001";
    const staleWorkspaceId = "00000000-0000-4000-8000-000000000002";
    const lateActiveWorkspaceId = "00000000-0000-4000-8000-000000000003";
    const lateActiveIssueId = randomUUID();
    const projectWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reaper-project-"));
    const firstWorkspacePath = await createTempRepo();
    const staleWorkspacePath = path.join(os.tmpdir(), `paperclip-reaper-late-${randomUUID()}`);
    const lateActiveWorkspacePath = path.join(os.tmpdir(), `paperclip-reaper-late-active-${randomUUID()}`);
    tempDirs.add(projectWorkspacePath);
    tempDirs.add(firstWorkspacePath);
    tempDirs.add(staleWorkspacePath);
    tempDirs.add(lateActiveWorkspacePath);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace reaper race",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: projectWorkspacePath,
    });
    await db.insert(issues).values([
      {
        id: sourceDoneIssueId,
        companyId,
        projectId,
        title: "Finished source",
        status: "done",
        priority: "medium",
        identifier: "PAP-30",
      },
      {
        id: sourceActiveIssueId,
        companyId,
        projectId,
        title: "Active source",
        status: "in_progress",
        priority: "medium",
        identifier: "PAP-31",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: firstWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        sourceIssueId: sourceDoneIssueId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "First candidate",
        status: "active",
        providerType: "local_fs",
        cwd: firstWorkspacePath,
        metadata: {
          createdByRuntime: true,
          config: {
            cleanupCommand: `mkdir -p ${JSON.stringify(staleWorkspacePath)}`,
          },
        },
      },
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        sourceIssueId: sourceActiveIssueId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Stale path-missing candidate",
        status: "active",
        providerType: "local_fs",
        cwd: staleWorkspacePath,
        metadata: {
          createdByRuntime: true,
        },
      },
      {
        id: lateActiveWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        sourceIssueId: sourceDoneIssueId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Late active-linked candidate",
        status: "active",
        providerType: "local_fs",
        cwd: lateActiveWorkspacePath,
        metadata: {
          createdByRuntime: true,
        },
      },
    ]);
    await db.execute(sql.raw(`
      SET client_min_messages TO WARNING;
      DROP TRIGGER IF EXISTS aiva1862_reaper_active_link_after_archive ON execution_workspaces;
      DROP FUNCTION IF EXISTS aiva1862_reaper_active_link();
      RESET client_min_messages;
      CREATE FUNCTION aiva1862_reaper_active_link()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.id = '${firstWorkspaceId}'::uuid AND NEW.status = 'archived' AND OLD.status <> 'archived' THEN
          INSERT INTO issues (
            id,
            company_id,
            project_id,
            title,
            status,
            priority,
            execution_workspace_id,
            identifier
          )
          VALUES (
            '${lateActiveIssueId}'::uuid,
            '${companyId}'::uuid,
            '${projectId}'::uuid,
            'Late active linked issue',
            'in_progress',
            'medium',
            '${lateActiveWorkspaceId}'::uuid,
            'PAP-32'
          );
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER aiva1862_reaper_active_link_after_archive
      AFTER UPDATE ON execution_workspaces
      FOR EACH ROW EXECUTE FUNCTION aiva1862_reaper_active_link();
    `));

    const report = await executionWorkspaceReaperService(db).reap(companyId, {
      dryRun: false,
      deleteFiles: true,
    });
    const itemById = new Map(report.items.map((item) => [item.workspaceId, item]));
    const rows = await db
      .select({
        id: executionWorkspaces.id,
        status: executionWorkspaces.status,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [firstWorkspaceId, staleWorkspaceId, lateActiveWorkspaceId]));
    const statusById = new Map(rows.map((row) => [row.id, row.status]));

    expect(report).toMatchObject({
      dryRun: false,
      deleteFiles: true,
      checkedCount: 3,
      candidateCount: 1,
      archivedCount: 1,
      excludedActiveCount: 1,
      noopNoReasonCount: 1,
    });
    expect(itemById.get(firstWorkspaceId)).toMatchObject({
      plannedAction: "archive_record_and_delete_files",
      archived: true,
      cleanupAttempted: true,
      cleanupDeleted: true,
    });
    expect(itemById.get(staleWorkspaceId)).toMatchObject({
      reason: "none",
      reasons: [],
      pathExists: true,
      plannedAction: "noop_no_cleanup_reason",
      archived: false,
    });
    expect(itemById.get(lateActiveWorkspaceId)).toMatchObject({
      reason: "active_linked",
      activeLinkedCount: 1,
      plannedAction: "exclude_active_linked",
      archived: false,
    });
    expect(statusById.get(firstWorkspaceId)).toBe("archived");
    expect(statusById.get(staleWorkspaceId)).toBe("active");
    expect(statusById.get(lateActiveWorkspaceId)).toBe("active");
  }, 20_000);

  it("sanitizes delete-files cleanup warnings in reaper output and storage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceDoneIssueId = randomUUID();
    const candidateWorkspaceId = randomUUID();
    const projectWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reaper-project-"));
    const candidateWorkspacePath = await createTempRepo();
    const rawCleanupOutput = "raw-cleanup-output-should-not-leak";
    const rawCleanupError = "raw-cleanup-error-should-not-leak";
    tempDirs.add(projectWorkspacePath);
    tempDirs.add(candidateWorkspacePath);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace reaper cleanup",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: projectWorkspacePath,
    });
    await db.insert(issues).values({
      id: sourceDoneIssueId,
      companyId,
      projectId,
      title: "Finished source issue",
      status: "done",
      priority: "medium",
      identifier: "PAP-40",
    });
    await db.insert(executionWorkspaces).values({
      id: candidateWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: sourceDoneIssueId,
      mode: "isolated_workspace",
      strategyType: "directory",
      name: "Cleanup warning candidate",
      status: "active",
      providerType: "local_fs",
      cwd: candidateWorkspacePath,
      metadata: {
        createdByRuntime: true,
        config: {
          cleanupCommand: `printf ${JSON.stringify(rawCleanupOutput)}; printf ${JSON.stringify(rawCleanupError)} >&2; exit 7`,
        },
      },
    });

    const report = await executionWorkspaceReaperService(db).reap(companyId, {
      dryRun: false,
      deleteFiles: true,
    });
    const item = report.items.find((entry) => entry.workspaceId === candidateWorkspaceId);
    const row = await db
      .select({
        status: executionWorkspaces.status,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, candidateWorkspaceId))
      .then((rows) => rows[0]);
    const serializedItem = JSON.stringify(item);

    expect(item).toMatchObject({
      plannedAction: "archive_record_and_delete_files",
      archived: true,
      cleanupAttempted: true,
      cleanupDeleted: true,
      cleanupSkippedReason: "filesystem cleanup reported 1 warning",
    });
    expect(serializedItem).not.toContain(rawCleanupOutput);
    expect(serializedItem).not.toContain(rawCleanupError);
    expect(serializedItem).not.toContain("printf");
    expect(row).toMatchObject({
      status: "archived",
      cleanupReason: "reaper:source_issue_terminal; cleanup:cleanup_warnings:1",
    });
    expect(row?.cleanupReason).not.toContain(rawCleanupOutput);
    expect(row?.cleanupReason).not.toContain(rawCleanupError);
    expect(row?.cleanupReason).not.toContain("printf");
  }, 20_000);

  it("marks incomplete delete-files cleanup as cleanup_failed and retryable", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceDoneIssueId = randomUUID();
    const candidateWorkspaceId = randomUUID();
    const candidateWorkspacePath = await createTempRepo();
    tempDirs.add(candidateWorkspacePath);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace reaper incomplete cleanup",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(issues).values({
      id: sourceDoneIssueId,
      companyId,
      projectId,
      title: "Finished source issue",
      status: "done",
      priority: "medium",
      identifier: "PAP-50",
    });
    await db.insert(executionWorkspaces).values({
      id: candidateWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: sourceDoneIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Incomplete cleanup candidate",
      status: "active",
      providerType: "git_worktree",
      cwd: candidateWorkspacePath,
      providerRef: candidateWorkspacePath,
    });

    const report = await executionWorkspaceReaperService(db).reap(companyId, {
      dryRun: false,
      deleteFiles: true,
    });
    const item = report.items.find((entry) => entry.workspaceId === candidateWorkspaceId);
    const row = await db
      .select({
        status: executionWorkspaces.status,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, candidateWorkspaceId))
      .then((rows) => rows[0]);
    const retryReport = await executionWorkspaceReaperService(db).reap(companyId, {
      dryRun: true,
      deleteFiles: true,
    });
    const retryItem = retryReport.items.find((entry) => entry.workspaceId === candidateWorkspaceId);
    const serializedItem = JSON.stringify(item);

    expect(item).toMatchObject({
      plannedAction: "archive_record_and_delete_files",
      archived: true,
      cleanupAttempted: true,
      cleanupDeleted: false,
      cleanupSkippedReason: "filesystem cleanup did not remove workspace; filesystem cleanup reported 1 warning",
    });
    expect(serializedItem).not.toContain(candidateWorkspacePath);
    expect(serializedItem).not.toContain("git worktree remove");
    expect(row).toMatchObject({
      status: "cleanup_failed",
      cleanupReason: "reaper:source_issue_terminal; cleanup:cleanup_incomplete:1",
    });
    expect(row?.cleanupReason).not.toContain(candidateWorkspacePath);
    expect(retryItem).toMatchObject({
      workspaceStatus: "cleanup_failed",
      plannedAction: "archive_record_and_delete_files",
      archived: false,
    });
  }, 20_000);

  it("warns about dirty and unmerged git worktrees and reports cleanup actions", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-worktree-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "paperclip-close-check"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "paperclip-close-check"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "hello\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Feature commit"]);
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "left behind\n", "utf8");

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        workspaceStrategy: {
          type: "git_worktree",
          teardownCommand: "bash ./scripts/project-teardown.sh",
        },
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "git_repo",
      isPrimary: true,
      cwd: repoRoot,
      cleanupCommand: "printf 'project cleanup\\n'",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "paperclip-close-check",
      baseRef: "main",
      metadata: {
        createdByRuntime: true,
        config: {
          cleanupCommand: "printf 'workspace cleanup\\n'",
        },
      },
    });

    const readiness = await svc.getCloseReadiness(executionWorkspaceId);

    expect(readiness).toMatchObject({
      workspaceId: executionWorkspaceId,
      state: "ready_with_warnings",
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      isDestructiveCloseAllowed: true,
      git: {
        workspacePath: worktreePath,
        branchName: "paperclip-close-check",
        baseRef: "main",
        createdByRuntime: true,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: true,
        aheadCount: 1,
        behindCount: 0,
        isMergedIntoBase: false,
      },
    });
    expect(readiness?.warnings).toEqual(expect.arrayContaining([
      "The workspace has 1 untracked file.",
      "This workspace is 1 commit ahead of main and is not merged.",
    ]));
    expect(readiness?.plannedActions.map((action) => action.kind)).toEqual(expect.arrayContaining([
      "archive_record",
      "cleanup_command",
      "teardown_command",
      "git_worktree_remove",
      "git_branch_delete",
    ]));
  }, 20_000);
});
