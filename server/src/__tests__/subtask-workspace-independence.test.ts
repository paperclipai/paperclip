import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { buildIndependentTaskWorkspaceSettings } from "../services/task-workspace-lineage.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("buildIndependentTaskWorkspaceSettings", () => {
  it("keeps the workspace strategy but drops realized identity and pinned branches", () => {
    expect(buildIndependentTaskWorkspaceSettings({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "origin/main",
        branchTemplate: "{{issue.identifier}}",
        existingBranch: "parent-branch",
      },
    })).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
      workspaceStrategy: { type: "git_worktree", baseRef: "origin/main", branchTemplate: "{{issue.identifier}}" },
    });
    expect(buildIndependentTaskWorkspaceSettings({
      mode: "shared_workspace",
      sharedWorkspaceConcurrency: "serialize",
      networkEgress: { allowFqdns: ["api.example.com"], allowCidrs: [] },
    })).toEqual({
      mode: "shared_workspace",
      sharedWorkspaceConcurrency: "serialize",
      networkEgress: { allowFqdns: ["api.example.com"], allowCidrs: [] },
    });
    expect(buildIndependentTaskWorkspaceSettings({ mode: "reuse_existing" })).toBeNull();
    expect(buildIndependentTaskWorkspaceSettings({ mode: "operator_branch" })).toBeNull();
  });
});

