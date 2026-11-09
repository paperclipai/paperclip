import { subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companyMemberships, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, statusDecisions } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import * as monitorDelivery from "./native-monitor-delivery.js";
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

  it("notifies committed monitor changes for another owned task without replay or authorization wakeups", async () => {
    const value = await fixture(), targetId = randomUUID();
    await db.insert(issues).values({ id: targetId, companyId: value.companyId,
      title: "Another owned monitor", status: "in_review", assigneeAgentId: value.agentId });
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.issueMonitors, event => { events.push(event); });
    const original = { taskId: targetId, idempotencyKey: "notify-first", monitor: value.monitor };
    try {
      await value.call(original);
      expect(events).toEqual(["intent", "settled"]);
      events.length = 0;
      await value.call({ ...original, idempotencyKey: "notify-earlier",
        monitor: { ...value.monitor, nextCheckAt: new Date(Date.now() + 30_000).toISOString() } });
      expect(events).toEqual(["intent", "settled"]);
      events.length = 0;
      await value.call(original);
      expect(events).toEqual([]);
      await value.call({ taskId: targetId, idempotencyKey: "notify-clear", monitor: null });
      expect(events).toEqual(["intent", "settled"]);
      events.length = 0;
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, targetId));
      await expect(value.call({ ...original, idempotencyKey: "notify-forbidden" })).rejects.toThrow();
      expect(events).toEqual([]);
    } finally { unsubscribe(); }
  });

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

  it("defaults completion only to the current eligible saved monitor and clears it when consumed", async () => {
    const value = await fixture();
    const context = () => value.authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
    expect(await context()).toMatchObject({ completionContinuation: null });
    await value.call({ idempotencyKey: "default-schedule", monitor: value.monitor });
    expect(await context()).toMatchObject({
      run: { id: value.runId }, activeTask: { executionRunId: value.runId },
      completionContinuation: { kind: "monitor", summary: "Wait for the saved task monitor.",
        idempotencyKey: `task-monitor:${value.issueId}:${value.monitor.nextCheckAt}` },
    });
    const scheduled = await value.read();
    await db.update(issues).set(buildIssueMonitorTriggeredPatch({ issue: scheduled,
      policy: normalizeIssueExecutionPolicy(scheduled.executionPolicy), triggeredAt: new Date() })).where(eq(issues.id, value.issueId));
    expect(await context()).toMatchObject({ completionContinuation: null });
    await value.call({ idempotencyKey: "replacement-schedule", monitor: value.monitor });
    await value.call({ idempotencyKey: "cleared-schedule", monitor: null });
    expect(await context()).toMatchObject({ completionContinuation: null });
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

  it.each(["failed_successor", "running_successor", "no_receipt", "other_task", "other_agent", "unadmitted", "still_owned", "ownership_race", "workspace_failed"] as const)(
    "settles a saved monitor result only with admitted delivery and settled ownership (%s)", async (state) => {
    const value = await fixture();
    await value.call({ idempotencyKey: "schedule", monitor: value.monitor });
    const contractId = randomUUID(), resultId = randomUUID(), successorId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId, companyId: value.companyId, issueId: value.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test",
    });
    const resultJson = {
      result: {
        schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Continue in the selected workspace.",
        completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [],
          remainingWork: [{ description: "Measure the archive", blocksCompletion: true }] },
        continuation: { kind: "monitor", summary: "Wait for the saved check", idempotencyKey: "provider-selected-key" },
        evidence: [], verification: [], attentionRequests: [], artifacts: [],
      },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" },
    };
    await db.update(heartbeatRuns).set({ status: "succeeded", completionContractId: contractId })
      .where(eq(heartbeatRuns.id, value.runId));
    await db.insert(nativeRunResults).values({
      id: resultId, companyId: value.companyId, issueId: value.issueId, runId: value.runId,
      completionContractId: contractId, serverFingerprint: randomUUID(), canonicalSha256: randomUUID(),
      schemaStatus: "accepted", resultJson,
    });
    await db.insert(nativeRunFinalizations).values({
      companyId: value.companyId, issueId: value.issueId, runId: value.runId,
      phase: "retryable_failure", resultId, failureCode: "monitor_wait_authority_lost",
    });
    const successorAgentId = state === "other_agent" ? randomUUID() : value.agentId;
    if (state === "other_agent") await db.insert(agents).values({
      id: successorAgentId, companyId: value.companyId, name: "Another agent", adapterType: "paperclip_runner",
    });
    await db.insert(heartbeatRuns).values({
      id: successorId, companyId: value.companyId, agentId: successorAgentId,
      status: state === "running_successor" ? "running" : "failed",
      contextSnapshot: { issueId: state === "other_task" ? randomUUID() : value.issueId },
      error: "Previous task run still owns workspace recovery",
    });
    const scheduled = await value.read();
    let executionRunId = state === "still_owned" ? value.runId : state === "running_successor" ? successorId : null;
    await db.update(issues).set({
      ...buildIssueMonitorTriggeredPatch({ issue: scheduled, policy: normalizeIssueExecutionPolicy(scheduled.executionPolicy), triggeredAt: new Date() }),
      executionRunId, checkoutRunId: executionRunId,
    }).where(eq(issues.id, value.issueId));
    // Persist the pre-repair error decision, then retry the same accepted result.
    await finalizeNativeRun({ db, runId: value.runId, workspaceFinalizeStatus: "succeeded" });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, value.runId)))[0])
      .toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost" });
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: value.companyId, agentId: value.agentId, source: "automation", reason: "issue_monitor_due",
      status: state === "unadmitted" ? "queued" : state === "running_successor" ? "claimed" : "failed",
      runId: state === "unadmitted" ? null : successorId,
      idempotencyKey: `issue-monitor:${value.issueId}:${value.monitor.nextCheckAt}`,
      payload: { issueId: value.issueId, nextCheckAt: value.monitor.nextCheckAt },
    }).returning();
    if (state === "no_receipt") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, value.runId));

    const workspaceFinalizeStatus = state === "workspace_failed" ? "failed" : "succeeded";
    const settles = state === "failed_successor" || state === "running_successor";
    if (settles) expect(await monitorDelivery.readNativeMonitorDelivery(db, value.binding))
      .toEqual({ wakeId: wake!.id, successorRunId: successorId });
    const original = monitorDelivery.readNativeMonitorDelivery;
    const race = state === "ownership_race"
      ? vi.spyOn(monitorDelivery, "readNativeMonitorDelivery").mockImplementationOnce(async (...args) => {
          const delivery = await original(...args);
          expect(delivery).not.toBeNull();
          executionRunId = value.runId;
          await db.update(issues).set({ executionRunId, checkoutRunId: executionRunId }).where(eq(issues.id, value.issueId));
          return delivery;
        }) : null;
    try {
      await finalizeNativeRun({ db, runId: value.runId, workspaceFinalizeStatus });
    } finally {
      race?.mockRestore();
    }
    const [finalization] = await db.select({
      phase: nativeRunFinalizations.phase, code: nativeRunFinalizations.failureCode, detail: nativeRunFinalizations.failureDetail,
    }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, value.runId));
    expect(finalization, JSON.stringify(finalization)).toMatchObject({ phase: settles ? "committed" : "retryable_failure" });
    expect(await value.read()).toMatchObject({ status: "in_progress", executionRunId, checkoutRunId: executionRunId, monitorNextCheckAt: null });
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, resultId)))[0].resultJson).toEqual(resultJson);
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, value.runId));
    expect(decisions.some(decision => decision.reasonCode === "scheduled_monitor_dispatched")).toBe(settles);
    if (settles) {
      await finalizeNativeRun({ db, runId: value.runId, workspaceFinalizeStatus });
      expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, value.runId))).toEqual(decisions);
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, value.companyId))).toEqual([wake]);
  });
});
