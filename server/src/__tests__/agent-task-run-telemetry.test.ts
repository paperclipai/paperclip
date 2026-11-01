import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { emitAgentTaskRun, emitAgentTaskRunById } from "../services/agent-task-run-telemetry.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("emitAgentTaskRun", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-task-run-telemetry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(
    agentOverrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...agentOverrides,
    });
    return { companyId, agentId };
  }

  it("emits one agent.task_run event for each of the five terminal states", async () => {
    await seedCompanyAndAgent();
    const states = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
    for (const state of states) {
      mockTrackAgentTaskRun.mockClear();
      const runId = randomUUID();
      const run = {
        id: runId,
        companyId,
        agentId,
        status: state,
        startedAt: null,
        finishedAt: null,
        usageJson: null,
        contextSnapshot: null,
      } as unknown as typeof heartbeatRuns.$inferSelect;

      await emitAgentTaskRun(db, run);

      expect(mockTrackAgentTaskRun).toHaveBeenCalledTimes(1);
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({ agentId, state }),
      );
    }
  });

  it("emits the same event from a small scoped run read without loading execution payloads", async () => {
    await seedCompanyAndAgent();
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:00:07Z"),
      contextSnapshot: { issueId: randomUUID(), prompt: payload }, runnerProfileJson: { instructions: payload },
      stdoutExcerpt: payload, resultJson: { stdout: payload }, usageJson: { model: "fixture", inputTokens: 12, outputTokens: 34, cachedInputTokens: 5 },
    }).returning();
    await emitAgentTaskRun(db, run);
    const expected = mockTrackAgentTaskRun.mock.calls[0];
    mockTrackAgentTaskRun.mockClear();
    const reads: unknown[][] = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args);
          if (args[0] === heartbeatRuns) {
            const execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const rows = await execute(...executeArgs); reads.push(rows); return rows;
            };
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    await emitAgentTaskRunById(recorded, { companyId, runId: run.id });
    expect(mockTrackAgentTaskRun).toHaveBeenCalledExactlyOnceWith(...expected);
    expect(reads).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(reads))).toBeLessThan(1024);
    await emitAgentTaskRunById(recorded, { companyId: randomUUID(), runId: run.id });
    expect(mockTrackAgentTaskRun).toHaveBeenCalledTimes(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
  });

  it.each([null, [], 42, { issueId: 42 }, { issueId: "  fixture-task  " }, { issueId: "" }].map(context => ({ context })))("preserves telemetry task identity for $context", async ({ context }) => {
    await seedCompanyAndAgent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed",
      contextSnapshot: context as Record<string, unknown> | null }).returning();
    await emitAgentTaskRun(db, run);
    const expected = mockTrackAgentTaskRun.mock.calls[0];
    mockTrackAgentTaskRun.mockClear();
    await emitAgentTaskRunById(db, { companyId, runId: run.id });
    expect(mockTrackAgentTaskRun).toHaveBeenCalledExactlyOnceWith(...expected);
  });

  it("omits durationSeconds when the run has no startedAt", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("durationSeconds");
  });

  it("sends whole seconds from startedAt to finishedAt", async () => {
    await seedCompanyAndAgent();
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const finishedAt = new Date("2026-01-01T00:00:07.400Z");
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt,
      finishedAt,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.durationSeconds).toBe(7);
    expect(Number.isInteger(dims.durationSeconds)).toBe(true);
  });

  it("never returns a negative durationSeconds when finishedAt precedes startedAt", async () => {
    await seedCompanyAndAgent();
    const startedAt = new Date("2026-01-01T00:00:10.000Z");
    const finishedAt = new Date("2026-01-01T00:00:05.000Z");
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "cancelled",
      startedAt,
      finishedAt,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.durationSeconds).toBe(0);
  });

  it("omits model, the three token dimensions, and taskId when each source is absent", async () => {
    await seedCompanyAndAgent({ adapterConfig: {} });
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("model");
    expect(dims).not.toHaveProperty("inputTokens");
    expect(dims).not.toHaveProperty("outputTokens");
    expect(dims).not.toHaveProperty("cachedTokens");
    expect(dims).not.toHaveProperty("taskId");
  });

  it("sends cachedTokens: 0 when usage exists and carries no cached value", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: { inputTokens: 12, outputTokens: 34 },
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.inputTokens).toBe(12);
    expect(dims.outputTokens).toBe(34);
    expect(dims.cachedTokens).toBe(0);
  });

  it("emits with no taskId when contextSnapshot carries no issueId", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: { wakeReason: "issue_commented" },
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("taskId");
  });

  it("passes the raw task identifier to trackAgentTaskRun without hashing it", async () => {
    await seedCompanyAndAgent();
    const rawIssueId = randomUUID();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: { issueId: rawIssueId },
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.taskId).toBe(rawIssueId);
    expect(dims.taskId).not.toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not throw out of the status write when the emit fails", async () => {
    await seedCompanyAndAgent();
    mockTrackAgentTaskRun.mockImplementationOnce(() => {
      throw new Error("telemetry backend unreachable");
    });
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await expect(emitAgentTaskRun(db, run)).resolves.toBeUndefined();
  });

  it("omits adapterType and agentRole when the agent row is absent", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId: randomUUID(),
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("adapterType");
    expect(dims).not.toHaveProperty("agentRole");
  });
});
