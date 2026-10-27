import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, plugins, projects } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping session preparation tests: ${support.reason}`);

describePostgres("heartbeat session preparation through adapter dispatch", () => {
  const adapterType = "session_preparation_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        // Settle the fixture's work so no automatic unfinished-task retry
        // competes with the next explicit session-continuation wake.
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", sessionParams: { sessionId: "saved-session", adapterState: "preserved" }, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Session fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Session owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Session reader", adapterType, status: "idle", adapterConfig: { model: "model-a" }, runtimeConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Session fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown> = {}) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    expect(captured.has(run!.id)).toBe(true);
    return { input: captured.get(run!.id)!, finished };
  }

  it("reuses unchanged task sessions and strips host freshness metadata before dispatch", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.input.runtime.sessionId).toBeNull();
    const stored = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId)).then(rows => rows[0]);
    expect(stored?.sessionParamsJson).toHaveProperty("__paperclipConfigFingerprint");
    const resumed = await execute(f, { paperclipSessionHandoffMarkdown: "stale handoff", paperclipSessionRotationReason: "stale reason", paperclipPreviousSessionId: "stale session" });
    expect(resumed.input.runtime).toMatchObject({ sessionId: "saved-session", sessionDisplayId: "saved-session", taskKey: f.issueId });
    expect(resumed.input.runtime.sessionParams).toMatchObject({ sessionId: "saved-session", adapterState: "preserved" });
    expect(resumed.input.runtime.sessionParams).not.toHaveProperty("__paperclipConfigFingerprint");
    expect(resumed.input.context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(resumed.input.context.paperclipSessionRotationReason).toBeUndefined();
    expect(resumed.input.context.paperclipPreviousSessionId).toBeUndefined();
    expect(resumed.finished.sessionIdBefore).toBe("saved-session");
  });

  it("keeps inherited project policy stable after binding a repository-free workspace", async () => {
    const f = await seed();
    const storage = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, storage.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, workspaceProvider: {
      ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
    } } }).where(eq(plugins.id, storage.pluginId));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Directory project" }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    try {
      const first = await execute(f);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound.executionWorkspaceId).toEqual(expect.any(String));
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe("saved-session");
      expect(next.input.config.workspaceStrategy).toEqual(first.input.config.workspaceStrategy);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: {
        session: { reset: false, taskSessionReused: true, changedCategories: [] },
        workspace: { action: "reuse", workspaceReused: true, changedCategories: [], activeWorkspaceId: bound.executionWorkspaceId },
      } });
    } finally { await db.delete(plugins).where(eq(plugins.id, storage.pluginId)); }
  });

  it("starts fresh when effective model configuration changes and persists the reason", async () => {
    const f = await seed();
    await execute(f);
    await db.update(agents).set({ adapterConfig: { model: "model-b" } }).where(eq(agents.id, f.agentId));
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.finished.sessionIdBefore).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionAvailable: true, taskSessionReused: false } } });
  });

  it("refreshes tools with a fresh session when the selected adapter cannot refresh on resume", async () => {
    const f = await seed();
    await execute(f);
    const next = await execute(f, { refreshTools: true });
    expect(next.input.context.forceFreshSession).toBe(true);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { resetReasons: ["forceFreshSession was requested"] } } });
  });

  it("rotates a session at the configured run threshold and supplies a handoff", async () => {
    const f = await seed({ sessionCompaction: { enabled: true, maxSessionRuns: 1 } });
    await execute(f);
    await execute(f);
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.input.context.paperclipPreviousSessionId).toBe("saved-session");
    expect(next.input.context.paperclipSessionRotationReason).toBe("session exceeded 1 runs");
    expect(next.input.context.paperclipSessionHandoffMarkdown).toEqual(expect.any(String));
    expect(next.finished.sessionIdBefore).toBeNull();
  });
});
