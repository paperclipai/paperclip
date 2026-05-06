import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const primaryAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "claude_transient_upstream",
    errorFamily: "transient_upstream" as const,
    retryNotBefore: "2026-04-22T04:00:00.000Z",
    errorMessage: "Claude run failed: subtype=success: You've hit your limit · resets 4am (UTC)",
    resultJson: {
      subtype: "success",
      result: "You've hit your limit · resets 4am (UTC)",
    },
  })),
);

const fallbackAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Fallback finished the task.",
    provider: "ollama",
    model: "qwen3-coder:32b",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
    },
    sessionId: "ollama-session-should-not-persist",
    sessionParams: { sessionId: "ollama-session-should-not-persist" },
    sessionDisplayId: "ollama-session-should-not-persist",
    resultJson: {
      selectedModel: "qwen3-coder:32b",
    },
  })),
);

const cloudflareFallbackAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Cloudflare fallback finished the task.",
    provider: "cloudflare",
    model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    usage: {
      inputTokens: 88,
      outputTokens: 12,
    },
    resultJson: {
      selectedModel: "@cf/qwen/qwen2.5-coder-32b-instruct",
      gatewayId: "ai",
    },
  })),
);

const gatewayFallbackAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "openclaw_gateway_should_not_run",
    errorMessage: "OpenClaw gateway quota fallback should have been normalized to ollama_http.",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  const resolveAdapter = (type: string) => {
    if (type === "claude_local") {
      return {
        supportsLocalAgentJwt: false,
        execute: primaryAdapterExecute,
      };
    }
    if (type === "ollama_http") {
      return {
        supportsLocalAgentJwt: false,
        execute: fallbackAdapterExecute,
      };
    }
    if (type === "cloudflare_workers_ai") {
      return {
        supportsLocalAgentJwt: false,
        execute: cloudflareFallbackAdapterExecute,
      };
    }
    if (type === "openclaw_gateway") {
      return {
        supportsLocalAgentJwt: false,
        execute: gatewayFallbackAdapterExecute,
      };
    }
    return actual.getServerAdapter(type);
  };

  return {
    ...actual,
    getServerAdapter: vi.fn((type: string) => resolveAdapter(type)),
    findActiveServerAdapter: vi.fn((type: string) => {
      if (type === "claude_local" || type === "ollama_http" || type === "cloudflare_workers_ai" || type === "openclaw_gateway") {
        return resolveAdapter(type);
      }
      return actual.findActiveServerAdapter(type);
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat quota fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function waitForRunFinalization(
  db: ReturnType<typeof createDb>,
  runId: string,
  agentId: string,
  expectedRunStatus: "succeeded" | "failed",
  expectedAgentStatus: "idle" | "error",
  timeoutMs = 5_000,
) {
  return waitForCondition(async () => {
    const [run, agent] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    return run?.status === expectedRunStatus && agent?.status === expectedAgentStatus;
  }, timeoutMs);
}

describeEmbeddedPostgres("heartbeat Claude quota fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-quota-fallback-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    primaryAdapterExecute.mockReset();
    fallbackAdapterExecute.mockReset();
    cloudflareFallbackAdapterExecute.mockReset();
    gatewayFallbackAdapterExecute.mockReset();
    primaryAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_transient_upstream",
      errorFamily: "transient_upstream",
      retryNotBefore: "2026-04-22T04:00:00.000Z",
      errorMessage: "Claude run failed: subtype=success: You've hit your limit · resets 4am (UTC)",
      resultJson: {
        subtype: "success",
        result: "You've hit your limit · resets 4am (UTC)",
      },
    }));
    fallbackAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Fallback finished the task.",
      provider: "ollama",
      model: "qwen3-coder:32b",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
      },
      sessionId: "ollama-session-should-not-persist",
      sessionParams: { sessionId: "ollama-session-should-not-persist" },
      sessionDisplayId: "ollama-session-should-not-persist",
      resultJson: {
        selectedModel: "qwen3-coder:32b",
      },
    }));
    cloudflareFallbackAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Cloudflare fallback finished the task.",
      provider: "cloudflare",
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      usage: {
        inputTokens: 88,
        outputTokens: 12,
      },
      resultJson: {
        selectedModel: "@cf/qwen/qwen2.5-coder-32b-instruct",
        gatewayId: "ai",
      },
    }));
    gatewayFallbackAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "openclaw_gateway_should_not_run",
      errorMessage: "OpenClaw gateway quota fallback should have been normalized to ollama_http.",
    }));

    for (const key of [
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ENABLED",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ADAPTER_TYPE",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ADAPTER_CONFIG_JSON",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_BASE_URL",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_URL",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_TAGS_URL",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_MODEL",
      "PAPERCLIP_CLAUDE_QUOTA_FALLBACK_HEADERS_JSON",
    ]) {
      delete process.env[key];
    }

    await db.execute(sql.raw(`
      TRUNCATE TABLE
        heartbeat_run_events,
        activity_log,
        agent_task_sessions,
        finance_events,
        cost_events,
        heartbeat_runs,
        agent_wakeup_requests,
        agent_runtime_state,
        issues,
        agents,
        companies
      CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentFixture(opts?: {
    adapterConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: opts?.adapterConfig ?? {},
      runtimeConfig: opts?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          quotaFallback: {
            enabled: true,
            adapterType: "ollama_http",
            adapterConfig: {
              baseUrl: "https://ollama.example.test",
            },
          },
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Quota fallback issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId };
  }

  it("reroutes Claude quota failures through the configured fallback while preserving the Claude session", async () => {
    const { companyId, agentId, issueId } = await seedAgentFixture();
    const priorRunId = randomUUID();
    const previousSessionId = "claude-session-1";
    const previousRunAt = new Date("2026-04-21T12:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      sessionIdAfter: previousSessionId,
      usageJson: {
        inputTokens: 200,
        rawInputTokens: 200,
        outputTokens: 50,
        rawOutputTokens: 50,
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      finishedAt: previousRunAt,
      updatedAt: previousRunAt,
      createdAt: previousRunAt,
    });

    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      taskKey: issueId,
      sessionParamsJson: {
        sessionId: previousSessionId,
      },
      sessionDisplayId: previousSessionId,
      lastRunId: priorRunId,
      lastError: null,
    });

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "succeeded", "idle")).toBe(true);

    const [run, taskSession] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          sessionIdBefore: heartbeatRuns.sessionIdBefore,
          sessionIdAfter: heartbeatRuns.sessionIdAfter,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRun.id))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          sessionDisplayId: agentTaskSessions.sessionDisplayId,
          sessionParamsJson: agentTaskSessions.sessionParamsJson,
          lastRunId: agentTaskSessions.lastRunId,
        })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.agentId, agentId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(primaryAdapterExecute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapterExecute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapterExecute.mock.calls[0]?.[0]).toMatchObject({
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: issueId,
      },
      config: expect.objectContaining({
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
      }),
    });

    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(run?.sessionIdBefore).toBe(previousSessionId);
    expect(run?.sessionIdAfter).toBe(previousSessionId);
    expect(run?.resultJson).toMatchObject({
      quotaFallback: {
        triggered: true,
        primaryAdapterType: "claude_local",
        fallbackAdapterType: "ollama_http",
        fallbackSucceeded: true,
        fallbackModel: "qwen3-coder:32b",
      },
    });
    expect(run?.usageJson).toMatchObject({
      inputTokens: 100,
      rawInputTokens: 100,
      outputTokens: 20,
      rawOutputTokens: 20,
      provider: "ollama",
      model: "qwen3-coder:32b",
    });
    expect((run?.usageJson as Record<string, unknown> | null)?.usageSource ?? null).toBeNull();

    expect(taskSession).toMatchObject({
      sessionDisplayId: previousSessionId,
      sessionParamsJson: {
        sessionId: previousSessionId,
      },
    });
    expect(taskSession?.lastRunId).toBeTruthy();
    expect(taskSession?.lastRunId).not.toBe(priorRunId);
  });

  it("applies a longer minimum timeout to ollama quota fallback than the primary Claude adapter", async () => {
    const { agentId, issueId } = await seedAgentFixture({
      adapterConfig: {
        timeoutSec: 120,
      },
    });

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "succeeded", "idle")).toBe(true);
    expect(fallbackAdapterExecute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapterExecute.mock.calls[0]?.[0]).toMatchObject({
      config: expect.objectContaining({
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
        timeoutSec: 300,
      }),
    });
  });

  it("clamps an explicitly configured ollama quota fallback timeout when it is set too low", async () => {
    const { agentId, issueId } = await seedAgentFixture({
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          quotaFallback: {
            enabled: true,
            adapterType: "ollama_http",
            adapterConfig: {
              baseUrl: "https://ollama.example.test",
              timeoutMs: 120_000,
            },
          },
        },
      },
    });

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "succeeded", "idle")).toBe(true);
    expect(fallbackAdapterExecute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapterExecute.mock.calls[0]?.[0]).toMatchObject({
      config: expect.objectContaining({
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
        timeoutMs: 300_000,
      }),
    });
  });

  it("normalizes an HTTP-configured openclaw gateway quota fallback to ollama_http", async () => {
    const { agentId, issueId } = await seedAgentFixture({
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          quotaFallback: {
            enabled: true,
            adapterType: "openclaw_gateway",
            url: "https:/ollama-api.example.test",
            tagsUrl: "https://ollama-api.example.test/api/tags",
          },
        },
      },
    });

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "succeeded", "idle")).toBe(true);

    const run = await db
      .select({
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRun.id))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("succeeded");
    expect(gatewayFallbackAdapterExecute).not.toHaveBeenCalled();
    expect(fallbackAdapterExecute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapterExecute.mock.calls[0]?.[0]).toMatchObject({
      config: expect.objectContaining({
        url: "https:/ollama-api.example.test",
        tagsUrl: "https://ollama-api.example.test/api/tags",
        modelPreference: "coding",
      }),
    });
    expect(run?.resultJson).toMatchObject({
      quotaFallback: {
        fallbackAdapterType: "ollama_http",
        fallbackSucceeded: true,
      },
    });
  });

  it("uses generic env adapter config JSON for Cloudflare quota fallback", async () => {
    process.env.PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ENABLED = "true";
    process.env.PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ADAPTER_TYPE = "cloudflare_workers_ai";
    process.env.PAPERCLIP_CLAUDE_QUOTA_FALLBACK_ADAPTER_CONFIG_JSON = JSON.stringify({
      accountId: "acc-123",
      gatewayId: "ai",
      apiToken: "token-123",
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    });

    const { agentId, issueId } = await seedAgentFixture({
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
    });

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "succeeded", "idle")).toBe(true);

    const run = await db
      .select({
        status: heartbeatRuns.status,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRun.id))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("succeeded");
    expect(cloudflareFallbackAdapterExecute).toHaveBeenCalledTimes(1);
    expect(cloudflareFallbackAdapterExecute.mock.calls[0]?.[0]).toMatchObject({
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: issueId,
      },
      config: expect.objectContaining({
        accountId: "acc-123",
        gatewayId: "ai",
        apiToken: "token-123",
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      }),
    });
    expect(
      (cloudflareFallbackAdapterExecute.mock.calls[0]?.[0] as { config?: Record<string, unknown> } | undefined)?.config,
    ).not.toHaveProperty("modelPreference");
    expect(run?.usageJson).toMatchObject({
      inputTokens: 88,
      rawInputTokens: 88,
      outputTokens: 12,
      rawOutputTokens: 12,
      provider: "cloudflare",
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    });
    expect(run?.resultJson).toMatchObject({
      quotaFallback: {
        fallbackAdapterType: "cloudflare_workers_ai",
        fallbackSucceeded: true,
        fallbackModel: "@cf/qwen/qwen2.5-coder-32b-instruct",
      },
    });
  });

  it("does not invoke the fallback on non-quota transient upstream failures", async () => {
    const { agentId, issueId } = await seedAgentFixture();
    primaryAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_transient_upstream",
      errorFamily: "transient_upstream",
      errorMessage: "Claude run failed: service temporarily unavailable",
      resultJson: {
        subtype: "error",
        result: "service temporarily unavailable",
      },
    }));

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(queuedRun).not.toBeNull();
    if (!queuedRun) return;

    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunFinalization(db, queuedRun.id, agentId, "failed", "error")).toBe(true);

    const run = await db
      .select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRun.id))
      .then((rows) => rows[0] ?? null);

    expect(run?.status).toBe("failed");
    expect(fallbackAdapterExecute).not.toHaveBeenCalled();
    expect((run?.resultJson as Record<string, unknown> | null)?.quotaFallback ?? null).toBeNull();
  });
});