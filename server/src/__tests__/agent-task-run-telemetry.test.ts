import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { scopedTelemetryCompanyId, scopedTelemetryPerson } from "../telemetry-company-scope.js";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { PAPERCLIP_ENUM_DESCRIPTIONS } from "@paperclipai/shared/telemetry";
import { PAPERCLIP_RUNNER_ACPX_PROFILES, PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES } from "@paperclipai/adapter-utils";
import { PERMANENT_FAILURE_CODES, PERSON_OWNED_FAILURE_CODES, RESTART_CLASS_FAILURE_CODES, SETUP_FAILURE_CODES } from "../services/continuation-cause.ts";

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

import { agentRunFailureCause, emitAgentTaskRun, emitAgentTaskRunById, telemetryAdapterType } from "../services/agent-task-run-telemetry.ts";

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
    await db.delete(issues);
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

  it("tracks agent.task_run in the run's company scope", async () => {
    await seedCompanyAndAgent();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();
    const scopedCompanies: Array<string | undefined> = [];
    const recordScope = () => scopedCompanies.push(scopedTelemetryCompanyId());
    mockTrackAgentTaskRun.mockImplementationOnce(recordScope).mockImplementationOnce(recordScope);

    await emitAgentTaskRun(db, run);
    await emitAgentTaskRunById(db, { runId: run.id, companyId });

    expect(scopedCompanies).toEqual([companyId, companyId]);
    expect(scopedTelemetryCompanyId()).toBeUndefined();
  });

  it.each([
    { name: "task creator", issue: { createdByUserId: "user-creator", responsibleUserId: "user-assigner" }, runOwner: "user-owner", expected: { userId: "user-creator", attributedVia: "task_creator" } },
    { name: "task assigner", issue: { createdByUserId: null, responsibleUserId: "user-assigner" }, runOwner: "user-owner", expected: { userId: "user-assigner", attributedVia: "task_assigner" } },
    { name: "run owner", issue: { createdByUserId: null, responsibleUserId: null }, runOwner: "user-owner", expected: { userId: "user-owner", attributedVia: "run_owner" } },
    { name: "nobody", issue: { createdByUserId: null, responsibleUserId: null }, runOwner: null, expected: undefined },
  ])("tracks agent.task_run for the person responsible: $name", async ({ issue, runOwner, expected }) => {
    await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the report", assigneeAgentId: agentId, createdByAgentId: issue.createdByUserId ? null : agentId, ...issue });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
      responsibleUserId: runOwner, contextSnapshot: { issueId } }).returning();
    const people: unknown[] = [];
    const recordPerson = () => people.push(scopedTelemetryPerson());
    mockTrackAgentTaskRun.mockImplementationOnce(recordPerson).mockImplementationOnce(recordPerson);

    await emitAgentTaskRun(db, run);
    await emitAgentTaskRunById(db, { runId: run.id, companyId });

    expect(people).toEqual([expected, expected]);
    expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(mockTelemetryClient, expect.objectContaining({ taskId: issueId }));
  });

  it("does not read another company's task for attribution", async () => {
    await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: otherCompanyId, title: "Other task", createdByUserId: "user-other" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } }).returning();
    const people: unknown[] = [];
    mockTrackAgentTaskRun.mockImplementationOnce(() => people.push(scopedTelemetryPerson()));

    await emitAgentTaskRun(db, run);

    expect(people).toEqual([undefined]);
    await db.delete(issues);
    await db.delete(companies).where(eq(companies.id, otherCompanyId));
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

  it.each([
    { adapterConfig: {}, adapterType: "codex_local" },
    { adapterConfig: { provider: "acpx", acpxAgent: "claude" }, adapterType: "claude_local" },
    { adapterConfig: { provider: "opencode" }, adapterType: "opencode_local" },
  ])("reports a Paperclip runner agent's underlying harness $adapterType as adapterType", async ({ adapterConfig, adapterType }) => {
    await seedCompanyAndAgent({ adapterType: "paperclip_runner", adapterConfig });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();

    await emitAgentTaskRun(db, run);

    expect(mockTrackAgentTaskRun.mock.calls[0][1].adapterType).toBe(adapterType);
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

  it("sends a fixed failure_cause from the stored error code and provider category for failed runs", async () => {
    await seedCompanyAndAgent();
    const [quota] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", errorCode: "adapter_failed",
      error: "provider said: secret detail", resultJson: { providerFailure: { category: "rate_limit", message: "secret detail" } } }).returning();
    const [lost] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "interrupted", errorCode: "process_lost" }).returning();
    const [done] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", errorCode: null }).returning();

    await emitAgentTaskRun(db, quota);
    await emitAgentTaskRunById(db, { companyId, runId: lost.id });
    await emitAgentTaskRun(db, done);

    const sent = mockTrackAgentTaskRun.mock.calls.map((call) => call[1]);
    expect(sent[0].failureCause).toBe("provider_limit");
    expect(sent[1].failureCause).toBe("platform_error");
    expect(sent[2]).not.toHaveProperty("failureCause");
    expect(JSON.stringify(sent)).not.toContain("secret detail");
  });
});

