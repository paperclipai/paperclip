import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Proposal wrappers drop unregistered names inside the real client, so the
// integration assertions use a client double that reports the proposed event
// as registered. `track` observes exactly what the emitter would hand the
// real client after schema adoption.
const track = vi.fn();
const isRegisteredEventName = vi.fn(() => true);
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track, isRegisteredEventName }),
}));

// Deterministic reproduction of "post-execution bookkeeping failure": the
// gateway's success path awaits writeAudit -> logActivity after the succeeded
// save; failing that call lands in the catch that overwrites the row to
// failed.
const failLogActivityForAction = { current: null as string | null };
vi.mock("../services/activity-log.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/activity-log.js")>();
  return {
    ...actual,
    logActivity: vi.fn(
      async (...args: Parameters<typeof actual.logActivity>) => {
        const input = args[1] as { action?: string };
        if (
          failLogActivityForAction.current &&
          input?.action === failLogActivityForAction.current
        ) {
          throw new Error(`forced activity write failure: ${input.action}`);
        }
        return actual.logActivity(...args);
      },
    ),
  };
});

const { createToolGatewayService } = await import(
  "../services/tool-gateway.js"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type Db = ReturnType<typeof createDb>;

const SIGNING_SECRET = "connector-telemetry-signing-secret";

function mcpSuccessResponse(init: RequestInit): Response {
  const body = JSON.parse(String(init.body ?? "{}"));
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: body?.id ?? "fixture",
      result: { content: [{ type: "text", text: "ok" }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Connector telemetry ${randomUUID()}`,
      issuePrefix: `CT${randomUUID().slice(0, 6).toUpperCase()}`,
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
      permissions: {},
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
      title: `Telemetry issue ${randomUUID()}`,
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
  return { issue, run };
}

async function allowAllToolsForAgent(db: Db, companyId: string, agentId: string) {
  const profile = await db
    .insert(toolProfiles)
    .values({
      companyId,
      profileKey: `telemetry-all-${randomUUID()}`,
      name: `Telemetry profile ${randomUUID()}`,
      defaultAction: "allow",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(toolProfileBindings).values({
    companyId,
    profileId: profile.id,
    targetType: "agent",
    targetId: agentId,
  });
}

async function createRemoteMcpTool(db: Db, companyId: string) {
  const [application] = await db
    .insert(toolApplications)
    .values({
      companyId,
      applicationKey: `telemetry-app-${randomUUID().slice(0, 8)}`,
      name: `Remote app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    })
    .returning();
  const config = {
    url: "https://mcp.telemetry.test/mcp",
    sourceTemplateKey: "github",
  };
  const [connection] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: `Remote connection ${randomUUID()}`,
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config,
      transportConfig: config,
      credentialRefs: [],
      credentialSecretRefs: [],
    })
    .returning();
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection!.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  const [catalogEntry] = await db
    .insert(toolCatalogEntries)
    .values({
      companyId,
      applicationId: application!.id,
      connectionId: connection!.id,
      entryKind: "tool",
      name: `kv_set-${randomUUID()}`,
      toolName: "kv_set",
      title: "KV Set",
      description: "Set a value",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      riskLevel: "write",
      isReadOnly: false,
      isWrite: true,
      isDestructive: false,
      status: "active",
      versionHash: randomUUID(),
    })
    .returning();
  return { application: application!, connection: connection!, catalogEntry: catalogEntry! };
}

async function settledEvents(expectedCount: number) {
  await vi.waitFor(() => {
    expect(
      track.mock.calls.filter(
        ([name]) => name === "connection.invoked",
      ).length,
    ).toBeGreaterThanOrEqual(expectedCount);
  });
  // The emitter runs as detached background work; give any surplus emission a
  // chance to land before asserting the exact count.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return track.mock.calls.filter(
    ([name]) => name === "connection.invoked",
  );
}

