import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../../services/plugin-tool-dispatcher.js";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_REVIEW_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
export const describeToolGatewayEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
export const testToolActionSigningSecret = "test-tool-action-signing-secret";
export type ToolGatewayServiceOptions = NonNullable<Parameters<typeof createToolGatewayService>[1]>;

export function createTestToolGatewayService(db: ReturnType<typeof createDb>, options: ToolGatewayServiceOptions = {}) {
  return createToolGatewayService(db, {
    ...options,
    toolActionSigningSecret: options.toolActionSigningSecret ?? testToolActionSigningSecret,
    remoteHttpRequest: options.remoteHttpRequest ?? (async (url, init) => fetch(url, init)),
  });
}

export async function createRunFixture(db: ReturnType<typeof createDb>) {
  const company = await db.insert(companies).values({
    name: `Gateway ${randomUUID()}`,
    issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: `Gateway Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning().then((rows) => rows[0]!);
  const issue = await db.insert(issues).values({
    companyId: company.id,
    title: "Gateway approval work",
    status: "in_progress",
    assigneeAgentId: agent.id,
  }).returning().then((rows) => rows[0]!);
  const run = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: agent.id,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue.id },
  }).returning().then((rows) => rows[0]!);
  return { company, agent, issue, run };
}

export async function createRemoteMcpToolFixture(db: ReturnType<typeof createDb>, companyId: string) {
  const application = await db.insert(toolApplications).values({
    companyId,
    applicationKey: `remote-${randomUUID().slice(0, 8)}`,
    name: "Remote MCP",
    type: "mcp_http",
    status: "active",
  }).returning().then((rows) => rows[0]!);
  const connection = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: "Remote connection",
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    // Use a public IP literal so protocol tests remain independent of DNS while
    // still exercising the production egress guard and their global fetch stub.
    credentialPolicy: "shared",
    config: { url: "https://8.8.8.8/mcp" },
  }).returning().then((rows) => rows[0]!);
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  const catalogEntry = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection.id,
    entryKind: "tool",
    name: "needs_input",
    toolName: "needs_input",
    title: "Needs input",
    riskLevel: "read",
    isReadOnly: true,
    status: "active",
    versionHash: randomUUID(),
    schemaHash: randomUUID(),
  }).returning().then((rows) => rows[0]!);
  return { application, connection, catalogEntry };
}

export function fakePluginDispatcher(): PluginToolDispatcher {
  return {
    initialize: async () => {},
    teardown: () => {},
    listToolsForAgent: () => [
      {
        name: "fixture:delete_everything",
        displayName: "Delete everything",
        description: "Destructive fixture tool.",
        parametersSchema: { type: "object" },
        pluginId: "fixture-plugin",
      },
    ],
    getTool: () => null,
    executeTool: async (_name, parameters) => ({
      pluginId: "fixture-plugin",
      toolName: "delete_everything",
      result: { content: "deleted", data: parameters },
    }),
    registerPluginTools: () => {},
    unregisterPluginTools: () => {},
    toolCount: () => 1,
    getRegistry: () => {
      throw new Error("not implemented");
    },
  };
}

type IdRef = { id: string };

export function reviewNotePolicyRow(company: IdRef): typeof toolPolicies.$inferInsert {
  return {
    companyId: company.id,
    name: "Review note writes",
    policyType: "require_approval",
    selectors: { toolName: "mcp-remote-fixture:update_note" },
  };
}

export function readPolicyRow(company: IdRef, name: string): typeof toolPolicies.$inferInsert {
  return {
    companyId: company.id,
    name,
    policyType: "allow",
    selectors: { riskLevel: "read" },
  };
}

export function runSessionInput(company: IdRef, agent: IdRef, run: IdRef): Parameters<ReturnType<typeof createToolGatewayService>["createSession"]>[0] {
  return {
    companyId: company.id,
    agentId: agent.id,
    runId: run.id,
  };
}

export async function clearToolGatewayFixtures(db: ReturnType<typeof createDb>) {
  vi.unstubAllEnvs();
  await db.delete(activityLog);
  await db.delete(agentWakeupRequests);
  await db.delete(toolGatewaySessions);
  await db.delete(toolCallEvents);
  await db.delete(toolAccessAuditEvents);
  await db.delete(toolActionRequests);
  await db.delete(toolInvocations);
  await db.delete(issueApprovals);
  await db.delete(approvals);
  await db.delete(issueThreadInteractions);
  await db.delete(toolCatalogEntries);
  await db.delete(toolConnections);
  await db.delete(toolApplications);
  await db.delete(companySecrets);
  await db.delete(toolPolicies);
  await db.delete(heartbeatRuns);
  await db.delete(issues);
  await db.delete(projects);
  await db.delete(agents);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

export function createToolGatewayDbHarness() {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let stopReviewWorker: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString, {
      maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0,
    });
    await clearToolGatewayFixtures(db);
  }, 20_000);

  afterEach(async () => {
    await stopReviewWorker?.();
    stopReviewWorker = undefined;
    await clearToolGatewayFixtures(db);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  return {
    get db() {
      return db;
    },
    get connectionString() {
      return externalDatabaseUrl ?? tempDb!.connectionString;
    },
    setStopReviewWorker(stop: (() => Promise<void>) | undefined) {
      stopReviewWorker = stop;
    },
    clearFixtures: () => clearToolGatewayFixtures(db),
  };
}
