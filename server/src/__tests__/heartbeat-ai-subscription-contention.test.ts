import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { heartbeatService } from "../services/heartbeat.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import type { AdapterExecutionContext } from "../adapters/index.js";

const execute = vi.hoisted(() => vi.fn(async (_input: AdapterExecutionContext) => ({
  exitCode: 0, signal: null, timedOut: false, resultJson: {}, summary: "Fixture work completed.",
})));
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

const afterCheckout = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.js")>("../services/issues.js");
  return { ...actual, issueService: (...args: Parameters<typeof actual.issueService>) => {
    const service = actual.issueService(...args);
    return { ...service, checkout: async (...checkoutArgs: Parameters<typeof service.checkout>) => {
      const result = await service.checkout(...checkoutArgs);
      await afterCheckout();
      return result;
    } };
  } };
});

describe("heartbeat AI subscription contention", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-contention-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "subscription-contention-tests");
    database = await startEmbeddedPostgresTestDatabase("paperclip-subscription-contention-db-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, summary: "Fixture work completed." };
    });
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    execute.mockClear();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Contention fixture", issuePrefix: `S${companyId.slice(0, 8).toUpperCase()}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const binding = { provider: "openai", method: "subscription", mode: "responsible_user" } as const;
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", adapterType: "codex_local", adapterConfig: { cwd: home }, runtimeConfig: { aiConnection: binding, heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Child task", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    const account = await aiConnectionService(db).save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Fixture subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }));
    const parent = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "codex_local", binding, config: { cwd: home } });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await parent.cleanup();
    };
    return { companyId, agentId, issueId, userId, account, parent, release };
  }

  async function defer(f: Awaited<ReturnType<typeof fixture>>, context: Record<string, unknown> = {}) {
    const run = await heartbeat.invoke(f.agentId, "assignment", {
      issueId: f.issueId, wakeReason: "issue_assigned", ...context,
    }, "system");
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "cancelled", errorCode: "ai_connection_busy" });
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy" });
    return retry!;
  }

  async function dispatch(retry: typeof heartbeatRuns.$inferSelect, service = heartbeat) {
    await service.promoteDueScheduledRetries(new Date(retry.scheduledRetryAt!.getTime() + 1));
    await service.resumeQueuedRuns();
    await service.drainActiveRunExecutions();
  }

  it("defers a child without a reconnect blocker and executes after its parent's subscription is released", async () => {
    const f = await fixture();
    try {
      const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned" }, "system");
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const deferred = await heartbeat.getRun(run!.id);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "ai_connection_busy" });
      expect(execute).not.toHaveBeenCalled();
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy" });
      expect(executionFailureRetryCount(retry)).toBe(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.status).not.toBe("blocked");
      expect(issue.executionRunId).toBe(retry.id);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      await f.release();
      await heartbeat.promoteDueScheduledRetries(new Date(retry.scheduledRetryAt!.getTime() + 1));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const completed = await heartbeat.getRun(retry.id);
      expect(completed).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(completed?.contextSnapshot?.aiConnection).toMatchObject({ grantId: f.account.grantId, identity: f.parent.identity });
    } finally {
      await f.release();
    }
  });

  it("keeps waiting beyond the failure-attempt limit and survives a new service instance", async () => {
    const f = await fixture();
    try {
      let retry = await defer(f, {
        failureRetriesBeforeAiConnectionWait: 99, aiConnectionBusyDeferredWhileAssignee: false,
      });
      expect(retry.contextSnapshot?.aiConnectionBusyDeferredWhileAssignee).toBe(true);
      for (let count = 0; count < 3; count++) {
        await dispatch(retry);
        const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry.id));
        expect(successor).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: count + 2 });
        expect(executionFailureRetryCount(successor)).toBe(0);
        retry = successor!;
        const projections = await executionProjectionsForRuns(db, f.companyId, [retry.id]);
        expect(projections.get(retry.id)).toMatchObject({
          phase: "retry_scheduled", label: "Waiting for AI subscription", attempt: 1,
        });
      }
      expect(execute).not.toHaveBeenCalled();
      await f.release();
      await dispatch(retry, heartbeatService(db));
      expect(await heartbeat.getRun(retry.id)).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await f.release();
    }
  });

  it.each([
    ["cancelled", "issue_cancelled"],
    ["done", "issue_terminal_status"],
    ["reassigned", "issue_reassigned"],
    ["agent_paused", "agent_not_invokable"],
  ])("does not dispatch after the waiting task is %s", async (change, errorCode) => {
    const f = await fixture();
    try {
      const retry = await defer(f);
      if (change === "agent_paused") {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      } else {
        await db.update(issues).set(change === "reassigned"
          ? { assigneeAgentId: null, assigneeUserId: f.userId }
          : { status: change }).where(eq(issues.id, f.issueId));
      }
      await f.release();
      await dispatch(retry);
      expect(await heartbeat.getRun(retry.id)).toMatchObject({ status: "cancelled", errorCode });
      expect(execute).not.toHaveBeenCalled();
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.executionRunId).toBeNull();
    } finally {
      await f.release();
    }
  });

  it.each(["issue_assigned", "issue_commented"])("does not turn an assignee %s wake into a non-assignee retry after reassignment during preflight", async (wakeReason) => {
    const f = await fixture();
    try {
      afterCheckout.mockImplementationOnce(async () => {
        await db.update(issues).set({
          assigneeAgentId: null, assigneeUserId: f.userId, executionRunId: null,
        }).where(eq(issues.id, f.issueId));
      });
      const commentId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "Continue this task." });
      const run = await heartbeat.invoke(f.agentId, "assignment", {
        issueId: f.issueId, wakeReason, commentId, aiConnectionBusyDeferredWhileAssignee: false,
      }, "system");
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "cancelled", errorCode: "ai_connection_busy" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      afterCheckout.mockReset();
      await f.release();
    }
  });

  it("resumes an authorized comment wake without stealing the assignee's task lock", async () => {
    const f = await fixture();
    try {
      await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: f.userId }).where(eq(issues.id, f.issueId));
      const retry = await defer(f, { wakeReason: "issue_comment_mentioned", commentId: randomUUID() });
      expect(retry.contextSnapshot?.aiConnectionBusyDeferredWhileAssignee).toBe(false);
      await dispatch(retry);
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry.id));
      expect(successor).toMatchObject({ status: "scheduled_retry" });
      expect(successor.contextSnapshot?.aiConnectionBusyDeferredWhileAssignee).toBe(false);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.executionRunId).toBeNull();
      await f.release();
      await dispatch(successor);
      expect(await heartbeat.getRun(successor.id)).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await f.release();
    }
  });

  it("rechecks revoked credentials after waiting and retains the configuration failure", async () => {
    const f = await fixture();
    try {
      const retry = await defer(f);
      await f.release();
      await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, f.account.grantId));
      await dispatch(retry);
      expect(await heartbeat.getRun(retry.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
      expect(execute).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry.id))).toHaveLength(0);
    } finally {
      await f.release();
    }
  });
});