describeEmbeddedPostgres("subtasks never share an ancestor's execution workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-subtask-workspace-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.update(executionWorkspaces).set({ sourceIssueId: null });
    await db.update(issues).set({ parentId: null, privacyParentIssueId: null, executionRunId: null });
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const parentSettings = {
    mode: "isolated_workspace",
    workspaceRuntime: { profile: "agent" },
    workspaceStrategy: { type: "git_worktree", baseRef: "origin/main", existingBranch: "pap-1-parent" },
  };

  async function seedParentWithRealizedWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const parentWorkspaceId = randomUUID();
    const parentIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(projects).values({ id: projectId, companyId, name: "Workspace project", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary workspace", isPrimary: true, sharedWorkspaceKey: "workspace-key",
    });
    await db.insert(issues).values({
      id: parentIssueId, companyId, projectId, projectWorkspaceId, title: "Parent issue", status: "in_progress", priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: parentWorkspaceId, companyId, projectId, projectWorkspaceId, sourceIssueId: parentIssueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Parent worktree", status: "active",
      branchName: "pap-1-parent", providerType: "git_worktree", providerRef: `/tmp/${parentWorkspaceId}`,
    });
    await db.update(issues).set({
      executionWorkspaceId: parentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: parentSettings,
    }).where(eq(issues.id, parentIssueId));
    return { companyId, projectId, projectWorkspaceId, parentWorkspaceId, parentIssueId };
  }

  function expectIndependentChild(
    child: { executionWorkspaceId: string | null; executionWorkspacePreference: string | null; executionWorkspaceSettings: unknown; projectWorkspaceId: string | null; projectId: string | null },
    fixture: Awaited<ReturnType<typeof seedParentWithRealizedWorkspace>>,
  ) {
    expect(child.executionWorkspaceId).toBeNull();
    expect(child.executionWorkspacePreference).not.toBe("reuse_existing");
    expect(child.projectId).toBe(fixture.projectId);
    // The project base, not the parent's checkout.
    expect(child.projectWorkspaceId).toBe(fixture.projectWorkspaceId);
    expect(JSON.stringify(child.executionWorkspaceSettings ?? {})).not.toContain("pap-1-parent");
    expect(JSON.stringify(child.executionWorkspaceSettings ?? {})).not.toContain("reuse_existing");
  }

  it("create() with parentId gives the child its own workspace and keeps the parent's strategy", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const child = await issueService(db).create(fixture.companyId, { parentId: fixture.parentIssueId, title: "Child issue" });
    expect(child.parentId).toBe(fixture.parentIssueId);
    expectIndependentChild(child, fixture);
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
      workspaceStrategy: { type: "git_worktree", baseRef: "origin/main" },
    });
  });

  it.each([undefined, "linkage", "strategy_only"] as const)(
    "createChild never reuses the parent workspace (deprecated inheritance mode %s is ignored)",
    async (mode) => {
      const fixture = await seedParentWithRealizedWorkspace();
      const { issue: child } = await issueService(db).createChild(fixture.parentIssueId, {
        title: "Child issue",
        status: "todo",
        priority: "medium",
        ...(mode ? { executionWorkspaceInheritanceMode: mode } : {}),
      } as Parameters<ReturnType<typeof issueService>["createChild"]>[1]);
      expectIndependentChild(child, fixture);
    },
  );

  it("createChild into another project does not carry the parent's strategy across the project boundary", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({ id: otherProjectId, companyId: fixture.companyId, name: "Other project", status: "in_progress" });
    const { issue: child } = await issueService(db).createChild(fixture.parentIssueId, {
      title: "Cross-project child", status: "todo", priority: "medium", projectId: otherProjectId,
    } as Parameters<ReturnType<typeof issueService>["createChild"]>[1]);
    expect(child.projectId).toBe(otherProjectId);
    expect(child.executionWorkspaceId).toBeNull();
    expect(child.projectWorkspaceId).not.toBe(fixture.projectWorkspaceId);
    expect(JSON.stringify(child.executionWorkspaceSettings ?? {})).not.toContain("workspaceRuntime");
  });

  it("does not share when inheritExecutionWorkspaceFromIssueId points at the parent", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const child = await issueService(db).create(fixture.companyId, {
      parentId: fixture.parentIssueId,
      inheritExecutionWorkspaceFromIssueId: fixture.parentIssueId,
      title: "Child issue",
    });
    expectIndependentChild(child, fixture);
  });

  it("drops an explicit executionWorkspaceId that belongs to the parent or a further ancestor", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const child = await issueService(db).create(fixture.companyId, {
      parentId: fixture.parentIssueId,
      projectId: fixture.projectId,
      executionWorkspaceId: fixture.parentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      title: "Child issue",
    });
    expectIndependentChild(child, fixture);

    const grandchild = await issueService(db).create(fixture.companyId, {
      parentId: child.id,
      parentDepthPolicy: "allow_nested",
      projectId: fixture.projectId,
      executionWorkspaceId: fixture.parentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      title: "Grandchild issue",
    });
    expect(grandchild.executionWorkspaceId).toBeNull();
  });

  it("non-child follow-ups keep the source's project and strategy but get their own workspace", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const followUp = await issueService(db).create(fixture.companyId, {
      parentId: null,
      inheritExecutionWorkspaceFromIssueId: fixture.parentIssueId,
      title: "Follow-up issue",
    });
    expect(followUp.parentId).toBeNull();
    expectIndependentChild(followUp, fixture);
  });

  it("leaves top-level tasks and project workspace defaults unchanged", async () => {
    const fixture = await seedParentWithRealizedWorkspace();
    const topLevel = await issueService(db).create(fixture.companyId, { projectId: fixture.projectId, title: "Top-level" });
    expect(topLevel.parentId).toBeNull();
    expect(topLevel.executionWorkspaceId).toBeNull();
    expect(topLevel.projectWorkspaceId).toBe(fixture.projectWorkspaceId);

    // An explicit existing workspace for an unrelated top-level task is still honoured.
    const explicit = await issueService(db).create(fixture.companyId, {
      projectId: fixture.projectId,
      executionWorkspaceId: fixture.parentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      title: "Explicit reuse",
    });
    expect(explicit.executionWorkspaceId).toBe(fixture.parentWorkspaceId);
  });

  describe("old-release children bound to the parent's workspace", () => {
    async function seedOldReleaseChild() {
      const fixture = await seedParentWithRealizedWorkspace();
      const childIssueId = randomUUID();
      // The shape older releases wrote by default for every child.
      await db.insert(issues).values({
        id: childIssueId, companyId: fixture.companyId, projectId: fixture.projectId, parentId: fixture.parentIssueId,
        projectWorkspaceId: fixture.projectWorkspaceId, title: "Old child", status: "todo", priority: "medium",
        executionWorkspaceId: fixture.parentWorkspaceId, executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { ...parentSettings, mode: "isolated_workspace" },
      });
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId, companyId: fixture.companyId, name: "Coder", role: "engineer", status: "active",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      return { ...fixture, childIssueId, agentId };
    }

    async function insertRun(input: { companyId: string; agentId: string; issueId: string; status: string }) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id, companyId: input.companyId, agentId: input.agentId, invocationSource: "assignment", triggerDetail: "system",
        status: input.status, startedAt: new Date(), contextSnapshot: { issueId: input.issueId },
      });
      return id;
    }

    async function readIssue(id: string) {
      const [row] = await db.select().from(issues).where(eq(issues.id, id));
      return row!;
    }

    it("rebinds a child that is not running on its next admission and leaves the parent's workspace alone", async () => {
      const fixture = await seedOldReleaseChild();
      // The parent is writing in its workspace right now.
      const parentRunId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.parentIssueId, status: "running" });
      await db.update(issues).set({ executionRunId: parentRunId }).where(eq(issues.id, fixture.parentIssueId));
      const admittedRunId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.childIssueId, status: "running" });
      const before = await readIssue(fixture.childIssueId);

      const released = await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.childIssueId, runId: admittedRunId,
      });

      expect(released).toBe(true);
      const child = await readIssue(fixture.childIssueId);
      expect(child.executionWorkspaceId).toBeNull();
      expect(child.executionWorkspacePreference).toBeNull();
      expect(child.projectWorkspaceId).toBe(fixture.projectWorkspaceId);
      expect(child.executionWorkspaceSettings).toEqual({
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
        workspaceStrategy: { type: "git_worktree", baseRef: "origin/main" },
      });
      expect(child.workspaceBindingRevision).toBe(before.workspaceBindingRevision + 1);

      // The parent keeps its workspace, and the workspace (with its files) is untouched.
      const parent = await readIssue(fixture.parentIssueId);
      expect(parent.executionWorkspaceId).toBe(fixture.parentWorkspaceId);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, fixture.parentWorkspaceId));
      expect(workspace).toMatchObject({ status: "active", sourceIssueId: fixture.parentIssueId, providerRef: `/tmp/${fixture.parentWorkspaceId}` });

      // Idempotent: a second admission has nothing left to release.
      expect(await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.childIssueId, runId: admittedRunId,
      })).toBe(false);
    });

    it("rebinds a task that depth placement put beside the requester whose workspace it shares", async () => {
      const fixture = await seedOldReleaseChild();
      // Older releases inherited from the requested parent even when placement
      // flattened the task beside it; the requester is recorded as privacy parent.
      const grandparentId = randomUUID();
      await db.insert(issues).values({ id: grandparentId, companyId: fixture.companyId, projectId: fixture.projectId,
        title: "Root", status: "in_progress", priority: "medium" });
      await db.update(issues).set({ parentId: grandparentId }).where(eq(issues.id, fixture.parentIssueId));
      await db.update(issues).set({ parentId: grandparentId, privacyParentIssueId: fixture.parentIssueId })
        .where(eq(issues.id, fixture.childIssueId));
      const runId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.childIssueId, status: "running" });
      expect(await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.childIssueId, runId,
      })).toBe(true);
      expect((await readIssue(fixture.childIssueId)).executionWorkspaceId).toBeNull();
      expect((await readIssue(fixture.parentIssueId)).executionWorkspaceId).toBe(fixture.parentWorkspaceId);
    });

    it("lets a running child finish in the shared workspace before rebinding", async () => {
      const fixture = await seedOldReleaseChild();
      // The deploy lands while the child's earlier run is still running.
      await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.childIssueId, status: "running" });
      const nextRunId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.childIssueId, status: "queued" });

      expect(await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.childIssueId, runId: nextRunId,
      })).toBe(false);
      expect((await readIssue(fixture.childIssueId)).executionWorkspaceId).toBe(fixture.parentWorkspaceId);
    });

    it("keeps an explicit share between unrelated tasks", async () => {
      const fixture = await seedOldReleaseChild();
      await db.update(issues).set({ parentId: null }).where(eq(issues.id, fixture.childIssueId));
      const runId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.childIssueId, status: "running" });
      expect(await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.childIssueId, runId,
      })).toBe(false);
      expect((await readIssue(fixture.childIssueId)).executionWorkspaceId).toBe(fixture.parentWorkspaceId);
    });

    it("never rebinds the parent, even when it is bound to its own workspace a child shares", async () => {
      const fixture = await seedOldReleaseChild();
      const runId = await insertRun({ companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.parentIssueId, status: "running" });
      expect(await executionWorkspaceService(db).releaseAncestorWorkspaceBindingAtAdmission({
        companyId: fixture.companyId, issueId: fixture.parentIssueId, runId,
      })).toBe(false);
      expect((await readIssue(fixture.parentIssueId)).executionWorkspaceId).toBe(fixture.parentWorkspaceId);
    });
  });
});
