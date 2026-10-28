import { issueTreeControlService } from "../services/issue-tree-control.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, agentWakeupRequests, issues, activityLog } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer monitor admission generation", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-monitor-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  const markers: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(markers.splice(0).map(path => rm(path, { force: true }))); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    return { companyId, agentId, issueId, source, issue };
  }

  async function monitored() {
    const f = await seed();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] } }).where(eq(agents.id, f.agentId));
    await issueService(db).update(f.issueId, { monitorNextCheckAt: new Date(Date.now() + 60_000), monitorNotes: "Inspect checks", executionPolicy: { ...f.issue.executionPolicy!, monitor: {
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Inspect checks", scheduledBy: "board",
      kind: "external_service", serviceName: "github_checks", maxAttempts: 3, timeoutAt: new Date(Date.now() + 300_000).toISOString(),
    } } });
    const marker = join(process.env.TMPDIR!, `monitor-provider-${randomUUID()}`);
    markers.push(marker);
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] } }).where(eq(agents.id, f.agentId));
    return { f, busy, marker };
  }

  it("dispatches the unchanged reviewer after its own monitor consumption", async () => {
    const { f, busy } = await monitored();
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      expect(await service.triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      const review = runs.find(run => run.id !== busy.id)!;
      expect(review).toMatchObject({ status: "queued" });
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.executionState?.reviewRequest).toEqual(f.issue.executionState?.reviewRequest);
      expect(task.executionState?.currentParticipant).toEqual(f.issue.executionState?.currentParticipant);
      expect(task.monitorNextCheckAt).toBeNull();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns();
      await service.drainActiveRunExecutions();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, review.id)))[0]).toMatchObject({ status: "succeeded", errorCode: null });
    } finally { await service.drainActiveRunExecutions(); }
  });
  it.each(["consumption", "admission", "settlement"] as const)("rolls back %s failure and retries the exact monitor", async fault => {
    const { f, marker } = await monitored();
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    let injected = false;
    const failing = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (...args: Parameters<typeof db.transaction>) => target.transaction(async tx => {
        const observed = new Proxy(tx, { get(transaction, field) {
          if (fault === "admission" && field === "insert") return (table: unknown) => {
            if (table === heartbeatRuns) { injected = true; throw new Error("synthetic admission failure"); }
            return Reflect.apply(transaction.insert, transaction, [table]);
          };
          if (fault === "consumption" && field === "update") return (table: unknown) => {
            const update = Reflect.apply(transaction.update, transaction, [table]);
            return new Proxy(update, { get(builder, method) {
              if (method !== "set") return Reflect.get(builder, method);
              return (patch: Record<string, unknown>) => {
                if (table === issues && patch.monitorNextCheckAt === null) { injected = true; throw new Error("synthetic consumption failure"); }
                return Reflect.apply(builder.set, builder, [patch]);
              };
            } });
          };
          return Reflect.get(transaction, field);
        } });
        const value = await args[0](observed);
        if (fault === "settlement" && value && typeof value === "object" && "kind" in value && value.kind === "queued") {
          injected = true; throw new Error("synthetic settlement failure");
        }
        return value;
      }, args[1]);
    } });
    const service = heartbeatService(failing);
    await expect(service.triggerIssueMonitor(f.issueId)).rejects.toThrow(`synthetic ${fault} failure`);
    expect(injected).toBe(true);
    await service.drainActiveRunExecutions();
    const [retained] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(retained).toMatchObject({ monitorNextCheckAt: before.monitorNextCheckAt, monitorWakeRequestedAt: null,
      executionPolicy: before.executionPolicy, executionState: before.executionState, monitorAttemptCount: before.monitorAttemptCount });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await heartbeatService(db).triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
  });

  it("starts its provider only after the outer admission commit", async () => {
    const { f, busy, marker } = await monitored();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const nativeTransaction = db.transaction.bind(db);
    const paused = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (...args: Parameters<typeof db.transaction>) => nativeTransaction(async tx => {
        const value = await args[0](tx);
        if (value && typeof value === "object" && "kind" in value && value.kind === "queued") { entered(); await gate; }
        return value;
      }, args[1]);
    } });
    vi.spyOn(db, "transaction").mockImplementation(paused.transaction);
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const trigger = service.triggerIssueMonitor(f.issueId);
    try {
      await Promise.race([ready, trigger.then(() => { throw new Error("Admission bypassed commit barrier"); })]);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].monitorNextCheckAt).not.toBeNull();
      release(); expect(await trigger).toMatchObject({ outcome: "triggered" });
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started"), { timeout: 15_000 });
    } finally { release(); await trigger; await service.drainActiveRunExecutions(); }
  }, 30_000);

  it("recovers a committed monitor handoff after its admission response is lost", async () => {
    const { f, busy, marker } = await monitored();
    let lost = false;
    const unreliable = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const value = await Reflect.apply(target.transaction, target, args);
        if (!lost && value?.kind === "queued") { lost = true; throw new Error("synthetic committed response loss"); }
        return value;
      };
    } });
    await expect(heartbeatService(unreliable).triggerIssueMonitor(f.issueId)).rejects.toThrow("synthetic committed response loss");
    expect(lost).toBe(true);
    await expect(heartbeatService(db).triggerIssueMonitor(f.issueId)).rejects.toThrow("no scheduled monitor");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await restarted.resumeQueuedRuns(); await restarted.drainActiveRunExecutions();
    expect(await readFile(marker, "utf8")).toBe("started");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "issue_monitor_due"))).filter(row => row.companyId === f.companyId)).toHaveLength(1);
  });

  it("serializes duplicate monitor triggers across two service instances", async () => {
    const { f } = await monitored();
    const outcomes = await Promise.allSettled([heartbeatService(db).triggerIssueMonitor(f.issueId), heartbeatService(db).triggerIssueMonitor(f.issueId)]);
    expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].monitorNextCheckAt).toBeNull();
  });

  it.each(["replacement", "policy", "hold"] as const)("rejects a claim raced by %s without consuming newer duty or changing old runs", async race => {
    const { f, busy, marker } = await monitored();
    let changed = false, holdId: string | undefined;
    const replacementAt = new Date(Date.now() + 120_000);
    const racing = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const value = await Reflect.apply(target.transaction, target, args);
        if (!changed && value?.id === f.issueId && value.monitorWakeRequestedAt) {
          changed = true;
          if (race === "replacement") {
            const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
            await issueService(db).update(f.issueId, { monitorNextCheckAt: replacementAt, monitorNotes: "Replacement",
              executionPolicy: { ...current.executionPolicy!, monitor: { ...current.executionPolicy!.monitor!,
                nextCheckAt: replacementAt.toISOString(), notes: "Replacement", timeoutAt: new Date(Date.now() + 600_000).toISOString() } } });
          }
          else if (race === "policy") {
            const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
            await issueService(db).update(f.issueId, { executionPolicy: { ...current.executionPolicy!, commentRequired: false } });
          } else holdId = (await issueTreeControlService(db).createHold(f.companyId, f.issueId,
            { mode: "pause", actor: { actorType: "system", actorId: "fixture" } })).hold.id;
        }
        return value;
      };
    } });
    const outcome = await Promise.allSettled([heartbeatService(racing).triggerIssueMonitor(f.issueId)]);
    expect(changed).toBe(true);
    if (race === "policy") expect(outcome[0].status).toBe("rejected");
    else expect(outcome[0]).toMatchObject({ status: "fulfilled", value: { outcome: "skipped" } });
    const [retained] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(retained.monitorNextCheckAt).not.toBeNull();
    if (race === "replacement") expect(retained.monitorNextCheckAt).toEqual(replacementAt);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toMatchObject([{ id: busy.id, contextSnapshot: busy.contextSnapshot }]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (holdId) await issueTreeControlService(db).releaseHold(f.companyId, f.issueId, holdId,
      { actor: { actorType: "system", actorId: "fixture" } });
    expect(await heartbeatService(db).triggerIssueMonitor(f.issueId, race === "replacement" ? { now: new Date(Date.now() + 360_000) } : undefined))
      .toMatchObject({ outcome: "triggered" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
  });

  it.each(["queued", "running"] as const)("does not rebind an existing %s review during monitor admission", async status => {
    const { f } = await monitored();
    const service = heartbeatService(db);
    const original = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(original).toBeTruthy();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, original!.id));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id));
    await service.triggerIssueMonitor(f.issueId);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id));
    expect(after.contextSnapshot).toEqual(before.contextSnapshot);
    expect(after.wakeupRequestId).toBe(before.wakeupRequestId);
    expect(after.status).toBe(status);
  });

  it("rejects a real submission change after monitor admission commits", async () => {
    const { f, busy, marker } = await monitored();
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      expect(await service.triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      const review = runs.find(run => run.id !== busy.id)!;
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.update(issues).set({ executionState: { ...task.executionState!, reviewRequest: { instructions: "Changed submission" } } })
        .where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, review.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "issue_review_participant_changed", contextSnapshot: review.contextSnapshot });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await service.drainActiveRunExecutions(); }
  });
  it("delivers a stamped reviewer retry after its provider quota monitor is consumed", async () => {
    const { f, busy, marker } = await monitored();
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const source = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(source?.contextSnapshot?.reviewerAssignmentGeneration).toEqual(expect.any(String));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed", errorCode: "provider_quota", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, finishedAt: new Date() }).where(eq(heartbeatRuns.id, source!.id));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const next = new Date(Date.now() + 60_000);
    await issueService(db).update(f.issueId, { monitorNextCheckAt: next, monitorNotes: "Quota retry",
      executionPolicy: { ...task.executionPolicy!, monitor: { nextCheckAt: next.toISOString(), notes: "Quota retry",
        scheduledBy: "board", kind: "external_service", serviceName: "AI provider quota", externalRef: source!.id,
        maxAttempts: 3, timeoutAt: new Date(Date.now() + 300_000).toISOString() } } });
    try {
      expect(await service.triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
      const retries = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id)));
      expect(retries).toHaveLength(1);
      const retry = retries[0];
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.retryScheduledRetryNow({ issueId: f.issueId });
      await service.resumeQueuedRuns();
      await service.drainActiveRunExecutions();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0])
        .toMatchObject({ status: "succeeded", errorCode: null });
      expect(await readFile(marker, "utf8")).toBe("started");
    } finally { await service.drainActiveRunExecutions(); }
  });

  async function quotaReady() {
    const input = await monitored();
    const { f } = input;
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const source = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(source?.contextSnapshot?.reviewerAssignmentGeneration).toEqual(expect.any(String));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed", errorCode: "provider_quota",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, finishedAt: new Date() }).where(eq(heartbeatRuns.id, source!.id));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const next = new Date(Date.now() + 60_000);
    const install = (externalRef = source!.id) => issueService(db).update(f.issueId, { monitorNextCheckAt: next, monitorNotes: "Quota retry",
      executionPolicy: { ...task.executionPolicy!, monitor: { nextCheckAt: next.toISOString(), notes: "Quota retry",
        scheduledBy: "board", kind: "external_service", serviceName: "AI provider quota", externalRef,
        maxAttempts: 3, timeoutAt: new Date(Date.now() + 300_000).toISOString() } } });
    return { ...input, service, source: source!, install };
  }

  it.each(["before installation", "after installation", "missing proof", "foreign source", "before provider"] as const)("rejects quota retry with %s changes or evidence", async phase => {
    const { f, busy, marker, service, source, install } = await quotaReady();
    const change = async () => {
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await issueService(db).update(f.issueId, { executionState: { ...task.executionState!, reviewRequest: { instructions: "Changed submission" } } });
    };
    try {
      if (phase === "before installation") { await change(); await expect(install()).rejects.toThrow("submission changed"); }
      else if (phase === "foreign source") {
        const foreign = await seed();
        await expect(install(foreign.source.id)).rejects.toThrow("source does not belong");
      } else {
        await install();
        if (phase === "after installation") await change();
        if (phase === "missing proof") await db.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
        if (phase === "before provider") {
          expect(await service.triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
          await change();
          await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
          await service.retryScheduledRetryNow({ issueId: f.issueId }); await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
          const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
          expect(retries).toMatchObject([{ status: "cancelled", errorCode: "issue_review_participant_changed" }]);
        } else await expect(service.triggerIssueMonitor(f.issueId)).rejects.toThrow("matching source submission proof");
      }
      if (phase !== "before provider") {
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].monitorNextCheckAt).not.toBeNull();
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0].contextSnapshot)
        .toEqual(source.contextSnapshot);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await service.drainActiveRunExecutions(); }
  });

  it.each(["consumption", "admission", "settlement"] as const)("rolls back quota %s failure and retains the same installed monitor proof", async fault => {
    const { f, marker, source, install } = await quotaReady(); await install();
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    let injected = false;
    const failing = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (...args: Parameters<typeof db.transaction>) => target.transaction(async tx => {
        const observed = new Proxy(tx, { get(transaction, field) {
          if (fault === "admission" && field === "insert") return (table: unknown) => {
            if (table === heartbeatRuns) { injected = true; throw new Error("synthetic quota admission failure"); }
            return Reflect.apply(transaction.insert, transaction, [table]);
          };
          if (fault === "consumption" && field === "update") return (table: unknown) => {
            const update = Reflect.apply(transaction.update, transaction, [table]);
            return new Proxy(update, { get(builder, method) {
              if (method !== "set") return Reflect.get(builder, method);
              return (patch: Record<string, unknown>) => {
                if (table === issues && patch.monitorNextCheckAt === null) { injected = true; throw new Error("synthetic quota consumption failure"); }
                return Reflect.apply(builder.set, builder, [patch]);
              };
            } });
          };
          return Reflect.get(transaction, field);
        } });
        const value = await args[0](observed);
        if (fault === "settlement" && value && typeof value === "object" && "outcome" in value && value.outcome === "scheduled") {
          injected = true; throw new Error("synthetic quota settlement failure");
        }
        return value;
      }, args[1]);
    } });
    await expect(heartbeatService(failing).triggerIssueMonitor(f.issueId)).rejects.toThrow(`synthetic quota ${fault} failure`);
    expect(injected).toBe(true);
    const [retained] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(retained).toMatchObject({ monitorNextCheckAt: before.monitorNextCheckAt, monitorWakeRequestedAt: null,
      executionPolicy: before.executionPolicy, executionState: before.executionState });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await heartbeatService(db).triggerIssueMonitor(f.issueId)).toMatchObject({ outcome: "triggered" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(1);
  });

  it("recovers one committed quota retry after a lost response and duplicate service trigger", async () => {
    const { f, busy, marker, source, install } = await quotaReady(); await install();
    let lost = false;
    const unreliable = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const value = await Reflect.apply(target.transaction, target, args);
        if (!lost && value?.outcome === "scheduled") { lost = true; throw new Error("synthetic committed quota response loss"); }
        return value;
      };
    } });
    await expect(heartbeatService(unreliable).triggerIssueMonitor(f.issueId)).rejects.toThrow("synthetic committed quota response loss");
    expect(lost).toBe(true);
    await expect(heartbeatService(db).triggerIssueMonitor(f.issueId)).rejects.toThrow("no scheduled monitor");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      await restarted.retryScheduledRetryNow({ issueId: f.issueId }); await restarted.resumeQueuedRuns(); await restarted.drainActiveRunExecutions();
      expect(await readFile(marker, "utf8")).toBe("started");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id)))
        .toMatchObject([{ status: "succeeded" }]);
    } finally { await restarted.drainActiveRunExecutions(); }
  });

  it("serializes quota triggers across two services without re-stamping an existing retry", async () => {
    const { f, source, install } = await quotaReady(); await install();
    const outcomes = await Promise.allSettled([heartbeatService(db).triggerIssueMonitor(f.issueId), heartbeatService(db).triggerIssueMonitor(f.issueId)]);
    expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
    expect(retries).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0].contextSnapshot).toEqual(source.contextSnapshot);
  });

  it.each(["missing", "changed"] as const)("retains quota duty on real deadline delivery with %s proof", async fault => {
    const { f, source, service, install } = await quotaReady(); await install();
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    if (fault === "missing") await db.delete(activityLog).where(eq(activityLog.companyId, f.companyId));
    else await issueService(db).update(f.issueId, { executionState: { ...before.executionState!, reviewRequest: { instructions: "new submission" } } });
    await service.tickTimers(new Date(before.monitorNextCheckAt!.getTime() + 1));
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].monitorNextCheckAt).toEqual(before.monitorNextCheckAt);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
  });

  it.each(["native", "reconciliation"] as const)("rechecks a quota source becoming %s inside retry admission", async fault => {
    const { f, source, install } = await quotaReady(); await install();
    let claimed = false, mutated = false;
    const racing = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        if (claimed && !mutated) {
          mutated = true;
          await db.update(heartbeatRuns).set(fault === "native" ? { runtimeMode: "native" } :
            { resultJson: { executionRecovery: { kind: "interrupted", providerWorkStarted: true } } }).where(eq(heartbeatRuns.id, source.id));
        }
        const value = await Reflect.apply(target.transaction, target, args);
        if (value?.id === f.issueId && value.monitorWakeRequestedAt) claimed = true;
        return value;
      };
    } });
    await expect(heartbeatService(racing).triggerIssueMonitor(f.issueId)).rejects.toThrow();
    expect(mutated).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].monitorNextCheckAt).not.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
  });

});
