import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.ts";
import { RUN_LOG_CREDENTIAL_REDACTION_TOKEN } from "../log-redaction.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockWorkspaceRuntime = vi.hoisted(() => ({
  setupFailureMessage: null as string | null,
}));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../services/workspace-runtime.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/workspace-runtime.js");
  return {
    ...actual,
    realizeExecutionWorkspace: async (...args: unknown[]) => {
      if (mockWorkspaceRuntime.setupFailureMessage) {
        throw new Error(mockWorkspaceRuntime.setupFailureMessage);
      }
      return (actual.realizeExecutionWorkspace as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "redaction_test_adapter";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat redaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describeEmbeddedPostgres("heartbeat redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-redaction-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockWorkspaceRuntime.setupFailureMessage = null;
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  it("redacts adapter failure credentials in agent runtime state while preserving usage accounting", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const fakeApiKey = "fake-runtime-key-value";
    const fakeBearer = "fake-runtime-bearer-value";
    const fakeJwt = "fakehead1.fakepayload2.fakesignature-";
    const fakeErrorMessage =
      `adapter failed PAPERCLIP_API_KEY=${fakeApiKey} Authorization: Bearer ${fakeBearer} ${fakeJwt}`;

    const adapter: ServerAdapterModule = {
      type: TEST_ADAPTER_TYPE,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: fakeErrorMessage,
        errorCode: "redaction_test_failure",
        provider: "redaction-test-provider",
        biller: "redaction-test-biller",
        model: "redaction-test-model",
        billingType: "metered_api",
        costUsd: 1.23,
        usage: {
          inputTokens: 11,
          cachedInputTokens: 5,
          outputTokens: 7,
        },
      }),
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    };
    registerServerAdapter(adapter);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Redaction Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "redaction_test",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    expect(run).not.toBeNull();

    await waitFor(async () => {
      const state = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      return state?.lastRunStatus === "failed";
    });

    const state = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(state?.lastError).toContain(`PAPERCLIP_API_KEY=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    expect(state?.lastError).toContain(`Authorization: Bearer ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
    expect(state?.lastError).not.toContain(fakeApiKey);
    expect(state?.lastError).not.toContain(fakeBearer);
    expect(state?.lastError).not.toContain(fakeJwt);
    expect(state?.totalInputTokens).toBe(11);
    expect(state?.totalCachedInputTokens).toBe(5);
    expect(state?.totalOutputTokens).toBe(7);
    expect(state?.totalCostCents).toBe(123);

    const runRow = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(runRow?.error).toEqual(state?.lastError);

    const costEvent = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(costEvent).toMatchObject({
      provider: "redaction-test-provider",
      biller: "redaction-test-biller",
      billingType: "metered_api",
      model: "redaction-test-model",
      inputTokens: 11,
      cachedInputTokens: 5,
      outputTokens: 7,
      costCents: 123,
    });
  });

  it("redacts setup failure credentials in run status, wakeup status, and timeline events", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const fakeApiKey = "fake-setup-key-value";
    const fakeBearer = "fake-setup-bearer-value";
    const fakeJwt = "fakehead1.fakepayload2.fakesetupsig-";
    const fakeErrorMessage =
      `setup failed PAPERCLIP_API_KEY=${fakeApiKey} Authorization: Bearer ${fakeBearer} ${fakeJwt}`;
    mockWorkspaceRuntime.setupFailureMessage = fakeErrorMessage;

    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    const adapter: ServerAdapterModule = {
      type: TEST_ADAPTER_TYPE,
      execute,
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    };
    registerServerAdapter(adapter);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Setup Failure Agent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "setup_redaction_test",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    expect(run).not.toBeNull();

    await waitFor(async () => {
      const runRow = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);
      return runRow?.status === "failed";
    });

    const runRow = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, run!.id))
      .then((rows) => rows[0] ?? null);
    const event = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run!.id))
      .then((rows) => rows.find((row) => row.eventType === "error") ?? null);

    for (const persistedMessage of [runRow?.error, wakeup?.error, event?.message]) {
      expect(persistedMessage).toContain(`PAPERCLIP_API_KEY=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
      expect(persistedMessage).toContain(`Authorization: Bearer ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
      expect(persistedMessage).not.toContain(fakeApiKey);
      expect(persistedMessage).not.toContain(fakeBearer);
      expect(persistedMessage).not.toContain(fakeJwt);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
