import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { issueRelations, issues, workspaceOperations } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { useWorkspaceRecoveryFixture, acceptedRemoteExport, action, db } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("dependency readiness after a done child's work is recovered", () => {
  useWorkspaceRecoveryFixture(targets);

  async function recoveredDoneChildWithParent() {
    const f = await acceptedRemoteExport();
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    const [child] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Parent",
      status: "blocked", priority: "medium", assigneeAgentId: child.assigneeAgentId,
      executionWorkspaceId: f.workspaceId }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.issueId,
      relatedIssueId: parent.id, type: "blocks" });
    return { ...f, parentId: parent.id };
  }

  const recoveryFinalize = async (f: { companyId: string; runId: string }) => (await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
    eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"))))[0]!;
  const readiness = (id: string) => issueService(db).getDependencyReadiness(id);

  it("releases the parent once Recover saved files has saved a done child's work", async () => {
    const f = await recoveredDoneChildWithParent();
    await expect(readiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: true, pendingFinalizeBlockerIssueIds: [], unresolvedBlockerIssueIds: [] });
    const listed = (await issueService(db).list(f.companyId, { status: "blocked" }) as Array<{ id: string;
      blockerAttention?: { pendingFinalizeBlockerIssueIds?: string[] } | null }>).find(issue => issue.id === f.parentId);
    expect(listed?.blockerAttention?.pendingFinalizeBlockerIssueIds ?? []).toEqual([]);
  }, 30_000);

  it("releases the parent when the recovery saved through a snapshot without a workspace", async () => {
    const f = await recoveredDoneChildWithParent();
    const finalize = await recoveryFinalize(f);
    await db.update(workspaceOperations).set({ executionWorkspaceId: null }).where(and(
      eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery")));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      executionWorkspaceId: f.workspaceId, phase: "workspace_finalize", status: "failed",
      startedAt: new Date(finalize.startedAt.getTime() - 60_000), finishedAt: new Date(finalize.startedAt.getTime() - 59_000) });
    await expect(readiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: true, pendingFinalizeBlockerIssueIds: [] });
  }, 30_000);

  it("keeps a sibling's work that started during the recovery waiting for its own save", async () => {
    const f = await recoveredDoneChildWithParent();
    const finalize = await recoveryFinalize(f);
    const [sibling] = await db.insert(issues).values({ companyId: f.companyId, title: "Sibling", status: "done",
      priority: "medium", executionWorkspaceId: f.workspaceId }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: sibling.id, relatedIssueId: f.parentId, type: "blocks" });
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: sibling.id,
      executionWorkspaceId: f.workspaceId, phase: "worktree_prepare", status: "succeeded",
      startedAt: new Date(finalize.startedAt.getTime() - 1_000), finishedAt: new Date(finalize.startedAt.getTime() - 500) });
    await expect(readiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: false, pendingFinalizeBlockerIssueIds: [sibling.id] });
  }, 30_000);

  it("keeps the barrier for child workspace work started after the recovery", async () => {
    const f = await recoveredDoneChildWithParent();
    const finalize = await recoveryFinalize(f);
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      executionWorkspaceId: f.workspaceId, phase: "worktree_prepare", status: "succeeded",
      startedAt: new Date(finalize.startedAt.getTime() + 1_000), finishedAt: new Date(finalize.startedAt.getTime() + 2_000) });
    await expect(readiness(f.parentId)).resolves.toMatchObject({
      isDependencyReady: false, pendingFinalizeBlockerIssueIds: [f.issueId] });
  }, 30_000);
});
