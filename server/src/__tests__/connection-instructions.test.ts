import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSystemInstructions } from "../../../packages/paperclip-runner/src/backends/runtime-context.js";
import type { NativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues, toolApplications, toolCatalogEntries, toolConnections, toolPolicies, toolProfileBindings, toolActionRequests } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolDiscoveryScheduler } from "../services/tool-discovery-scheduler.js";
import { toolAccessService, projectedConnectionToolArguments, projectedConnectionToolInputSchema } from "../services/tool-access.js";
import { composeConnectionInstructions, prepareConnectionInstructionDelivery } from "../services/connection-instructions.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { canonicalNativeRuntimeContextDigest, parseNativeRuntimeContext } from "../vendor/paperclip-runner/index.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { execute as executeProcess } from "../adapters/process/execute.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
const paragraph = "Use the release handbook before changing a deployment. Cite the relevant release checklist.";
async function createRunFixture(db: ReturnType<typeof createDb>) {
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

async function createRemoteMcpToolFixture(db: ReturnType<typeof createDb>, companyId: string) {
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


(support.supported ? describe : describe.skip)("generic connection instruction delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-connection-instructions-"); db = createDb(temp.connectionString); }, 30000);
  afterAll(async () => { await temp?.cleanup(); });
  async function fixture() {
    const run = await createRunFixture(db);
    const connection = await createRemoteMcpToolFixture(db, run.company.id);
    const service = toolAccessService(db);
    await service.updateConnection(connection.connection.id, { agentInstructions: { enabled: true, text: paragraph } });
    await service.finishGalleryAppConnection(run.company.id, connection.connection.id, {
      enabledCatalogEntryIds: [connection.catalogEntry.id], askFirstCatalogEntryIds: [], access: { agentIds: [run.agent.id] },
    });
    const gateway = createToolGatewayService(db);
    const binding = { companyId: run.company.id, agentId: run.agent.id, runId: run.run.id };
    return { ...run, ...connection, gateway, service, binding, resolve: () => gateway.resolveConnectionInstructionsForRun(binding) };
  }

  it("keeps guidance stable and checks revocation even when the discovery queue is saturated", async () => {
    const f = await fixture();
    const snapshot = await f.resolve();
    expect(snapshot?.text).toContain(paragraph);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const listings = Array.from({ length: 34 }, () => toolDiscoveryScheduler.run(() => barrier));
    try {
      expect(await f.resolve()).toEqual(snapshot);
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, f.connection.id));
      expect(await f.resolve()).toBeNull();
    } finally {
      release();
      await Promise.all(listings);
    }
  });

  it("persists a non-memory paragraph and captures it in actual process input and both prompt composers", async () => {
    const f = await fixture();
    expect((await f.service.getConnection(f.connection.id)).agentInstructions).toEqual({ enabled: true, text: paragraph });
    const context: Record<string, unknown> = { connectionInstructions: { text: "forged" }, paperclipWake: { connectionInstructions: { text: "forged wake" } } };
    const config = await prepareConnectionInstructionDelivery({ resolve: f.resolve, context, config: { paperclipConnectionInstructions: { text: "forged config" } }, native: false });
    const snapshot = config.paperclipConnectionInstructions as { text: string; digest: string };
    expect(snapshot.text).toContain(paragraph);
    expect(snapshot.text).not.toContain("forged");
    expect(renderPaperclipWakePrompt(context.paperclipWake)).toContain(paragraph);
    const runtimeContext = { ...nativeRuntimeContextFixture(), connectionInstructions: snapshot };
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const parsed = parseNativeRuntimeContext(runtimeContext);
    const bundle = await mkdtemp(join(tmpdir(), "connection-instruction-input-"));
    try {
      await writeFile(join(bundle, "AGENTS.md"), "Agent entry instructions.");
      parsed.instructions.bundle.rootPath = bundle;
      expect(nativeSystemInstructions({ provider: { kind: "codex" }, runtimeContext: parsed } as NativeExecutionInput)).toContain(paragraph);
    } finally { await rm(bundle, { recursive: true, force: true }); }
    expect(() => parseNativeRuntimeContext({ ...runtimeContext, connectionInstructions: { ...snapshot, text: "forged" } })).toThrow();
    expect(parseNativeRuntimeContext(nativeRuntimeContextFixture()).connectionInstructions).toBeUndefined();
    const captured: string[] = [];
    const result = await executeProcess({ runId: f.run.id, agent: { ...f.agent, adapterType: "process" }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, context,
      config: { command: process.execPath, args: ["-e", "const fs=require('node:fs');const file=process.env.PAPERCLIP_CONNECTION_INSTRUCTIONS_FILE;console.log(JSON.stringify({file,mode:fs.statSync(file).mode&511,snapshot:JSON.parse(fs.readFileSync(file,'utf8'))}))"], env: { PAPERCLIP_CONNECTION_INSTRUCTIONS_FILE: "/forged" } },
      onLog: async (_stream, text) => { captured.push(text); },
    });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(captured.join("").trim());
    expect(received.snapshot).toEqual(snapshot);
    expect(received.mode).toBe(0o600);
    await expect(access(received.file)).rejects.toThrow();
  });

  it("backfills existing template connections without replacing custom text or opt-outs", async () => {
    const f = await fixture();
    await db.update(toolConnections).set({ agentInstructions: null, config: { ...f.connection.config, sourceTemplateKey: "mem0" } }).where(eq(toolConnections.id, f.connection.id));
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0298_connection_agent_instructions.sql", import.meta.url), "utf8");
    await db.$client.unsafe(migration);
    const populated = await f.service.getConnection(f.connection.id);
    expect(populated.agentInstructions).toMatchObject({ enabled: true, template: { id: "mem0.usage", version: 1 } });
    await f.service.updateConnection(f.connection.id, { agentInstructions: { enabled: false, text: paragraph } });
    await db.$client.unsafe(migration);
    expect((await f.service.getConnection(f.connection.id)).agentInstructions).toEqual({ enabled: false, text: paragraph });
  });

  it("freezes active turns and removes instructions on the next turn without removing tools", async () => {
    const f = await fixture();
    const first = await f.resolve();
    await f.service.updateConnection(f.connection.id, { agentInstructions: { enabled: true, text: "New release procedure." } });
    expect((await f.resolve())?.digest).not.toBe(first?.digest);
    expect(first?.text).toContain(paragraph);
    await f.service.updateConnection(f.connection.id, { agentInstructions: { enabled: false, text: paragraph } });
    expect(await f.resolve()).toBeNull();
    const session = await f.gateway.createSession(f.binding);
    expect((await f.gateway.listToolsForSession(session.token)).some(tool => tool.connectionId === f.connection.id)).toBe(true);
    const context: Record<string, unknown> = { connectionInstructions: first, paperclipWake: { connectionInstructions: first } };
    const config = await prepareConnectionInstructionDelivery({ resolve: f.resolve, context, config: { paperclipConnectionInstructions: first }, native: false });
    expect(config.paperclipConnectionInstructions).toBeNull();
    expect(renderPaperclipWakePrompt(context.paperclipWake)).not.toContain(paragraph);
  });

  it("follows assignment, action policy, grant revocation, and company boundaries", async () => {
    const f = await fixture();
    expect(await f.resolve()).not.toBeNull();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, f.connection.id));
    expect(await f.resolve()).toBeNull();
    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.connectionId, f.connection.id));
    const [block] = await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Block handbook", policyType: "block", priority: 1000, selectors: { connectionId: f.connection.id } }).returning();
    expect(await f.resolve()).toBeNull();
    await db.delete(toolPolicies).where(eq(toolPolicies.id, block.id));
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.targetId, f.agent.id));
    expect(await f.resolve()).toBeNull();
    const other = await fixture();
    await expect(f.gateway.resolveConnectionInstructionsForRun({ ...f.binding, companyId: other.company.id })).rejects.toMatchObject({ status: 403 });
    await expect(f.gateway.resolveConnectionInstructionsForRun({ ...f.binding, agentId: other.agent.id })).rejects.toMatchObject({ status: 403 });
  });

  it("invalidates a pending approval when the configured Honcho workspace changes", async () => {
    const f = await fixture();
    const config = { ...f.connection.config, sourceTemplateKey: "honcho", connectionMethodKey: "mcp-api-key", methodConfig: { workspaceId: "before" } };
    await f.service.updateConnection(f.connection.id, { config });
    await db.update(toolCatalogEntries).set({ inputSchema: { type: "object", properties: { workspace_id: { type: "string" }, query: { type: "string" } }, required: ["workspace_id"] } }).where(eq(toolCatalogEntries.id, f.catalogEntry.id));
    await f.service.finishGalleryAppConnection(f.company.id, f.connection.id, { enabledCatalogEntryIds: [f.catalogEntry.id], askFirstCatalogEntryIds: [f.catalogEntry.id], access: { agentIds: [f.agent.id] } });
    let providerCalls = 0;
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "instruction-workspace-test", remoteHttpRequest: async () => { providerCalls++; throw new Error("Stale approval must not reach Honcho"); } });
    const session = await gateway.createSession(f.binding);
    const tool = (await gateway.listToolsForSession(session.token)).find(tool => tool.connectionId === f.connection.id)!;
    expect(JSON.stringify(tool.parametersSchema)).not.toContain("workspace_id");
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { query: "release", workspace_id: "forged" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [approval] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.issueId, f.issue.id));
    await f.service.updateConnection(f.connection.id, { config: { ...config, methodConfig: { workspaceId: "after" } } });
    await expect(gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: approval.id, actor: { userId: "reviewer" } })).rejects.toMatchObject({ reasonCode: "approved_tool_target_changed" });
    expect(providerCalls).toBe(0);
  });

  it("requires the responsible person's active membership and personal identity", async () => {
    const f = await fixture();
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, f.connection.id));
    await db.update(connectionGrants).set({ kind: "user", subjectUserId: "instruction-owner", isDefault: false }).where(eq(connectionGrants.connectionId, f.connection.id));
    expect(await f.resolve()).toBeNull();
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "instruction-owner", membershipRole: "member", status: "active" });
    await db.update(heartbeatRuns).set({ responsibleUserId: "instruction-owner" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await f.resolve()).not.toBeNull();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, f.company.id));
    expect(await f.resolve()).toBeNull();
  });
});

