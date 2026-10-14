import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres native task monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("native task monitors", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-task-monitor-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Monitors", issuePrefix: `M${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deferred check", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const binding = { companyId, agentId, issueId, runId };
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const monitor = { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Compare this task's run and session identities." };
    const call = (args: Record<string, unknown>) => authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: args });
    const read = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    return { ...binding, binding, authority, monitor, call, read };
  }

  it("advertises a real binding only in standard execution", async () => {
    const value = await fixture();
    expect(value.authority.definitions().some(tool => tool.name === "set_task_monitor")).toBe(true);
    for (const workMode of ["planning", "ask"] as const) {
      const authority = new PaperclipRunnerToolAuthority(db, { ...value.binding, workMode });
      expect(authority.definitions().some(tool => tool.name === "set_task_monitor")).toBe(false);
      await db.update(issues).set({ workMode }).where(eq(issues.id, value.issueId));
      await expect(authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: { idempotencyKey: "forbidden", monitor: value.monitor } })).rejects.toThrow();
    }
  });

  it("keeps provider-neutral discovery and review-only restrictions", async () => {
    const value = await fixture();
    for (const provider of ["codex", "opencode", "claude_managed", "aws_agentcore", "acpx"]) {
      await db.update(agents).set({ adapterConfig: { provider } }).where(eq(agents.id, value.agentId));
      expect(value.authority.definitions().map(tool => tool.name)).toContain("set_task_monitor");
    }
    const authority = new PaperclipRunnerToolAuthority(db, { ...value.binding,
      nativeReview: { nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } });
    expect(authority.definitions().map(tool => tool.name)).not.toContain("set_task_monitor");
    await expect(authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: { idempotencyKey: "review", monitor: value.monitor } })).rejects.toThrow("review run");
  });

  it("rechecks the responsible user's permissions before mutation and replay", async () => {
    const value = await fixture(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: value.companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(heartbeatRuns).set({ responsibleUserId: userId }).where(eq(heartbeatRuns.id, value.runId));
    const original = { idempotencyKey: "authorized", monitor: value.monitor };
    await value.call(original);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.companyId, value.companyId));
    await expect(value.call(original)).rejects.toThrow();
    await expect(value.call({ idempotencyKey: "clear", monitor: null })).rejects.toThrow();
    expect((await value.read()).monitorNextCheckAt?.toISOString()).toBe(value.monitor.nextCheckAt);
  });

  it("persists a monitor and its audit atomically while preserving review policy", async () => {
    const value = await fixture();
    const policy = { mode: "normal", commentRequired: false, stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [{ type: "user", userId: "reviewer" }] }] };
    await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, value.issueId));
    const result = await value.call({ idempotencyKey: "schedule", monitor: value.monitor });
    expect(result).toMatchObject({ taskId: value.issueId, monitor: { ...value.monitor, scheduledBy: "assignee", status: "scheduled" }, replayed: false });
    const saved = await value.read();
    expect(saved.executionPolicy).toMatchObject(policy);
    expect(saved.monitorNextCheckAt?.toISOString()).toBe(value.monitor.nextCheckAt);
    expect(saved.status).toBe("in_progress");
    const audits = await db.select().from(activityLog).where(and(eq(activityLog.entityId, value.issueId), eq(activityLog.action, "issue.monitor_scheduled")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ runId: value.runId, agentId: value.agentId });
  });

  it("replaces and clears schedules without re-arming a receipt on replay", async () => {
    const value = await fixture();
    const original = { idempotencyKey: "first", monitor: value.monitor };
    await value.call(original);
    const replacement = { ...value.monitor, nextCheckAt: new Date(Date.now() + 120_000).toISOString() };
    await value.call({ idempotencyKey: "replace", monitor: replacement });
    expect(await value.call(original)).toMatchObject({ monitor: { nextCheckAt: replacement.nextCheckAt }, replayed: true });
    await value.call({ idempotencyKey: "clear", monitor: null });
    expect(await value.call(original)).toMatchObject({ monitor: { nextCheckAt: null, status: "cleared" }, replayed: true });
    expect((await value.read()).monitorNextCheckAt).toBeNull();
    await expect(value.call({ ...original, monitor: replacement })).rejects.toThrow("idempotency_conflict");
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, value.issueId));
    expect(audits.filter(row => row.action.startsWith("issue.monitor_"))).toHaveLength(3);
  });

  it("exposes consumed monitor instructions to a resumed task and does not re-arm them on retry", async () => {
    const value = await fixture();
    const input = { idempotencyKey: "consumed", monitor: value.monitor };
    await value.call(input);
    const scheduled = await value.read();
    await db.update(issues).set(buildIssueMonitorTriggeredPatch({ issue: scheduled,
      policy: normalizeIssueExecutionPolicy(scheduled.executionPolicy), triggeredAt: new Date() })).where(eq(issues.id, value.issueId));
    expect(await value.authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} }))
      .toMatchObject({ activeTask: { monitor: { status: "triggered", nextCheckAt: null, notes: value.monitor.notes, attemptCount: 1 } } });
    expect(await value.call(input)).toMatchObject({ replayed: true, monitor: { nextCheckAt: null, status: "triggered" } });
    expect((await value.read()).monitorNextCheckAt).toBeNull();
  });

  it("keeps a cleared schedule cleared when a successor run retries the original key", async () => {
    const value = await fixture();
    const original = { idempotencyKey: "durable-schedule", monitor: value.monitor };
    await value.call(original);
    await value.call({ idempotencyKey: "durable-clear", monitor: null });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, value.runId));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: value.companyId, agentId: value.agentId,
      nativeIssueId: value.issueId, runtimeMode: "native", status: "running", contextSnapshot: { issueId: value.issueId } });
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, value.issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { ...value.binding, runId: nextRunId });
    expect(await authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: original }))
      .toMatchObject({ replayed: true, monitor: { nextCheckAt: null, status: "cleared" } });
    expect((await value.read()).monitorNextCheckAt).toBeNull();
    await expect(value.call(original)).rejects.toThrow();
  });

  it("allows another owned task but rejects foreign ownership and company scope", async () => {
    const value = await fixture(), other = await fixture(), targetId = randomUUID();
    await db.insert(issues).values({ id: targetId, companyId: value.companyId, title: "Another owned check", status: "in_review", assigneeAgentId: value.agentId });
    expect(await value.call({ taskId: targetId, idempotencyKey: "other", monitor: value.monitor })).toMatchObject({ taskId: targetId });
    await expect(value.call({ taskId: other.issueId, idempotencyKey: "foreign", monitor: value.monitor })).rejects.toThrow("Task not found");
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId: value.companyId, name: "Other", adapterType: "paperclip_runner" });
    await db.update(issues).set({ assigneeAgentId: otherAgent }).where(eq(issues.id, targetId));
    await expect(value.call({ taskId: targetId, idempotencyKey: "other", monitor: value.monitor })).rejects.toThrow();
  });

  it("rejects invalid schedules, exhausted bounds and ineligible tasks without writes", async () => {
    const value = await fixture();
    for (const monitor of [
      { ...value.monitor, notes: "" },
      { ...value.monitor, nextCheckAt: new Date(0).toISOString() },
      { ...value.monitor, scheduledBy: "board" },
      { ...value.monitor, timeoutAt: value.monitor.nextCheckAt },
      { ...value.monitor, maxAttempts: 101 },
    ]) await expect(value.call({ idempotencyKey: randomUUID(), monitor })).rejects.toThrow();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, value.issueId));
    await expect(value.call({ idempotencyKey: "exhausted", monitor: { ...value.monitor, maxAttempts: 1 } })).rejects.toThrow();
    for (const status of ["blocked", "backlog", "done", "cancelled"] as const) {
      await db.update(issues).set({ status }).where(eq(issues.id, value.issueId));
      await expect(value.call({ idempotencyKey: randomUUID(), monitor: value.monitor })).rejects.toThrow();
    }
    expect((await value.read()).monitorNextCheckAt).toBeNull();
  });

  it("accepts unfinished monitor waits only after scheduling the current task", async () => {
    const value = await fixture();
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "I will compare the next run.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [{ description: "Compare next run", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the scheduled check", idempotencyKey: "wait" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    };
    await expect(nativeCompletionFeedback(db, value.runId, result)).rejects.toThrow("persisted, eligible monitor");
    const otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId: value.companyId, title: "Other", status: "in_progress", assigneeAgentId: value.agentId });
    await value.call({ taskId: otherId, idempotencyKey: "other", monitor: value.monitor });
    await expect(nativeCompletionFeedback(db, value.runId, result)).rejects.toThrow("persisted, eligible monitor");
    await value.call({ idempotencyKey: "self", monitor: value.monitor });
    await expect(nativeCompletionFeedback(db, value.runId, result)).resolves.toContain("issue_monitor_due");
    // Legacy APIs may persist a server-owned quota monitor. It cannot justify
    // a native wait because its dispatcher explicitly excludes native runs.
    await db.update(issues).set({ executionPolicy: { monitor: { ...value.monitor, serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME } } }).where(eq(issues.id, value.issueId));
    await expect(nativeCompletionFeedback(db, value.runId, result)).rejects.toThrow("persisted, eligible monitor");
    await value.call({ idempotencyKey: "clear", monitor: null });
    await expect(nativeCompletionFeedback(db, value.runId, result)).rejects.toThrow("persisted, eligible monitor");
  });

  it("rejects the server-owned quota recovery name without promising a wake", async () => {
    const value = await fixture();
    await expect(value.call({ idempotencyKey: "quota", monitor: {
      ...value.monitor, serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: value.runId,
    } })).rejects.toThrow("reserved for server-owned quota recovery");
    expect((await value.read()).monitorNextCheckAt).toBeNull();
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, value.issueId));
    expect(audits).toHaveLength(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, value.runId));
    expect(run.resultJson?.semanticToolReceipts).toBeUndefined();
    await expect(value.call({ idempotencyKey: "quota", monitor: {
      ...value.monitor, serviceName: "Provider usage dashboard",
    } })).resolves.toMatchObject({ monitor: { status: "scheduled" }, replayed: false });
  });
});
