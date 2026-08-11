import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent session invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-session-invalidation-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seed(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Session Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      sessionId: "runtime-session",
      stateJson: { sessionId: "runtime-session" },
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "issue-session-test",
      sessionParamsJson: { sessionId: "task-session" },
      sessionDisplayId: "task-session",
    });
    return { companyId, agentId };
  }

  it("clears persisted sessions and records evidence when the model changes", async () => {
    const fixture = await seed({ model: "gpt-5.4", modelReasoningEffort: "high" });

    await agentService(db).update(
      fixture.agentId,
      { adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high" } },
      { recordRevision: { createdByUserId: "local-board", source: "patch" } },
    );

    await expect(
      db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, fixture.agentId)),
    ).resolves.toHaveLength(0);
    const [runtimeState] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, fixture.agentId));
    expect(runtimeState).toMatchObject({ sessionId: null, stateJson: {}, lastError: null });
    const [audit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.task_sessions_invalidated"));
    expect(audit).toMatchObject({
      actorType: "user",
      actorId: "local-board",
      entityType: "agent",
      entityId: fixture.agentId,
      details: {
        changedFields: ["adapterConfig.model"],
        taskSessionsCleared: 1,
      },
    });
  });

  it("keeps sessions when only a non-identity setting changes", async () => {
    const fixture = await seed({ model: "gpt-5.6-sol", modelReasoningEffort: "high", timeoutSec: 1_800 });

    await agentService(db).update(
      fixture.agentId,
      { adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high", timeoutSec: 3_600 } },
      { recordRevision: { createdByUserId: "local-board", source: "patch" } },
    );

    await expect(
      db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, fixture.agentId)),
    ).resolves.toHaveLength(1);
    const invalidations = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.task_sessions_invalidated"));
    expect(invalidations).toHaveLength(0);
  });

  it("removes an adapter-specific issue model override during adapter migration", async () => {
    const fixture = await seed({});
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: fixture.companyId,
      title: "Provider override",
      status: "todo",
      priority: "high",
      assigneeAgentId: fixture.agentId,
      assigneeAdapterOverrides: {
        adapterConfig: { model: "codex-model", timeoutSec: 1_800 },
        useProjectWorkspace: false,
      },
    });

    await agentService(db).update(
      fixture.agentId,
      { adapterType: "claude_local" },
      { recordRevision: { createdByUserId: "local-board", source: "patch" } },
    );

    const [issue] = await db
      .select({ overrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue?.overrides).toEqual({
      adapterConfig: { timeoutSec: 1_800 },
      useProjectWorkspace: false,
    });
    const [audit] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.assignee_adapter_override_migrated"));
    expect(audit).toMatchObject({ entityType: "issue", entityId: issueId });
  });
});