describe("Honcho workspace configuration", () => {
  const schema = { type: "object", properties: { workspace_id: { type: "string" }, query: { type: "string" } }, required: ["workspace_id", "query"] };
  const connection = { config: { sourceTemplateKey: "honcho", connectionMethodKey: "mcp-api-key", methodConfig: { workspaceId: "team-workspace" } } } as typeof toolConnections.$inferSelect;
  it("projects the workspace and hides its argument while keeping old unconfigured tools usable", () => {
    expect(projectedConnectionToolArguments(connection, { workspace_id: "forged", query: "decisions" }, "query", schema)).toEqual({ workspace_id: "team-workspace", query: "decisions" });
    expect(projectedConnectionToolInputSchema(connection, schema, "query")).toEqual({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
    const old = { ...connection, config: { ...connection.config, methodConfig: {} } };
    expect(projectedConnectionToolArguments(old, { workspace_id: "chosen" }, "query", schema)).toEqual({ workspace_id: "chosen" });
    const source = { connection: { ...old, id: "honcho", name: "Honcho", agentInstructions: { enabled: true, text: paragraph } }, grantId: "grant" };
    expect(composeConnectionInstructions([source])).toBeNull();
    const configured = composeConnectionInstructions([{ ...source, connection: { ...source.connection, config: connection.config } }]);
    expect(configured?.text).toContain('"workspaceId":"team-workspace"');
    const changed = composeConnectionInstructions([{ ...source, connection: { ...source.connection, config: { ...connection.config, methodConfig: { workspaceId: "other" } } } }]);
    expect(changed?.digest).not.toBe(configured?.digest);
    const legacy = { ...source, connection: { ...source.connection, config: {}, transportConfig: connection.config } };
    expect(composeConnectionInstructions([legacy])).toEqual(configured);
    expect(projectedConnectionToolArguments({ ...connection, config: {}, transportConfig: connection.config }, { workspace_id: "forged" }, "query", schema)).toEqual({ workspace_id: "team-workspace" });
    expect(composeConnectionInstructions([{ ...legacy, connection: { ...legacy.connection, transportConfig: old.config } }])).toBeNull();
    const methodChanged = { ...legacy, connection: { ...legacy.connection, config: { connectionMethodKey: "new-method" } } };
    expect(composeConnectionInstructions([methodChanged])?.digest).not.toBe(configured?.digest);
  });
});
