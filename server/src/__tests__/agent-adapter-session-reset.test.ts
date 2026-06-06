import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent adapter session reset tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService adapter session reset", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-adapter-reset-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("clears persisted runtime and task sessions when adapterType changes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LightKeeper",
      role: "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "claude_local",
      sessionId: "claude-session-1",
      stateJson: { cwd: "/tmp/claude" },
      lastError: "old runtime error",
    });

    await db.insert(agentTaskSessions).values([
      {
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: "task-1",
        sessionDisplayId: "claude-task-session",
        sessionParamsJson: { sessionId: "claude-task-session" },
        lastError: "old claude task error",
      },
      {
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: "task-2",
        sessionDisplayId: "codex-task-session",
        sessionParamsJson: { sessionId: "codex-task-session" },
        lastError: "old codex task error",
      },
    ]);

    const updated = await svc.update(agentId, { adapterType: "codex_local" });

    expect(updated?.adapterType).toBe("codex_local");

    const runtimeState = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(runtimeState?.adapterType).toBe("codex_local");
    expect(runtimeState?.sessionId).toBeNull();
    expect(runtimeState?.stateJson).toEqual({});
    expect(runtimeState?.lastError).toBeNull();

    const taskSessions = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));

    expect(taskSessions).toHaveLength(0);
  });

  it("preserves persisted sessions when adapterType does not change", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodeForge",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "codex-session-1",
      stateJson: { cwd: "/tmp/codex" },
    });

    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "task-1",
      sessionDisplayId: "codex-task-session",
      sessionParamsJson: { sessionId: "codex-task-session" },
    });

    const updated = await svc.update(agentId, {
      adapterConfig: { model: "gpt-5.5" },
    });

    expect(updated?.adapterType).toBe("codex_local");

    const runtimeState = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(runtimeState?.sessionId).toBe("codex-session-1");
    expect(runtimeState?.stateJson).toEqual({ cwd: "/tmp/codex" });

    const taskSessions = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));

    expect(taskSessions).toHaveLength(1);
    expect(taskSessions[0]?.sessionDisplayId).toBe("codex-task-session");
  });
});
