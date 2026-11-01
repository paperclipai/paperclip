import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { runningProcesses } from "../adapters/index.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { refreshReadyConnectionTools } from "../services/connection-tool-refresh.js";
import { buildPaperclipRuntimeMcpServers, heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("ready connection tool refresh", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-tool-refresh-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tool refresh", issuePrefix: "TRF", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user", email: "responsible@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Read Notion", level: "task", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, goalId, title: "Read a Notion page", status: "in_progress", priority: "medium", assigneeAgentId: agentId });
  }, 20_000);

  afterAll(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await cleanup?.();
  });

  async function startRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: "responsible-user", contextSnapshot: { issueId } });
    const claims: RuntimeToolsTokenClaims = {
      sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: "responsible-user",
      scope: "connection_intents", iat: 1, exp: 2, instance_id: "test",
    };
    return claims;
  }

  async function connectNotion() {
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `notion-${randomUUID()}`, name: "Notion", type: "mcp_http", status: "active",
      metadata: { sourceTemplateKey: "notion" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Responsible user's Notion", uid: `notion/${randomUUID()}`,
      transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_user", status: "active", enabled: true, healthStatus: "ok",
      config: { sourceTemplateKey: "notion", url: "https://notion.example.test/mcp" }, transportConfig: { sourceTemplateKey: "notion" },
    }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: "responsible-user", status: "active", isDefault: false });
    await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: "notion-read", name: "notion-read", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connection!.id}`, name: "Notion", defaultAction: "deny", status: "active" }).returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", applicationId: application!.id, connectionId: connection!.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
    return connection!;
  }

  function persistingWakeup() {
    return vi.fn(async (wakeAgentId: string, input: { idempotencyKey: string; source: string; reason: string; payload: Record<string, unknown> }) => {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId: wakeAgentId, source: input.source, reason: input.reason,
        payload: input.payload, idempotencyKey: input.idempotencyKey, status: "deferred_issue_execution",
      });
      return null;
    });
  }

  it("persists one tool-refresh continuation when the run started before the connection was usable", async () => {
    const claims = await startRun();
    const connection = await connectNotion();
    const ready = await connectionIntentService(db).request(claims, "notion");
    expect(ready).toMatchObject({ state: "ready", connectionId: connection.id, interactionId: null });
    expect(ready.instruction).not.toContain("continuation");

    const wakeup = persistingWakeup();
    const first = await refreshReadyConnectionTools(db, { wakeup } as never, claims, ready);
    expect(first).toMatchObject({ state: "ready", toolRefresh: "requested" });
    expect(first.instruction.startsWith(ready.instruction)).toBe(true);
    expect(first.instruction).toContain("continuation with updated tools is queued");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]![0]).toBe(agentId);
    expect(wakeup.mock.calls[0]![1]).toMatchObject({
      idempotencyKey: expect.stringMatching(new RegExp(`^connection-intent:tools:${claims.run_id}:[0-9a-f]{64}$`)),
      issueStateGuard: { statuses: ["in_progress", "in_review"], assigneeAgentId: agentId },
      contextSnapshot: { issueId, taskId: issueId, refreshTools: true, source: "connection_tools.refreshed" },
    });

    const repeated = await refreshReadyConnectionTools(db, { wakeup } as never, claims, ready);
    expect(repeated).toMatchObject({ toolRefresh: "deduplicated" });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(1);
  });

  it("requests nothing when the run already received the current assignment", async () => {
    const claims = await startRun();
    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: { id: agentId, companyId, name: "Reviewer" }, runId: claims.run_id });
    expect(servers).toHaveLength(1);
    const ready = await connectionIntentService(db).request(claims, "notion");
    const wakeup = persistingWakeup();
    const result = await refreshReadyConnectionTools(db, { wakeup } as never, claims, ready);
    expect(result).toMatchObject({ state: "ready", toolRefresh: "not_needed", instruction: ready.instruction });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("reports an unavailable refresh instead of implying a queued continuation", async () => {
    const claims = await startRun();
    const ready = await connectionIntentService(db).request(claims, "notion");
    const wakeup = vi.fn(async () => null);
    const result = await refreshReadyConnectionTools(db, { wakeup } as never, claims, ready);
    expect(result).toMatchObject({ toolRefresh: "unavailable" });
    expect(result.instruction).not.toContain("queued");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("queues a successor behind the running task run through the real wake path", async () => {
    const claims = await startRun();
    await db.update(issues).set({ executionRunId: claims.run_id, executionAgentNameKey: "reviewer", executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    runningProcesses.set(claims.run_id, { child: {} as never, graceSec: 0, processGroupId: null });
    try {
      const ready = await connectionIntentService(db).request(claims, "notion");
      const result = await refreshReadyConnectionTools(db, heartbeatService(db), claims, ready);
      expect(result).toMatchObject({ state: "ready", toolRefresh: "requested" });
      expect(result.instruction.startsWith(ready.instruction)).toBe(true);
      const [successor] = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
        .filter(row => row.idempotencyKey?.startsWith(`connection-intent:tools:${claims.run_id}:`));
      expect(successor).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(successor!.payload).toMatchObject({ issueId, _paperclipWakeContext: { issueId, refreshTools: true, source: "connection_tools.refreshed" } });
      const [current] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, claims.run_id));
      expect(current!.contextSnapshot).not.toHaveProperty("refreshTools");
    } finally {
      runningProcesses.delete(claims.run_id);
      await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null }).where(eq(issues.id, issueId));
    }
  });

  it("reports an unavailable refresh when the wake is refused", async () => {
    const claims = await startRun();
    const ready = await connectionIntentService(db).request(claims, "notion");
    const wakeup = vi.fn(async () => { throw conflict("Agent budget exhausted"); });
    const result = await refreshReadyConnectionTools(db, { wakeup } as never, claims, ready);
    expect(result).toMatchObject({ state: "ready", toolRefresh: "unavailable" });
    expect(result.instruction.startsWith(ready.instruction)).toBe(true);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("leaves non-ready results unchanged", async () => {
    const claims = await startRun();
    const wakeup = vi.fn();
    const pending = { state: "needs_user_action", interactionId: randomUUID(), connectionId: null, instruction: "Wait." };
    await expect(refreshReadyConnectionTools(db, { wakeup } as never, claims, pending)).resolves.toBe(pending);
    expect(wakeup).not.toHaveBeenCalled();
  });
});
