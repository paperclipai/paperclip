import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const publishPluginDomainEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/activity-log.js")>();
  return { ...original, publishPluginDomainEvent };
});

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "session-1" },
    sessionDisplayId: "session-1",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat run lifecycle plugin event tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run lifecycle plugin event payload", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "heartbeat-run-lifecycle-plugin-event",
    );
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(() => {
    publishPluginDomainEvent.mockClear();
    adapterExecute.mockClear();
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  });

  it("includes issueTitle and issueDescription in agent.run.started payload when issueId is present", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Hindsight Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Recall Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Add hindsight recall",
      description: "Implement memory recall for agents",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "issue_assigned",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
    });

    expect(run).not.toBeNull();

    await vi.waitFor(
      () => {
        const startedCall = publishPluginDomainEvent.mock.calls.find(
          ([event]: [Record<string, unknown>]) => event.eventType === "agent.run.started",
        );
        expect(startedCall).toBeDefined();
      },
      { timeout: 5_000 },
    );

    const startedCall = publishPluginDomainEvent.mock.calls.find(
      ([event]: [Record<string, unknown>]) => event.eventType === "agent.run.started",
    );
    const payload = (startedCall![0] as Record<string, unknown>).payload as Record<string, unknown>;

    expect(payload.issueId).toBe(issueId);
    expect(payload.issueTitle).toBe("Add hindsight recall");
    expect(payload.issueDescription).toBe("Implement memory recall for agents");
  }, 15_000);

  it("sets issueTitle and issueDescription to null in agent.run.started when no issueId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "On-Demand Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "On-Demand Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
    });

    expect(run).not.toBeNull();

    await vi.waitFor(
      () => {
        const startedCall = publishPluginDomainEvent.mock.calls.find(
          ([event]: [Record<string, unknown>]) => event.eventType === "agent.run.started",
        );
        expect(startedCall).toBeDefined();
      },
      { timeout: 5_000 },
    );

    const startedCall = publishPluginDomainEvent.mock.calls.find(
      ([event]: [Record<string, unknown>]) => event.eventType === "agent.run.started",
    );
    const payload = (startedCall![0] as Record<string, unknown>).payload as Record<string, unknown>;

    expect(payload.issueId).toBeNull();
    expect(payload.issueTitle).toBeNull();
    expect(payload.issueDescription).toBeNull();
  }, 15_000);
});
