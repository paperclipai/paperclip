import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, createDb, heartbeatRuns, issues, projects, toolActionRequests, toolPolicies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { pluginManifestV1Schema, pluginToolDeclarationSchema } from "@paperclipai/shared";
import type { PluginToolDeclaration } from "@paperclipai/shared";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const toolDeclaration = { name: "register_watch", displayName: "Watch", description: "Persist a watch", parametersSchema: { type: "object" } };

function manifestFor(tool: PluginToolDeclaration) {
  return pluginManifestV1Schema.parse({
    id: "fixture.tools", apiVersion: 1, version: "1.0.0", displayName: "Tools", description: "Tool risk fixture", author: "Tests",
    categories: ["automation"], capabilities: ["agent.tools.register"], entrypoints: { worker: "./worker.js" }, tools: [tool],
  });
}

describe("plugin tool risk contract", () => {
  it.each(["read", "write", "destructive"] as const)("preserves declared %s risk through validation and discovery", (riskLevel) => {
    const manifest = manifestFor({ ...toolDeclaration, riskLevel });
    expect(manifest.tools![0]).toMatchObject({ riskLevel });
    const dispatcher = createPluginToolDispatcher();
    dispatcher.registerPluginTools(manifest.id, manifest, randomUUID());
    expect(dispatcher.getTool("fixture.tools:register_watch")).toMatchObject({ riskLevel });
    expect(dispatcher.listToolsForAgent()[0]).toMatchObject({ riskLevel });
  });

  it("rejects invalid risk and accepts declarations without risk metadata", () => {
    expect(pluginToolDeclarationSchema.safeParse({ ...toolDeclaration, riskLevel: "unknown" }).success).toBe(false);
    expect(pluginToolDeclarationSchema.parse(toolDeclaration)).toEqual(toolDeclaration);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("native plugin risk policy", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-risk-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(name: string, riskLevel?: "read" | "write" | "destructive") {
    const [company] = await db.insert(companies).values({ name: "Plugin risk", issuePrefix: `PR${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", role: "engineer", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Risk project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Risk policy", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id, projectId: project.id } }).returning();
    const call = vi.fn(async () => ({ content: "Fixture complete" }));
    const dispatcher = createPluginToolDispatcher({ workerManager: { isRunning: () => true, call } as unknown as PluginWorkerManager });
    const manifest = manifestFor({ ...toolDeclaration, name, ...(riskLevel ? { riskLevel } : {}) });
    dispatcher.registerPluginTools(manifest.id, manifest, randomUUID());
    const gateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher, toolActionSigningSecret: "test-tool-action-signing-secret" });
    return { company, agent, project, issue, run, call, dispatcher, gateway, tool: `fixture.tools:${name}` };
  }

  it.each(["escalate_to_human", "handoff_to_agent", "discuss_with_agent", "register_watch"])("keeps %s out of a read-only policy", async (name) => {
    const f = await fixture(name, "write");
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Read only", policyType: "allow", selectors: { riskLevel: "read" } });
    const visible = await f.gateway.listPluginToolsForAgent({ companyId: f.company.id, agentId: f.agent.id });
    expect(visible.some((tool) => tool.name === f.tool)).toBe(false);
    await expect(f.gateway.executePluginTool({
      actor: { type: "agent", companyId: f.company.id, agentId: f.agent.id, runId: f.run.id }, tool: f.tool, parameters: {},
      runContext: { companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, projectId: f.project.id },
    })).rejects.toMatchObject({ status: 403 });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each([["get_status", undefined], ["send_message", "read"], ["delete_record", "read"], ["delete_record", "write"]] as const)("preserves legacy name inference for %s", async (name, riskLevel) => {
    const f = await fixture(name, riskLevel);
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Read only", policyType: "allow", selectors: { riskLevel: "read" } });
    const visible = await f.gateway.listPluginToolsForAgent({ companyId: f.company.id, agentId: f.agent.id });
    expect(visible.some((tool) => tool.name === f.tool)).toBe(name === "get_status");
  });

  it("requires formal approval for a declared destructive action without a destructive verb", async () => {
    const f = await fixture("reset_account", "destructive");
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Review reset", policyType: "require_approval", selectors: { toolName: f.tool } });
    const session = await f.gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id });
    await expect(f.gateway.executeTool({ sessionToken: session.token, tool: f.tool, parameters: {} })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    expect(request.approvalId).toEqual(expect.any(String));
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, request.approvalId!));
    expect(approval).toMatchObject({ type: "request_board_approval", status: "pending" });
    expect(f.call).not.toHaveBeenCalled();
  });
});
