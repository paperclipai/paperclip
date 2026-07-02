import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "heartbeat run display test",
    provider: "test",
    model: "test-model",
  })),
);

const mockAdapterRegistry = vi.hoisted(() => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: mockAdapterExecute,
  })),
  listAdapterModels: vi.fn(() => []),
  refreshAdapterModels: vi.fn(async () => []),
  listServerAdapters: vi.fn(() => []),
  findServerAdapter: vi.fn(() => null),
  findActiveServerAdapter: vi.fn(() => null),
  detectAdapterModel: vi.fn(() => null),
  listAdapterModelProfiles: vi.fn(() => []),
  registerServerAdapter: vi.fn(),
  unregisterServerAdapter: vi.fn(),
  requireServerAdapter: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => mockAdapterRegistry);
vi.mock("../adapters/registry.ts", () => mockAdapterRegistry);

const { heartbeatService } = await import("../services/heartbeat.ts");
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run display tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run display access", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-display-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_runs",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertRunWithLargeJson() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Display Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "failed",
      error: "process failed",
      logStore: "local_file",
      logRef: "runs/run.log",
      resultJson: {
        summary: "Updated the backend",
        result: "Patched heartbeat routes",
        stdout: "x".repeat(128_000),
        stderr: "y".repeat(128_000),
        cost_usd: 1.25,
      },
      contextSnapshot: {
        issueId: randomUUID(),
        taskId: randomUUID(),
        taskKey: "PAP-123",
        commentId: randomUUID(),
        wakeCommentId: randomUUID(),
        wakeReason: "issue_commented",
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        executionWorkspaceId,
        paperclipWake: {
          comments: [{ body: "large comment body".repeat(8_000) }],
        },
      },
    });

    return { companyId, runId, executionWorkspaceId };
  }

  it("serves run display data without hydrating large result or context payloads", async () => {
    const { runId } = await insertRunWithLargeJson();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.getRunForDisplay(runId);

    expect(run).toMatchObject({
      id: runId,
      status: "failed",
      error: "process failed",
      resultJson: {
        summary: "Updated the backend",
        result: "Patched heartbeat routes",
        cost_usd: 1.25,
      },
    });
    expect(run?.resultJson).not.toHaveProperty("stdout");
    expect(run?.resultJson).not.toHaveProperty("stderr");
    expect(run?.contextSnapshot).toMatchObject({
      taskKey: "PAP-123",
      wakeReason: "issue_commented",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
    expect(run?.contextSnapshot).not.toHaveProperty("paperclipWake");
    expect(run?.contextSnapshot).not.toHaveProperty("executionWorkspaceId");
  });

  it("serves route access fields without resultJson or contextSnapshot", async () => {
    const { companyId, runId, executionWorkspaceId } = await insertRunWithLargeJson();
    const heartbeat = heartbeatService(db);

    const access = await heartbeat.getRunAccess(runId);

    expect(access).toEqual({
      id: runId,
      companyId,
      executionWorkspaceId,
    });
    expect(access).not.toHaveProperty("resultJson");
    expect(access).not.toHaveProperty("contextSnapshot");
  });
});