describeEmbeddedPostgres("gateway connector invocation telemetry", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-connector-telemetry-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    track.mockClear();
    failLogActivityForAction.current = null;
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture(options: Parameters<typeof createToolGatewayService>[1] = {}) {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const { run } = await createIssueAndRun(db, company.id, agent.id);
    const remoteTool = await createRemoteMcpTool(db, company.id);
    await allowAllToolsForAgent(db, company.id, agent.id);
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: SIGNING_SECRET,
      remoteHttpRequest: async (_url, init) => mcpSuccessResponse(init),
      ...options,
    });
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
    });
    const tool = (await gateway.listToolsForSession(session.token)).find(
      (candidate) => candidate.connectionId === remoteTool.connection.id,
    );
    expect(tool).toBeDefined();
    return { company, agent, run, remoteTool, gateway, session, tool: tool! };
  }

  it("emits exactly one succeeded event for a successful agent execution", async () => {
    const f = await fixture();
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
      }),
    ).resolves.toMatchObject({ status: "completed" });

    const events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      connector_key: "github",
      transport: "mcp_remote",
      status: "succeeded",
      origin: "agent",
    });
  }, 30_000);

  it("emits a single failed event when post-success audit work throws (no contradictory pair)", async () => {
    const f = await fixture();
    failLogActivityForAction.current = "tool_gateway.call_completed";

    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
      }),
    ).rejects.toThrow(/forced activity write failure/);

    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation?.status).toBe("failed");

    const events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ status: "failed", origin: "agent" });
    expect(
      events.some(([, dims]) => (dims as { status: string }).status === "succeeded"),
    ).toBe(false);
  }, 30_000);

  it("emits one failed event when the remote execution itself fails", async () => {
    const f = await fixture({
      remoteHttpRequest: async () =>
        new Response("upstream exploded", { status: 500 }),
    });
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
      }),
    ).rejects.toThrow();

    const events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ status: "failed" });
  }, 30_000);

  it("emits one denied event for a policy block and one rate_limited event past the limit", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Block telemetry tool",
      policyType: "block",
      selectors: { connectionId: f.remoteTool.connection.id },
      priority: 1,
    });
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
      }),
    ).rejects.toMatchObject({ reasonCode: expect.any(String) });

    let events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ status: "denied", origin: "agent" });

    track.mockClear();
    await db.delete(toolPolicies);
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "One call only",
      policyType: "rate_limit",
      selectors: { connectionId: f.remoteTool.connection.id },
      config: { limit: 1, windowSeconds: 60 },
      priority: 1,
    });
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "rate", value: "first" },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "rate", value: "second" },
      }),
    ).rejects.toMatchObject({ status: 429 });

    events = await settledEvents(2);
    expect(events).toHaveLength(2);
    expect(events.map(([, dims]) => (dims as { status: string }).status).sort()).toEqual(
      ["rate_limited", "succeeded"],
    );
  }, 30_000);

  it("approval flow: pending emits nothing, decline emits denied, approve emits succeeded", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Review telemetry tool",
      policyType: "require_approval",
      selectors: { connectionId: f.remoteTool.connection.id },
      priority: 1,
    });

    await f.gateway
      .executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "declined" },
      })
      .then(
        () => {
          throw new Error("expected approval_required");
        },
        (error) => expect(error).toMatchObject({ reasonCode: "approval_required" }),
      );
    // Awaiting approval is in-flight: no completion event may exist yet. The
    // approval card itself emits the registered interaction.created event, so
    // filter to the proposed connector event.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      track.mock.calls.filter(([name]) => name === "connection.invoked"),
    ).toHaveLength(0);

    const [pendingRequest] = await db.select().from(toolActionRequests);
    await f.gateway.declineActionRequest({
      companyId: f.company.id,
      actionRequestId: pendingRequest!.id,
      actor: { userId: "board" },
    });
    let events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ status: "denied", origin: "agent" });

    track.mockClear();
    await f.gateway
      .executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "approved" },
      })
      .then(
        () => {
          throw new Error("expected approval_required");
        },
        (error) => expect(error).toMatchObject({ reasonCode: "approval_required" }),
      );
    const approvable = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.status, "pending"))
      .then((rows) => rows[0]!);
    await f.gateway.approveActionRequest({
      companyId: f.company.id,
      actionRequestId: approvable.id,
      actor: { userId: "board" },
    });
    events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({ status: "succeeded", origin: "agent" });
  }, 40_000);

  it("labels connection-test executions as setup_test", async () => {
    const f = await fixture();
    await db.insert(companyMemberships).values({
      companyId: f.company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "member",
    });
    const testCall = await f.gateway.executeTestCall({
      companyId: f.company.id,
      connectionId: f.remoteTool.connection.id,
      agentId: f.agent.id,
      userId: "board-user",
      toolName: f.tool.name,
      parameters: { key: "t", value: "1" },
    });
    expect(testCall).toMatchObject({ decision: "allowed" });
    expect(testCall).not.toHaveProperty("error");

    const events = await settledEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.[1]).toMatchObject({
      status: "succeeded",
      origin: "setup_test",
    });
  }, 30_000);

  it("an idempotent replay returns the stored result without a second event", async () => {
    const f = await fixture();
    const idempotencyKey = `telemetry-replay-${randomUUID()}`;
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await settledEvents(1);
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ status: "replayed" });

    const events = await settledEvents(1);
    expect(events).toHaveLength(1);
  }, 30_000);

  it("telemetry sink failures never fail the tool call", async () => {
    const f = await fixture();
    track.mockImplementation(() => {
      throw new Error("sink offline");
    });
    await expect(
      f.gateway.executeTool({
        sessionToken: f.session.token,
        tool: f.tool.name,
        parameters: { key: "a", value: "1" },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation?.status).toBe("succeeded");
    track.mockReset();
  }, 30_000);
});
