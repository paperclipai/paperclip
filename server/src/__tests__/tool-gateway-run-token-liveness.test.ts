import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  projects,
  toolAccessAuditEvents,
  toolGatewayRateLimitCounters,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeMetricCounters,
} from "@paperclipai/db";
import {
  createToolGatewayService,
  GATEWAY_TOKEN_REAP_BATCH_SIZE,
  GATEWAY_TOKEN_REAP_INTERVAL_MS,
  HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-run-token-liveness-signing-secret";

type Db = ReturnType<typeof createDb>;

const MINUTE_MS = 60_000;

/**
 * A run-scoped MCP gateway token's life is the run's life. `expiresAt` on such
 * a token is the idle marker the auth path slides forward while the run keeps
 * working -- it is not a lifetime, and it must never decide whether the token
 * still exists. The reaper that enforces this is independent of the heartbeat
 * scheduler, so it holds with the scheduler off, on a warm standby, and across
 * a restart.
 */
function createClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
  };
}

async function createCompany(db: Db, name = `Run liveness gateway ${randomUUID()}`) {
  return db
    .insert(companies)
    .values({
      name,
      issuePrefix: `RL${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssueAndRun(
  db: Db,
  companyId: string,
  agentId: string,
  runStatus = "running",
) {
  const project = await db
    .insert(projects)
    .values({ companyId, name: `Project ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
  const issue = await db
    .insert(issues)
    .values({
      companyId,
      projectId: project.id,
      title: `Run liveness issue ${randomUUID()}`,
      status: "in_progress",
      assigneeAgentId: agentId,
    })
    .returning()
    .then((rows) => rows[0]!);
  const run = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: runStatus,
      contextSnapshot: { issueId: issue.id, projectId: project.id },
    })
    .returning()
    .then((rows) => rows[0]!);
  return { project, issue, run };
}

async function createProfile(db: Db, companyId: string, agentId: string) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `run-liveness-${randomUUID()}`,
      name: `Run liveness profile ${randomUUID()}`,
      defaultAction: "deny",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
  await db.insert(toolProfileEntries).values({
    companyId,
    profileId: profile.id,
    selectorType: "tool_name",
    effect: "include",
    toolName: "mcp-stdio-fixture:runtime_status",
  });
  return profile;
}

function createTestToolGatewayService(db: Db, now: () => number) {
  return createToolGatewayService(db, {
    now,
    toolActionSigningSecret: testToolActionSigningSecret,
  });
}

async function selectTokenRow(db: Db, tokenId: string) {
  const [row] = await db
    .select()
    .from(toolMcpGatewayTokens)
    .where(eq(toolMcpGatewayTokens.id, tokenId))
    .limit(1);
  return row;
}

async function selectAuditRows(db: Db, companyId: string, source: string) {
  return db
    .select()
    .from(toolAccessAuditEvents)
    .where(
      and(
        eq(toolAccessAuditEvents.companyId, companyId),
        eq(sql`${toolAccessAuditEvents.details}->>'source'`, source),
      ),
    );
}

async function expectGatewayError(
  promise: Promise<unknown>,
  status: number,
  reasonCode: string,
) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ToolGatewayHttpError);
  const gatewayError = error as ToolGatewayHttpError;
  expect(gatewayError.status).toBe(status);
  expect(gatewayError.reasonCode).toBe(reasonCode);
  return gatewayError;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the reaper to collect the token");
}

/**
 * A database whose audit writes fail, so a reaper that deletes before it
 * records can be caught. Every other write behaves normally.
 *
 * `successfulWrites` lets the first N audit writes succeed, so a batch can be
 * rolled back after some of its tokens were already recorded. The observers
 * report when the transaction is active and when the failure counter is
 * written, so a counter that competes for the pool while the transaction
 * still holds its connection can be caught too.
 */
