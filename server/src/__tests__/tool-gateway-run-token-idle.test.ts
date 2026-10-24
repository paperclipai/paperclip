import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolAccessAuditEvents,
  toolGatewayRateLimitCounters,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import {
  createToolGatewayService,
  HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-run-token-idle-signing-secret";

type Db = ReturnType<typeof createDb>;

const MINUTE_MS = 60_000;

/**
 * A run token used to carry a 60 minute absolute lifetime. The regression this
 * file guards is that a long-running run authenticates shortly before that
 * lifetime ran out and was then locked out two minutes later, because nothing
 * extended the token while the run was still using it.
 */
const LEGACY_RUN_TOKEN_LIFETIME_MS = 60 * MINUTE_MS;

function createClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
  };
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Run token gateway ${randomUUID()}`,
      issuePrefix: `RT${randomUUID().slice(0, 6).toUpperCase()}`,
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

async function createIssueAndRun(db: Db, companyId: string, agentId: string) {
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
      title: `Run token issue ${randomUUID()}`,
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
      status: "running",
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
      profileKey: `run-token-${randomUUID()}`,
      name: `Run token profile ${randomUUID()}`,
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

async function selectAuditRows(
  db: Db,
  companyId: string,
  source: string,
) {
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

describeEmbeddedPostgres("run scoped MCP gateway token idle window", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-token-idle-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps a run token usable past its original expiry once the run uses it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run token gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        clientLabel: "Heartbeat runtime",
        ownerNote: "Idle window regression token",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });

    // First use at t+59 minutes: still inside the original lifetime.
    clock.set(t0 + 59 * MINUTE_MS);
    await expect(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
    ).resolves.toMatchObject({ runId: run.id, agentId: agent.id });

    const afterFirstUse = await selectTokenRow(db, token.id);
    expect(afterFirstUse?.expiresAt?.getTime()).toBe(
      t0 + 59 * MINUTE_MS + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
    );

    // Second use at t+61 minutes, past the original expiry. Before the idle
    // window this was a 401 gateway_token_expired.
    clock.set(t0 + 61 * MINUTE_MS);
    await expect(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
    ).resolves.toMatchObject({ runId: run.id, agentId: agent.id });

    const afterSecondUse = await selectTokenRow(db, token.id);
    expect(afterSecondUse?.expiresAt?.getTime()).toBe(
      t0 + 59 * MINUTE_MS + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
    );
  });

  it("records one refresh audit row per refresh that writes", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run token gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });

    clock.set(t0 + 59 * MINUTE_MS);
    await gateway.initializeNamedGatewayProtocol({
      gatewayId: namedGateway.id,
      bearerToken: token.token,
    });
    const refreshRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.token_refreshed",
    );
    expect(refreshRows).toHaveLength(1);
    expect(refreshRows[0]?.details).toMatchObject({
      subjectType: "heartbeat_run",
      runId: run.id,
      windowMs: HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
      previousExpiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS).toISOString(),
      newExpiresAt: new Date(
        t0 + 59 * MINUTE_MS + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS,
      ).toISOString(),
    });

    // A second use inside the refreshed window must not write again.
    clock.set(t0 + 60 * MINUTE_MS);
    await gateway.initializeNamedGatewayProtocol({
      gatewayId: namedGateway.id,
      bearerToken: token.token,
    });
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(1);
  });

  it("leaves a run token alone while more than half the window remains", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run token gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS),
      },
      actor: { agentId: agent.id },
    });

    clock.set(t0 + MINUTE_MS);
    await gateway.initializeNamedGatewayProtocol({
      gatewayId: namedGateway.id,
      bearerToken: token.token,
    });

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(t0 + HEARTBEAT_RUN_TOKEN_IDLE_WINDOW_MS);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("rejects a revoked run token before any refresh is considered", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run token gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });
    await gateway.revokeNamedGatewayToken({
      companyId: company.id,
      tokenId: token.id,
      revokedAt: new Date(t0),
    });

    clock.set(t0 + 59 * MINUTE_MS);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_revoked",
    );

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("rejects an expired operator token with gateway_token_expired and never refreshes it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Operator gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const expiresAt = t0 - MINUTE_MS;
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Operator token",
        subjectType: "gateway_client",
        subjectId: null,
        clientLabel: "Operator",
        ownerNote: "Operator tokens keep an absolute expiry",
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(expiresAt),
      },
      actor: { agentId: agent.id },
    });

    clock.set(t0);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_expired",
    );

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(expiresAt);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("keeps a reaped run token in the expired class and marks it reaped", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Reaped gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });

    // The reaper deletes a token row once its window lapses.
    await db
      .delete(toolMcpGatewayTokens)
      .where(eq(toolMcpGatewayTokens.id, token.id));

    clock.set(t0 + 61 * MINUTE_MS);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
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
  });

  it("still reports an unknown bearer as gateway_token_invalid", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Unknown bearer gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });

    clock.set(t0);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: `pcgw_${randomUUID()}.unknownsecret`,
      }),
      401,
      "gateway_token_invalid",
    );

    const rejectedRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.session_rejected",
    );
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0]?.details).toMatchObject({
      reasonCode: "gateway_token_invalid",
      reaped: false,
    });
  });

  it("refuses an expired run token whose row is still present", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Expired run token gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const expiresAt = t0 - MINUTE_MS;
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(expiresAt),
      },
      actor: { agentId: agent.id },
    });

    // The idle window is the deadline. A row the reaper has not reached yet
    // must not buy the run another window of access.
    clock.set(t0);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_expired",
    );

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(expiresAt);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("does not extend the token's life when the request is rejected", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Inactive run gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });

    // The run is over, so the request is refused by the run-liveness check.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, run.id));

    // At t+59 minutes less than half the window remains, so a refresh would
    // have written. A rejected request must not extend the token.
    clock.set(t0 + 59 * MINUTE_MS);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_run_inactive",
    );

    const row = await selectTokenRow(db, token.id);
    expect(row?.expiresAt?.getTime()).toBe(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS);
    await expect(
      selectAuditRows(db, company.id, "tool_gateway.token_refreshed"),
    ).resolves.toHaveLength(0);
  });

  it("does not search the audit history for a failure that is already throttled", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createToolGatewayService(db, {
      now: clock.now,
      toolActionSigningSecret: testToolActionSigningSecret,
      mcpGatewayProtocolLimits: {
        authFailures: { windowMs: 5 * MINUTE_MS, max: 1 },
      },
    });
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Throttled gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });

    // The reaper deleted the row, so the token's subject is only knowable
    // from the audit trail.
    await db
      .delete(toolMcpGatewayTokens)
      .where(eq(toolMcpGatewayTokens.id, token.id));

    // First failure: not throttled, so the audit trail is searched and the
    // reaped run token is reported in the expired class.
    clock.set(t0);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      401,
      "gateway_token_expired",
    );

    // Second failure: throttled. The audit trail is not searched, so the
    // throttle row carries the reason code the request arrived with.
    clock.set(t0 + MINUTE_MS);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: token.token,
      }),
      429,
      "gateway_auth_throttled",
    );

    const throttledRows = await db
      .select()
      .from(toolAccessAuditEvents)
      .where(
        and(
          eq(toolAccessAuditEvents.companyId, company.id),
          eq(sql`${toolAccessAuditEvents.details}->>'source'`, "tool_gateway.session_rejected"),
          eq(sql`${toolAccessAuditEvents.details}->>'reasonCode'`, "gateway_auth_throttled"),
        ),
      );
    expect(throttledRows).toHaveLength(1);
    expect(throttledRows[0]?.details).toMatchObject({
      reasonCode: "gateway_auth_throttled",
      failedReasonCode: "gateway_token_invalid",
    });
  });

  it("carries the run id into the rejection audit", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const profile = await createProfile(db, company.id, agent.id);
    const t0 = Date.now();
    const clock = createClock(t0);
    const gateway = createTestToolGatewayService(db, clock.now);
    const namedGateway = await gateway.createNamedGateway({
      companyId: company.id,
      body: {
        name: `Run id gateway ${randomUUID()}`,
        profileId: profile.id,
        defaultProfileMode: "gateway_only",
      },
    });
    const revokedToken = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Revoked run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });
    await gateway.revokeNamedGatewayToken({
      companyId: company.id,
      tokenId: revokedToken.id,
      revokedAt: new Date(t0),
    });

    // The token row is still there, so the run id is known.
    clock.set(t0);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: revokedToken.token,
      }),
      401,
      "gateway_token_revoked",
    );

    const reapedToken = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: namedGateway.id,
      body: {
        name: "Reaped run token",
        subjectType: "heartbeat_run",
        subjectId: run.id,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt: new Date(t0 + LEGACY_RUN_TOKEN_LIFETIME_MS),
      },
      actor: { agentId: agent.id },
    });
    await db
      .delete(toolMcpGatewayTokens)
      .where(eq(toolMcpGatewayTokens.id, reapedToken.id));

    // The token row is gone, so the run id is recovered from the mint audit.
    clock.set(t0 + MINUTE_MS);
    await expectGatewayError(
      gateway.initializeNamedGatewayProtocol({
        gatewayId: namedGateway.id,
        bearerToken: reapedToken.token,
      }),
      401,
      "gateway_token_expired",
    );

    const rejectedRows = await selectAuditRows(
      db,
      company.id,
      "tool_gateway.session_rejected",
    );
    expect(rejectedRows).toHaveLength(2);
    expect(rejectedRows.map((row) => row.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "gateway_token_revoked",
          runId: run.id,
        }),
        expect.objectContaining({
          reasonCode: "gateway_token_expired",
          reaped: true,
          runId: run.id,
        }),
      ]),
    );
  });
});
