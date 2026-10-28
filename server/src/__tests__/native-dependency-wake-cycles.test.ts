import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  projects,
  projectWorkspaces,
  statusDecisionEffects,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import {
  commitNativeStatusDecision,
  type NativeStatusCommitFailpoint,
} from "../services/native-runtime/status-decision-committer.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("native completion dependency wakes across blocked cycles", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-dependency-wake-");
    db = createDb(temporary.connectionString);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  async function seedCompany(agentStatus = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Dependency wake",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Owner", adapterType: "codex_local", status: agentStatus },
      { id: otherAgentId, companyId, name: "New owner", adapterType: "codex_local", status: "idle" },
    ]);
    return { companyId, agentId, otherAgentId };
  }

  async function seedIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Fixture", status: "in_progress", workMode: "standard", ...values });
    return id;
  }

  async function block(companyId: string, dependentId: string, blockerIds: string[]) {
    await db.insert(issueRelations).values(
      blockerIds.map((blockerId) => ({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" })),
    );
  }

  async function startBlockedCycle(dependentId: string, at: Date) {
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: at }).where(eq(issues.id, dependentId));
  }

  async function reopen(issueId: string) {
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
  }

  async function seedNativeRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const revision = (await db.select({ id: completionContracts.id }).from(completionContracts)
      .where(eq(completionContracts.issueId, issueId))).length + 1;
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native", runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId, contextSnapshot: { issueId }, completionContractId: contractId,
      completionContractSha256: `contract:${contractId}`,
    });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: `contract:${contractId}`,
      createdByActorType: "system", createdByActorId: "dependency-wake-test",
    });
    await db.insert(nativeRunResults).values({
      id: resultId, companyId, issueId, runId, completionContractId: contractId, serverFingerprint: resultId,
      schemaStatus: "accepted", resultJson: { result: { summary: "Blocker delivered." } }, canonicalSha256: resultId,
    });
    await db.insert(workAssessments).values({
      id: assessmentId, companyId, issueId, runId, contractId, resultId, triggerKind: "native_result",
      triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {}, inputDigest: assessmentId,
    });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "assessing", resultId, assessmentId });
    return { runId, assessmentId };
  }

  async function prepareCompletion(companyId: string, agentId: string, issueId: string) {
    const run = await seedNativeRun(companyId, agentId, issueId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return (failpoint?: NativeStatusCommitFailpoint) =>
      commitNativeStatusDecision({
        db, companyId, issueId, runId: run.runId, assessmentId: run.assessmentId,
        priorStatus: issue!.status, priorStatusVersion: Number(issue!.statusVersion),
        priorDecisionId: issue!.lastStatusDecisionId, failpoint,
        decision: {
          policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done",
          reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [],
        },
      });
  }

  async function complete(companyId: string, agentId: string, issueId: string) {
    return (await prepareCompletion(companyId, agentId, issueId))();
  }

  async function dependencyWakes(companyId: string, dependentId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
    ));
    return rows.filter((row) => (row.payload as Record<string, unknown> | null)?.issueId === dependentId);
  }

  async function finishWakes(companyId: string, dependentId: string) {
    for (const wake of await dependencyWakes(companyId, dependentId)) {
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wake.id));
    }
  }

  it("wakes the owner again for a later blocked cycle and stays idempotent on replay", async () => {
    const { companyId, agentId } = await seedCompany();
    const blockerA = await seedIssue(companyId, { assigneeAgentId: agentId });
    const blockerB = await seedIssue(companyId, { assigneeAgentId: agentId });
    const dependent = await seedIssue(companyId, { assigneeAgentId: agentId });
    await block(companyId, dependent, [blockerA, blockerB]);
    await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));

    await complete(companyId, agentId, blockerA);
    expect(await dependencyWakes(companyId, dependent)).toHaveLength(0);

    await complete(companyId, agentId, blockerB);
    const first = await dependencyWakes(companyId, dependent);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ agentId, status: "queued" });
    await finishWakes(companyId, dependent);

    await reopen(blockerB);
    await startBlockedCycle(dependent, new Date("2026-10-28T02:00:00.000Z"));
    const secondCompletion = await prepareCompletion(companyId, agentId, blockerB);
    await secondCompletion();
    const second = await dependencyWakes(companyId, dependent);
    expect(second).toHaveLength(2);
    const fresh = second.find((wake) => wake.id !== first[0]!.id)!;
    expect(fresh).toMatchObject({ agentId, status: "queued" });
    const effects = await db.select().from(statusDecisionEffects).where(and(
      eq(statusDecisionEffects.issueId, blockerB), eq(statusDecisionEffects.effectKind, "dependency_wake"),
    ));
    expect(effects.map((effect) => effect.targetId)).toEqual(expect.arrayContaining([first[0]!.id, fresh.id]));

    expect((await secondCompletion()).replayed).toBe(true);
    expect(await dependencyWakes(companyId, dependent)).toHaveLength(2);
  });

  it("does not wake while another blocker is live, cancelled, or awaiting workspace finalization", async () => {
    const { companyId, agentId } = await seedCompany();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Finalize", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary",
      sourceType: "local_path", visibility: "default", isPrimary: true });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Exec", status: "active", providerType: "git_worktree" });

    const resolved = await seedIssue(companyId, { assigneeAgentId: agentId });
    const live = await seedIssue(companyId, { assigneeAgentId: agentId });
    const cancelled = await seedIssue(companyId, { status: "cancelled" });
    const finalizing = await seedIssue(companyId, { status: "done", projectId, executionWorkspaceId });
    await db.insert(workspaceOperations).values({ companyId, executionWorkspaceId, issueId: finalizing,
      phase: "worktree_prepare", status: "succeeded", startedAt: new Date() });
    const waitingOnLive = await seedIssue(companyId, { assigneeAgentId: agentId });
    const waitingOnCancelled = await seedIssue(companyId, { assigneeAgentId: agentId });
    const waitingOnFinalize = await seedIssue(companyId, { assigneeAgentId: agentId });
    await block(companyId, waitingOnLive, [resolved, live]);
    await block(companyId, waitingOnCancelled, [resolved, cancelled]);
    await block(companyId, waitingOnFinalize, [resolved, finalizing]);
    for (const dependent of [waitingOnLive, waitingOnCancelled, waitingOnFinalize]) {
      await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));
    }

    await complete(companyId, agentId, resolved);
    for (const dependent of [waitingOnLive, waitingOnCancelled, waitingOnFinalize]) {
      expect(await dependencyWakes(companyId, dependent)).toHaveLength(0);
    }
  });

  it("targets the current owner after reassignment and bounds wakes for a paused owner", async () => {
    const { companyId, agentId, otherAgentId } = await seedCompany("paused");
    const blocker = await seedIssue(companyId, { assigneeAgentId: otherAgentId });
    const dependent = await seedIssue(companyId, { assigneeAgentId: agentId });
    await block(companyId, dependent, [blocker]);
    await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));

    const firstCompletion = await prepareCompletion(companyId, otherAgentId, blocker);
    await firstCompletion();
    await firstCompletion();
    const first = await dependencyWakes(companyId, dependent);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ agentId });

    await reopen(blocker);
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, dependent));
    await startBlockedCycle(dependent, new Date("2026-10-28T02:00:00.000Z"));
    await complete(companyId, otherAgentId, blocker);
    const second = await dependencyWakes(companyId, dependent);
    expect(second).toHaveLength(2);
    expect(second.find((wake) => wake.id !== first[0]!.id)).toMatchObject({ agentId: otherAgentId });
  });

  it("reuses an in-flight wake from the same ready state instead of duplicating it", async () => {
    const { companyId, agentId } = await seedCompany();
    const blocker = await seedIssue(companyId, { assigneeAgentId: agentId });
    const dependent = await seedIssue(companyId, { assigneeAgentId: agentId });
    await block(companyId, dependent, [blocker]);
    await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));
    const [legacy] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      status: "queued", idempotencyKey: `issue_blockers_resolved:${dependent}:${blocker}`,
      payload: { issueId: dependent, resolvedBlockerIssueId: blocker },
    }).returning();

    await complete(companyId, agentId, blocker);
    const wakes = await dependencyWakes(companyId, dependent);
    expect(wakes.map((wake) => wake.id)).toEqual([legacy!.id]);
  });

  it("wakes exactly once when the last two blockers complete concurrently", async () => {
    const { companyId, agentId } = await seedCompany();
    const blockerA = await seedIssue(companyId, { assigneeAgentId: agentId });
    const blockerB = await seedIssue(companyId, { assigneeAgentId: agentId });
    const dependent = await seedIssue(companyId, { assigneeAgentId: agentId });
    await block(companyId, dependent, [blockerA, blockerB]);
    await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));
    const completeA = await prepareCompletion(companyId, agentId, blockerA);
    const completeB = await prepareCompletion(companyId, agentId, blockerB);

    await Promise.all([completeA(), completeB()]);
    expect(await dependencyWakes(companyId, dependent)).toHaveLength(1);
  });

  it("keeps company scope and rolls back the wake with a failed commit", async () => {
    const { companyId, agentId } = await seedCompany();
    const outside = await seedCompany();
    const blocker = await seedIssue(companyId, { assigneeAgentId: agentId });
    const dependent = await seedIssue(companyId, { assigneeAgentId: agentId });
    const foreignDependent = await seedIssue(outside.companyId, { assigneeAgentId: outside.agentId });
    await block(companyId, dependent, [blocker]);
    await db.insert(issueRelations).values({ companyId: outside.companyId, issueId: blocker,
      relatedIssueId: foreignDependent, type: "blocks" });
    await startBlockedCycle(dependent, new Date("2026-10-28T01:00:00.000Z"));
    await startBlockedCycle(foreignDependent, new Date("2026-10-28T01:00:00.000Z"));

    const commit = await prepareCompletion(companyId, agentId, blocker);
    await expect(commit("status_projection")).rejects.toThrow();
    expect(await dependencyWakes(companyId, dependent)).toHaveLength(0);

    await commit();
    expect(await dependencyWakes(companyId, dependent)).toHaveLength(1);
    expect(await dependencyWakes(outside.companyId, foreignDependent)).toHaveLength(0);
  });
});