function createAuditFailingDb(
  db: Db,
  options: {
    successfulWrites?: number;
    onMetricCounterWrite?: (inTransaction: boolean) => void;
  } = {},
): Db {
  const successfulWrites = options.successfulWrites ?? 0;
  let auditWrites = 0;
  let inTransaction = false;
  const transaction = db.transaction.bind(db) as (
    callback: (tx: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  const insert = (target: object) => (table: unknown) => {
    if (table === toolAccessAuditEvents) {
      auditWrites += 1;
      if (auditWrites > successfulWrites) {
        return {
          values: () => {
            throw new Error("audit write failed");
          },
        };
      }
    }
    if (table === toolRuntimeMetricCounters) {
      options.onMetricCounterWrite?.(inTransaction);
    }
    const realInsert = Reflect.get(target, "insert", target) as (
      value: unknown,
    ) => unknown;
    return realInsert.call(target, table);
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (callback: (tx: unknown) => Promise<unknown>) => {
          inTransaction = true;
          try {
            return await transaction((tx: unknown) =>
              callback(createAuditFailingTx(tx, insert)),
            );
          } finally {
            inTransaction = false;
          }
        };
      }
      if (prop === "insert") return insert(target);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

function createAuditFailingTx(
  tx: object,
  insert: (target: object) => (table: unknown) => unknown,
): object {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "insert") return insert(target);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describeEmbeddedPostgres("run scoped MCP gateway token liveness reaper", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-token-liveness-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolRuntimeMetricCounters);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(activityLog);
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedGatewayAndToken(input: {
    companyId: string;
    agentId: string;
    runId: string;
    expiresAt: Date;
    subjectType?: "heartbeat_run" | "gateway_client";
  }) {
    const profile = await createProfile(db, input.companyId, input.agentId);
    const gateway = createTestToolGatewayService(db, Date.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: input.companyId,
      body: {
        name: `Run liveness gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: input.companyId,
      gatewayId: namedGateway.id,
      body: {
        name: "Run liveness token",
        subjectType: input.subjectType ?? "heartbeat_run",
        subjectId: input.runId,
        clientLabel: "Heartbeat runtime",
        ownerNote: "Run liveness regression token",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: input.expiresAt,
      },
      actor: { agentId: input.agentId },
    });
    return { gateway, namedGateway, token };
  }

  it("deletes a run token whose run has ended while its marker is still in the future", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    // The run ends. Its token is now an orphan credential, and the marker is
    // still four hours away.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, run.id));

    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();

    const reapRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_reaped",
    );
    expect(reapRows).toHaveLength(1);
    expect(reapRows[0]?.details).toMatchObject({
      decision: "allow",
      reasonCode: "run_token_reaped",
      reapReason: "run_not_active",
      subjectType: "heartbeat_run",
      runId: run.id,
      gatewayTokenId: token.id,
    });
  });

  it("deletes a run token whose run row is gone", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const t0 = Date.now();
    // A run that never persisted. The token outlived its subject, so there is
    // nothing left to authenticate it.
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: randomUUID(),
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();

    const reapRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_reaped",
    );
    expect(reapRows).toHaveLength(1);
    expect(reapRows[0]?.details).toMatchObject({
      reasonCode: "run_token_reaped",
      reapReason: "run_missing",
    });
  });

  it("deletes a run token whose run belongs to another company", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db, `Other ${randomUUID()}`);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, otherCompany.id);
    const { run: otherRun } = await createIssueAndRun(db, otherCompany.id, otherAgent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: otherRun.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    // The run is alive, but it is not this company's run. The token must not
    // keep a foreign run alive, and it must not authenticate against it.
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();

    const reapRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_reaped",
    );
    expect(reapRows).toHaveLength(1);
    expect(reapRows[0]?.details).toMatchObject({
      reapReason: "run_company_mismatch",
    });
  });

  it("keeps a live run's token past its marker and still authenticates it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const { gateway, namedGateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 - MINUTE_MS),
    });
    const testGateway = createTestToolGatewayService(db, clock.now);

    // The marker has passed but the run is still running. The token is not
    // deleted, and it still authenticates.
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 0,
    });
    await expect(selectTokenRow(db, token.id)).resolves.toBeDefined();

    await expect(
      testGateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
    ).resolves.toMatchObject({ runId: run.id, agentId: agent.id });

    // The marker slid forward, because the run is still working.
    const afterUse = await selectTokenRow(db, token.id);
    expect(afterUse?.expiresAt?.getTime()).toBe(
      t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
    );
  });

  it("leaves a live run's token alone when the expiry sweep runs", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, namedGateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 - MINUTE_MS),
    });

    // The expiry sweep is the operator-token reaper. It must not collect a run
    // token whose run is still live -- that is the clause AC2 protects, and
    // the reason the run's liveness is the only boundary.
    await gateway.cleanupExpiredSessions({ now: new Date(t0) });
    await expect(selectTokenRow(db, token.id)).resolves.toBeDefined();

    // An operator token past its expiry is still collected there.
    const operatorToken = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Operator token",
        subjectType: "gateway_client",
        subjectId: null,
        clientLabel: "Operator",
        ownerNote: "Operator tokens keep an absolute expiry",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 - MINUTE_MS),
      },
      actor: { agentId: agent.id },
    });
    await gateway.cleanupExpiredSessions({ now: new Date(t0) });
    await expect(
      selectTokenRow(db, operatorToken.id),
    ).resolves.toBeUndefined();
  });

  it("refuses a token whose run has ended, without extending it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const { namedGateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    const testGateway = createTestToolGatewayService(db, clock.now);

    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, run.id));

    await expectGatewayError(
      testGateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_run_inactive",
    );

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("reaps a run whose controller lease has lapsed, with no scheduler running", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    // The run row still says "running" -- a crashed controller leaves it that
    // way -- but the controller lease has lapsed. That is the only evidence
    // that nobody owns the run any more, and it is what lets the token be
    // reaped without the heartbeat scheduler reclaiming the run first.
    await db
      .update(heartbeatRuns)
      .set({
        controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: new Date(t0 - MINUTE_MS),
      })
      .where(eq(heartbeatRuns.id, run.id));

    await expect(
      gateway.reapGatewayTokensForDeadRuns({ now: new Date(t0) }),
    ).resolves.toEqual({ reapedCount: 1 });
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();

    const reapRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_reaped",
    );
    expect(reapRows).toHaveLength(1);
    expect(reapRows[0]?.details).toMatchObject({
      reapReason: "run_abandoned",
    });
  });

  it("reaps a native run whose coordinator lease has lapsed", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { issue, run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    // A native run holds its coordinator lease on the finalization row, not
    // on the run row.
    await db
      .update(heartbeatRuns)
      .set({ runtimeMode: "native", nativeIssueId: issue.id })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({
      runId: run.id,
      companyId: company.id,
      issueId: issue.id,
      phase: "finalizing",
      leaseOwner: "coordinator",
      leaseExpiresAt: new Date(t0 - MINUTE_MS),
      controllerBootId: randomUUID(),
    });

    await expect(
      gateway.reapGatewayTokensForDeadRuns({ now: new Date(t0) }),
    ).resolves.toEqual({ reapedCount: 1 });
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();

    const reapRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_reaped",
    );
    expect(reapRows).toHaveLength(1);
    expect(reapRows[0]?.details).toMatchObject({
      reapReason: "run_abandoned",
    });
  });

  it("keeps a run whose controller lease is still valid", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    await db
      .update(heartbeatRuns)
      .set({
        controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: new Date(t0 + 60 * MINUTE_MS),
      })
      .where(eq(heartbeatRuns.id, run.id));

    await expect(
      gateway.reapGatewayTokensForDeadRuns({ now: new Date(t0) }),
    ).resolves.toEqual({ reapedCount: 0 });
    await expect(selectTokenRow(db, token.id)).resolves.toBeDefined();
  });

  it("reports no outstanding run tokens once the reaper has collected them", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    await expect(gateway.hasOutstandingGatewayRunTokens()).resolves.toBe(true);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, run.id));
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });

    // The sweep stops scanning once no run-scoped token is left, so it never
    // burns a tick on empty work.
    await expect(gateway.hasOutstandingGatewayRunTokens()).resolves.toBe(false);
    await expect(selectTokenRow(db, token.id)).resolves.toBeUndefined();
  });

  it("leaves an operator token's absolute expiry alone", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const t0 = Date.now();
    const { gateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: null as unknown as string,
      subjectType: "gateway_client",
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });

    // An operator token is not a run token. It keeps its absolute expiry, and
    // the liveness reaper does not touch it.
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 0,
    });
    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_reaped"),
    ).resolves.toHaveLength(0);
  });

  it("distinguishes a reaped token from an expired one in the audit trail", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const { gateway, namedGateway, token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    const testGateway = createTestToolGatewayService(db, clock.now);

    // The run ends and the token is reaped.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, run.id));
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });

    // The reaped token's bearer now finds no row, and is reported in the same
    // class as an expired token, distinguished by the `reaped` flag.
    clock.set(t0);
    await expectGatewayError(
      testGateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_expired",
    );

    const rejectedRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.session_rejected",
    );
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0]?.details).toMatchObject({
      reasonCode: "gateway_token_expired",
      reaped: true,
    });

    // An operator token past its expiry is the same class, not the reaped one.
    const operatorToken = await testGateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Operator token",
        subjectType: "gateway_client",
        subjectId: null,
        clientLabel: "Operator",
        ownerNote: "Operator tokens keep an absolute expiry",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 - MINUTE_MS),
      },
      actor: { agentId: agent.id },
    });
    await expectGatewayError(
      testGateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: operatorToken.token,
      }),
      401,
      "gateway_token_expired",
    );

    const allRejectedRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.session_rejected",
    );
    expect(allRejectedRows).toHaveLength(2);
    // One queryable class: every one of them is `gateway_token_expired`, and
    // the flag is what separates the reaped one from the expired one.
    expect(
      allRejectedRows.map((row) => row.details?.reasonCode),
    ).toEqual(["gateway_token_expired", "gateway_token_expired"]);
    expect(
      allRejectedRows.map((row) => row.details?.reaped).sort(),
    ).toEqual([false, true]);
  });

  it("reaps a dead run token that sits behind more live tokens than one batch holds", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const t0 = Date.now();
    const profile = await createProfile(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, Date.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run liveness gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });

    // More live run tokens than one collection batch holds, every one of them
    // created before the dead one. A sweep that capped its read would keep
    // re-reading exactly these rows and never reach the dead token behind
    // them, so the dead token would never be collected at all.
    const liveRuns = await db
      .insert(heartbeatRuns)
      .values(
        Array.from({ length: GATEWAY_TOKEN_REAP_BATCH_SIZE + 1 }, () => ({
          companyId: company.id,
          agentId: agent.id,
          invocationSource: "assignment",
          status: "running",
        })),
      )
      .returning({ id: heartbeatRuns.id });
    const [deadRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        status: "succeeded",
        finishedAt: new Date(t0),
      })
      .returning({ id: heartbeatRuns.id });
    const deadTokenId = randomUUID();

    const liveTokenValues: (typeof toolMcpGatewayTokens.$inferInsert)[] =
      liveRuns.map((run) => ({
        companyId: company.id,
        gatewayId: namedGateway.id,
        name: `Live run token ${run.id}`,
        tokenHash: `live-${run.id}`,
        tokenPrefix: `pcgw_${run.id.slice(0, 8)}`,
        subjectType: "heartbeat_run",
        subjectId: run.id,
        clientLabel: "Heartbeat runtime",
        ownerNote: "Live run token",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
        createdAt: new Date(t0),
        updatedAt: new Date(t0),
      }));
    const deadTokenValues: (typeof toolMcpGatewayTokens.$inferInsert)[] = [
      {
        id: deadTokenId,
        companyId: company.id,
        gatewayId: namedGateway.id,
        name: "Dead run token",
        tokenHash: `dead-${deadRun!.id}`,
        tokenPrefix: `pcgw_${deadRun!.id.slice(0, 8)}`,
        subjectType: "heartbeat_run",
        subjectId: deadRun!.id,
        clientLabel: "Heartbeat runtime",
        ownerNote: "Dead run token",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
        createdAt: new Date(t0 + 1_000),
        updatedAt: new Date(t0 + 1_000),
      },
    ];
    await db
      .insert(toolMcpGatewayTokens)
      .values([...liveTokenValues, ...deadTokenValues]);

    // The dead token is collected even though it sits behind more live tokens
    // than one batch holds.
    await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
      reapedCount: 1,
    });
    await expect(selectTokenRow(db, deadTokenId)).resolves.toBeUndefined();

    const remaining = await db
      .select({ id: toolMcpGatewayTokens.id })
      .from(toolMcpGatewayTokens)
      .where(eq(toolMcpGatewayTokens.subjectType, "heartbeat_run"));
    expect(remaining).toHaveLength(GATEWAY_TOKEN_REAP_BATCH_SIZE + 1);
  });

  it("leaves the token in place when the audit record cannot be written", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, run.id));

    const failingGateway = createToolGatewayService(createAuditFailingDb(db), {
      now: Date.now,
      toolActionSigningSecret: testToolActionSigningSecret,
    });

    // The record and the deletion commit together. A token is never removed
    // without the record that says why, so a record that cannot be written
    // leaves the token in place and the next sweep collects it with its
    // record intact.
    await expect(failingGateway.reapGatewayTokensForDeadRuns()).rejects.toThrow(
      /audit write failed/,
    );
    await expect(selectTokenRow(db, token.id)).resolves.toBeDefined();
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_reaped"),
    ).resolves.toHaveLength(0);
  });

  it("counts an audit write failure only after the transaction released its connection", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const t0 = Date.now();
    const { token } = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, run.id));

    let counterWrites = 0;
    let counterWritesInTransaction = 0;
    const failingGateway = createToolGatewayService(
      createAuditFailingDb(db, {
        onMetricCounterWrite: (inTransaction) => {
          counterWrites += 1;
          if (inTransaction) counterWritesInTransaction += 1;
        },
      }),
      { now: Date.now, toolActionSigningSecret: testToolActionSigningSecret },
    );

    await expect(failingGateway.reapGatewayTokensForDeadRuns()).rejects.toThrow(
      /audit write failed/,
    );

    // The failure was counted, and it was counted once the transaction had
    // released its connection. Counting it inside the transaction would wait
    // for a connection the transaction itself holds, and the transaction
    // could not roll back while the count waited.
    expect(counterWrites).toBeGreaterThan(0);
    expect(counterWritesInTransaction).toBe(0);
    await expect(selectTokenRow(db, token.id)).resolves.toBeDefined();
  });

  it("publishes the reaped activity only after the batch commits", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const t0 = Date.now();
    const first = await createIssueAndRun(db, company.id, agent.id);
    const second = await createIssueAndRun(db, company.id, agent.id);
    const firstToken = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: first.run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    const secondToken = await seedGatewayAndToken({
      companyId: company.id,
      agentId: agent.id,
      runId: second.run.id,
      expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, first.run.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(t0) })
      .where(eq(heartbeatRuns.id, second.run.id));

    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(company.id, (event) => {
      if (event.type !== "activity.logged") return;
      const payload = event.payload as { action?: string } | undefined;
      if (payload?.action === "tool_gateway.token_reaped") {
        published.push(payload.action);
      }
    });
    try {
      // The second token's record cannot be written, so the whole batch rolls
      // back. Nothing was reaped, so nothing may have been published: a
      // publication sent before the commit reports a deletion that the
      // rollback takes back.
      const failingGateway = createToolGatewayService(
        createAuditFailingDb(db, { successfulWrites: 1 }),
        { now: Date.now, toolActionSigningSecret: testToolActionSigningSecret },
      );
      await expect(failingGateway.reapGatewayTokensForDeadRuns()).rejects.toThrow(
        /audit write failed/,
      );
      expect(published).toHaveLength(0);
      await expect(
        selectTokenRow(db, firstToken.token.id),
      ).resolves.toBeDefined();
      await expect(
        selectTokenRow(db, secondToken.token.id),
      ).resolves.toBeDefined();

      // A batch that commits publishes, and it publishes once per token.
      const gateway = createTestToolGatewayService(db, Date.now);
      await expect(gateway.reapGatewayTokensForDeadRuns()).resolves.toEqual({
        reapedCount: 2,
      });
      expect(published).toHaveLength(2);
      await expect(
        selectTokenRow(db, firstToken.token.id),
      ).resolves.toBeUndefined();
      await expect(
        selectTokenRow(db, secondToken.token.id),
      ).resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it("wakes the reaper when a run token is minted after the queue went empty", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id, "succeeded");
    const t0 = Date.now();
    const profile = await createProfile(db, company.id, agent.id);
    const gateway = createTestToolGatewayService(db, Date.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run liveness gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });

    const coordinator = createDeliveryWorkCoordinator({
      owner: db,
      canRun: () => true,
      canReconcile: () => true,
      onError: () => {},
    });
    let runs = 0;
    const delivery = coordinator.register(DELIVERY_QUEUES.gatewayRunTokens, {
      retryMs: GATEWAY_TOKEN_REAP_INTERVAL_MS,
      run: async () => {
        runs += 1;
        return gateway.reapGatewayTokensForDeadRuns();
      },
      hasPending: () => gateway.hasOutstandingGatewayRunTokens(),
      runDuringDrain: true,
    });
    try {
      await delivery.ready;
      // The queue holds nothing, so the duty has gone quiet.
      expect(runs).toBe(1);

      // A run token minted now is work the reaper has to notice. The mint
      // registers that intent on its own transaction, so the quiet duty wakes
      // up for it instead of waiting for its next poll.
      const token = await gateway.createNamedGatewayToken({
        companyId: company.id,
        gatewayId: namedGateway.id,
        body: {
          name: "Late run token",
          subjectType: "heartbeat_run",
          subjectId: run.id,
          clientLabel: "Heartbeat runtime",
          ownerNote: "Minted after the reaper went quiet",
          allowedActions: ["tools/list", "tools/call"],
          expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
        },
        actor: { agentId: agent.id },
      });

      await waitFor(async () => (await selectTokenRow(db, token.id)) === undefined);
      expect(runs).toBeGreaterThan(1);
    } finally {
      await coordinator.stop();
    }
  });

  it("runs the reaper's duty on a warm standby", async () => {
    // A warm standby holds every duty back, because the work belongs to the
    // instance that owns it. A leftover credential is not that instance's to
    // keep, so the duty that collects it says so, and every other duty stays
    // held back.
    const coordinator = createDeliveryWorkCoordinator({
      owner: db,
      canRun: () => false,
      canReconcile: () => false,
      onError: () => {},
    });
    let standbyRuns = 0;
    let heldRuns = 0;
    try {
      const standby = coordinator.register(DELIVERY_QUEUES.gatewayRunTokens, {
        retryMs: GATEWAY_TOKEN_REAP_INTERVAL_MS,
        run: async () => {
          standbyRuns += 1;
          return { reapedCount: 0 };
        },
        hasPending: async () => false,
        runDuringDrain: true,
        runOnStandby: true,
      });
      await standby.ready;
      expect(standbyRuns).toBe(1);

      const held = coordinator.register(DELIVERY_QUEUES.toolAction, {
        retryMs: GATEWAY_TOKEN_REAP_INTERVAL_MS,
        run: async () => {
          heldRuns += 1;
          return { reapedCount: 0 };
        },
        hasPending: async () => false,
        runDuringDrain: true,
      });
      await held.ready;
      expect(heldRuns).toBe(0);
    } finally {
      await coordinator.stop();
    }
  });

  it("runs the run-token reaper on the shared delivery coordinator, not on the heartbeat scheduler", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");

    // The reaper is a duty on the shared coordinator. The heartbeat scheduler
    // is off on a standby instance and can be turned off, and neither may
    // leave a finished run's token in place, so the duty is registered on the
    // coordinator and gated on neither the scheduler nor the standby
    // predicate.
    const registerStart = source.indexOf(
      "deliveryWork.register(DELIVERY_QUEUES.gatewayRunTokens",
    );
    expect(registerStart).toBeGreaterThan(-1);
    const registerBlock = source.slice(
      registerStart,
      source.indexOf("});", registerStart),
    );
    expect(registerBlock).toContain("reapGatewayTokensForDeadRuns");
    expect(registerBlock).toContain("hasOutstandingGatewayRunTokens");
    // The standby holds the duty back like every other duty, except for this
    // one: a credential left behind by a run that ended is not the standby's
    // to keep.
    expect(registerBlock).toContain("runOnStandby: true");
    expect(registerBlock).not.toContain("isWarmStandby");
    expect(registerBlock).not.toContain("heartbeatSchedulerEnabled");
    expect(registerBlock).not.toContain("heartbeatSchedulerStopped");
  });

  it("reconstructs the reaper's state at startup", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

    // The sweep also runs at startup, so a run that died with the server is
    // collected in the same startup instead of waiting for the marker to pass.
    expect(source).toContain('timeStartupRecovery("gateway_run_tokens"');
  });
});
