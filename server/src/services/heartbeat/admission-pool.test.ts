import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { agents, agentTaskSessions, agentWakeupRequests, companies, createDb, instanceSettings, executionWorkspaces, heartbeatRuns, issueRelations, issues, workspaceOperations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { heartbeatService } from "../heartbeat.js";
import { withExecutionWorkspaceLifecycleLock } from "../execution-workspace-lifecycle-lock.js";
import { issueService } from "../issues.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatQueue } from "./queue.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping admission pool tests: ${support.reason}`);

describe.skipIf(!support.supported)("wake admission pool progress", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let observer: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-admission-pool-");
    observer = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await observer?.$client.end();
    await database?.cleanup();
  });

  it.each([{ size: 1, assembled: false }, { size: 2, assembled: false }, { size: 1, assembled: true }, { size: 1, assembled: false, fail: true }])("commits workspace preflight with $size connections (assembled=$assembled, fail=$fail)", async ({ size, assembled, fail }) => {
    const name = `admission-${randomUUID()}`;
    const db = createDb(database.connectionString, { maxConnections: size, applicationName: name });
    const [company] = await observer.insert(companies).values({ name, issuePrefix: `P${randomUUID().slice(0, 7)}` }).returning();
    const work: Array<{ agent: typeof agents.$inferSelect; issue: typeof issues.$inferSelect }> = [];
    for (let index = 0; index < size; index++) {
      const [agent] = await observer.insert(agents).values({ companyId: company.id, name: `Agent ${index}`, status: "idle", adapterType: "codex_local" }).returning();
      const [blocker] = await observer.insert(issues).values({ companyId: company.id, title: "Done blocker", status: "done" }).returning();
      const [workspace] = await observer.insert(executionWorkspaces).values({ companyId: company.id, sourceIssueId: blocker.id, name: "Blocker workspace", mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
      await observer.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, blocker.id));
      await observer.insert(workspaceOperations).values({ companyId: company.id, executionWorkspaceId: workspace.id, issueId: blocker.id, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
      const [issue] = await observer.insert(issues).values({ companyId: company.id, title: "Needs project", status: "todo", assigneeAgentId: agent.id, executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } } }).returning();
      await observer.insert(issueRelations).values({ companyId: company.id, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
      work.push({ agent, issue });
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived = 0;
    let ready!: () => void;
    const reserved = new Promise<void>(resolve => { ready = resolve; });
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => {
      const item = work.find(item => item.agent.id === id);
      if (!item) throw new Error("Unknown fixture agent");
      return item.agent;
    });
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true } as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    const actual = issueService(db);
    deps.issuesSvc.listDependencyReadiness.mockImplementation(async (...args) => {
      const result = await actual.listDependencyReadiness(...args);
      expect(result.get(args[1][0])?.isDependencyReady).toBe(true);
      if (++arrived === size) ready();
      await gate;
      return result;
    });
    const checkSession = deps.hasResolvablePriorSessionWorkspaceForWake;
    const sessionCheck = vi.spyOn(deps, "hasResolvablePriorSessionWorkspaceForWake");
    if (fail) sessionCheck.mockImplementation(async (...args) => {
      await checkSession(...args);
      throw new Error("after session read");
    });
    if (assembled) await observer.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableIsolatedWorkspaces: true } }).onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableIsolatedWorkspaces: true } } });
    const queue = assembled ? { enqueueWakeup: heartbeatService(db).wakeup } : createHeartbeatQueue(db, deps);
    const pending = work.map(({ agent, issue }) => queue.enqueueWakeup(agent.id, { source: "assignment", reason: "issue_blockers_resolved", contextSnapshot: { issueId: issue.id }, payload: { issueId: issue.id } }));
    const finalizers: Promise<unknown>[] = [];
    let sameKeyActive = 0;
    let maxSameKeyActive = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("admission pool progress deadline")), 4000); });
    try {
      if (!assembled) {
        await Promise.race([reserved, deadline]);
        const backends = await observer.execute(sql`select state, query, cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where application_name = ${name}`);
        expect(backends).toHaveLength(size);
        expect(backends.every(row => row.state === "idle in transaction" && String(row.query).includes("workspace_operations") && row.blockers === 0)).toBe(true);
        let entered!: () => void;
        const lockEntered = new Promise<void>(resolve => { entered = resolve; });
        const lockedWork = async () => {
          maxSameKeyActive = Math.max(maxSameKeyActive, ++sameKeyActive);
          try { await db.update(issues).set({ title: "Finalizer progress" }).where(eq(issues.id, work[0].issue.id)); } finally { sameKeyActive--; }
        };
        const firstFinalizer = withExecutionWorkspaceLifecycleLock(db, name, async () => { entered(); await lockedWork(); if (fail) throw new Error("locked work failed"); });
        finalizers.push(fail ? expect(firstFinalizer).rejects.toThrow("locked work failed") : firstFinalizer);
        await Promise.race([lockEntered, deadline]);
        finalizers.push(withExecutionWorkspaceLifecycleLock(db, name, lockedWork));
        let otherEntered!: () => void;
        const otherLockEntered = new Promise<void>(resolve => { otherEntered = resolve; });
        finalizers.push(withExecutionWorkspaceLifecycleLock(db, `${name}-other`, async () => { otherEntered(); await db.execute(sql`select 1`); }));
        await Promise.race([otherLockEntered, deadline]);
      }
      release();
      try {
        const admitted = Promise.race([Promise.all(pending), deadline]);
        if (fail) await expect(admitted).rejects.toThrow("after session read");
        else expect(await admitted).toEqual(work.map(() => null));
      } catch (error) {
        console.error("Session check entered:", sessionCheck.mock.calls.length, "backend state:", await observer.execute(sql`select state, query from pg_stat_activity where application_name = ${name}`));
        throw error;
      }
      await Promise.race([Promise.all(finalizers), deadline]);
      if (!assembled) {
        expect(sessionCheck).toHaveBeenCalledTimes(size);
        expect(maxSameKeyActive).toBe(1);
      }
      for (const { issue } of work) {
        expect((await observer.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: fail ? "todo" : "blocked", executionRunId: null, checkoutRunId: null });
      }
      expect(await observer.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(0);
      expect(await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id))).toHaveLength(fail ? 0 : size);
      await db.execute(sql`select 1`);
      await db.update(issues).set({ title: "Database still progresses" }).where(eq(issues.id, work[0].issue.id));
    } finally {
      clearTimeout(timer);
      release();
      await db.$client.end({ timeout: 0 });
      await Promise.allSettled([...pending, ...finalizers]);
    }
  }, 15000);

  it("preserves session scope and sees transaction-local sessions without another connection", async () => {
    const db = createDb(database.connectionString, { maxConnections: 1 });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-workspace-"));
    try {
      const state = createHeartbeatRunState(db);
      const [company] = await observer.insert(companies).values({ name: "Session scope", issuePrefix: `S${randomUUID().slice(0, 7)}` }).returning();
      const [agent] = await observer.insert(agents).values({ companyId: company.id, name: "Session agent", adapterType: "codex_local" }).returning();
      const input = { agent, contextSnapshot: {}, taskKey: "session-task", explicitResumeSession: null };
      const session = { companyId: company.id, agentId: agent.id, adapterType: agent.adapterType, taskKey: input.taskKey, sessionParamsJson: { sessionId: randomUUID(), cwd } };
      expect(await state.hasResolvablePriorSessionWorkspaceForWake(input)).toBe(false);
      expect(await state.hasResolvablePriorSessionWorkspaceForWake({ ...input, taskKey: null,
        contextSnapshot: { forceFreshSession: true }, explicitResumeSession: {
          resumeFromRunId: randomUUID(), taskKey: null, issueId: null, taskId: null,
          sessionDisplayId: null, sessionParams: { cwd },
        } })).toBe(true);
      await expect(db.transaction(async tx => {
        await tx.insert(agentTaskSessions).values(session);
        expect(await state.hasResolvablePriorSessionWorkspaceForWake(input, tx)).toBe(true);
        expect(await state.hasResolvablePriorSessionWorkspaceForWake({ ...input, taskKey: null }, tx)).toBe(false);
        expect(await state.hasResolvablePriorSessionWorkspaceForWake({ ...input, contextSnapshot: { forceFreshSession: true } }, tx)).toBe(false);
        expect(await state.hasResolvablePriorSessionWorkspaceForWake({ ...input, agent: { ...agent, companyId: randomUUID() } }, tx)).toBe(false);
        for (const invalidCwd of ["/", path.join(cwd, "missing")]) {
          await tx.update(agentTaskSessions).set({ sessionParamsJson: { sessionId: randomUUID(), cwd: invalidCwd } }).where(eq(agentTaskSessions.agentId, agent.id));
          expect(await state.hasResolvablePriorSessionWorkspaceForWake(input, tx)).toBe(false);
        }
        throw new Error("rollback session");
      })).rejects.toThrow("rollback session");
      expect(await state.getTaskSession(company.id, agent.id, agent.adapterType, input.taskKey)).toBeNull();
      await db.insert(agentTaskSessions).values(session);
      expect(await state.hasResolvablePriorSessionWorkspaceForWake(input)).toBe(true);
      await db.execute(sql`select 1`);
    } finally {
      await db.$client.end({ timeout: 0 });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