describe("agentRunFailureCause", () => {
  it.each([
    [{ errorCode: "provider_auth_failed", providerFailureCategory: null }, "missing_access"],
    [{ errorCode: "adapter_failed", providerFailureCategory: "authentication" }, "missing_access"],
    [{ errorCode: "provider_quota", providerFailureCategory: null }, "provider_limit"],
    [{ errorCode: "adapter_failed", providerFailureCategory: "overloaded" }, "provider_limit"],
    [{ errorCode: "native_provider_model_rejected", providerFailureCategory: null }, "provider_error"],
    [{ errorCode: "adapter_failed", providerFailureCategory: "model_unavailable" }, "provider_error"],
    [{ errorCode: "provider_transport_failed", providerFailureCategory: "rate_limit" }, "provider_error"],
    [{ errorCode: "native_provider_usage_limit", providerFailureCategory: "authentication" }, "provider_limit"],
    [{ errorCode: "budget_hard_stop", providerFailureCategory: null }, "waiting_for_person"],
    [{ errorCode: "agent_not_invokable", providerFailureCategory: null }, "platform_error"],
    [{ errorCode: "execution_reconciliation_required", providerFailureCategory: null }, "waiting_for_person"],
    [{ errorCode: "native_session_cleanup_quarantined", providerFailureCategory: null }, "waiting_for_person"],
    [{ errorCode: "issue_reassigned", providerFailureCategory: null }, "task_changed"],
    [{ errorCode: "operator_interrupted", providerFailureCategory: null }, "task_changed"],
    [{ errorCode: "process_lost", providerFailureCategory: null }, "platform_error"],
    [{ errorCode: "setup_failed", providerFailureCategory: "rate_limit" }, "platform_error"],
    [{ errorCode: "adapter_failed", providerFailureCategory: null }, "agent_error"],
    [{ errorCode: "timeout", providerFailureCategory: null }, "agent_error"],
    [{ errorCode: "some_future_code", providerFailureCategory: null }, "unknown"],
    [{ errorCode: null, providerFailureCategory: null }, "unknown"],
  ] as const)("maps %o to %s", (input, expected) => {
    expect(agentRunFailureCause(input)).toBe(expected);
  });

  it("classifies every canonical run failure code", () => {
    const canonical = [
      ...PERSON_OWNED_FAILURE_CODES,
      ...PERMANENT_FAILURE_CODES,
      ...RESTART_CLASS_FAILURE_CODES,
      ...SETUP_FAILURE_CODES,
      ...EXECUTION_RECONCILIATION_CAUSES,
    ];
    const unclassified = canonical.filter((errorCode) =>
      agentRunFailureCause({ errorCode, providerFailureCategory: null }) === "unknown");
    expect(unclassified).toEqual([]);
  });
});

describe("Paperclip runner adapter_type coverage", () => {
  it.each(["agent.task_run", "agent.task_completed"] as const)("lists every runner harness in the %s adapter_type contract except the known gaps", (event) => {
    const contract = Object.keys(PAPERCLIP_ENUM_DESCRIPTIONS[event].adapter_type);
    const harnesses = [
      ...Object.keys(PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES)
        .filter((provider) => provider !== "acpx")
        .map((provider) => telemetryAdapterType({ adapterType: "paperclip_runner", adapterConfig: { provider } })),
      ...PAPERCLIP_RUNNER_ACPX_PROFILES.map(({ value }) => telemetryAdapterType({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: value } })),
    ];

    expect(harnesses.filter((harness) => !contract.includes(harness)).sort()).toEqual([
      "acpx:copilot",
      "antigravity_runtime",
      "aws_agentcore",
      "claude_managed",
      "grok_bot",
      "muse",
      "openai_dot",
    ]);
  });
});
