import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, createDb,
  heartbeatRuns, issues, toolAccessAuditEvents, toolConnections, userSecretDeclarations } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const live = process.env.PAPERCLIP_ONEPASSWORD_LIVE === "1";
const fixtureState = vi.hoisted(() => ({ calls: 0, items: new Map<string, Record<string, unknown>>() }));
vi.mock("../services/connectors/onepassword/client.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/connectors/onepassword/client.js")>();
  const callOnePassword = async (headers: Record<string, string>, tool: string, parameters: unknown, ms?: number) => {
    if (process.env.PAPERCLIP_ONEPASSWORD_LIVE === "1") return actual.callOnePassword(headers, tool, parameters, ms);
    const { onePasswordArguments } = await import("../services/connectors/onepassword/catalog.js");
    const args = onePasswordArguments(tool, parameters);
    fixtureState.calls++;
    if (headers.Authorization === "Bearer ops_rejected") throw new Error("1Password rejected the fixture credential");
    if (tool === "onepassword_list_vaults") return [{ id: "a".repeat(26), title: "Disposable test vault" }];
    if (tool === "onepassword_create_item") {
      const item = { ...args, id: "b".repeat(26), version: 1 };
      fixtureState.items.set(String(item.id), item); return item;
    }
    if (tool === "onepassword_update_item") {
      const item = { ...fixtureState.items.get(String(args.itemId)), ...args };
      fixtureState.items.set(String(args.itemId), item); return item;
    }
    if (tool === "onepassword_get_item") return fixtureState.items.get(String(args.itemId));
    if (tool === "onepassword_list_items") return [...fixtureState.items.values()].filter(item => item.vaultId === args.vaultId && !item.archived);
    if (tool === "onepassword_resolve_secret") return { value: "disposable-secret" };
    if (tool === "onepassword_archive_item") {
      const item = fixtureState.items.get(String(args.itemId));
      if (item) item.archived = true;
      return { archived: true };
    }
    if (tool === "onepassword_delete_item") {
      fixtureState.items.delete(String(args.itemId));
      return { deleted: true };
    }
    return { success: true };
  };
  return { ...actual, callOnePassword, executeOnePasswordTool: (input: Parameters<typeof actual.executeOnePasswordTool>[0]) =>
    process.env.PAPERCLIP_ONEPASSWORD_LIVE === "1" ? actual.executeOnePasswordTool(input)
      : callOnePassword(input.headers, input.toolName, input.parameters) };
});

const support = await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "onepassword-reviewer" };
const credential = live ? process.env.OP_SERVICE_ACCOUNT_TOKEN! : "ops_fixture-credential";

(support.supported ? describe : describe.skip)(live ? "1Password LIVE governed lifecycle" : "1Password governed lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    if (!credential) throw new Error("Live proof requires OP_SERVICE_ACCOUNT_TOKEN");
    temp = await startEmbeddedPostgresTestDatabase("onepassword-connector-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function fixture(personal = false) {
    const [company] = await db.insert(companies).values({ name: "1Password connector test", issuePrefix: `OP${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
    const service = toolAccessService(db, { deploymentMode: "authenticated" });
    const connected = await service.connectGalleryApp(company.id, { galleryKey: "1password", methodKey: "service-account",
      ...(personal ? { grantKind: "user" as const } : {}), credentialValues: { "credentials.authorization": credential } }, actor);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Vault test agent", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] },
    }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Disposable connector proof", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const tools = await gateway.listToolsForSession(session.token);
    const call = async (name: string, parameters: unknown) => {
      if (live) console.info(`Live 1Password action: ${name}`);
      const tool = tools.find(entry => entry.upstreamToolName === name);
      if (!tool) throw new Error(`Missing reviewed tool: ${name}`);
      const output = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters, idempotencyKey: randomUUID() });
      expect(JSON.stringify(output).includes(credential)).toBe(false);
      return output;
    };
    return { company, service, connected, agent, run, issue, gateway, session, tools, call };
  }

  it.each([false, true])("vaults credentials with the selected ownership and runs reads/writes (personal=%s)", async personal => {
    const f = await fixture(personal);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connected.connectionId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0]!.secretId));
    expect(secret.scope).toBe(personal ? "user" : "company");
    expect(secret.ownerUserId).toBe(personal ? actor.actorId : null);
    if (personal) {
      const declarations = await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.companyId, f.company.id));
      expect(declarations.some(entry => entry.configPath === "credentials.authorization")).toBe(true);
    }
    expect(f.tools).toHaveLength(8);
    expect(f.connected.catalog.find(entry => entry.toolName === "onepassword_delete_item")?.riskLevel).toBe("destructive");
    expect(f.connected.catalog.find(entry => entry.toolName === "onepassword_create_item")?.riskLevel).toBe("write");
    expect(JSON.stringify(await f.service.getConnection(f.connected.connectionId)).includes(credential)).toBe(false);
    const vaults = await f.call("onepassword_list_vaults", {});
    const data = vaults.result?.data?.structuredContent as Array<{ id: string }>;
    expect(Array.isArray(data) && data.length > 0).toBe(true);
    const vaultId = data[0]!.id;
    let itemId: string | undefined;
    try {
      const created = await f.call("onepassword_create_item", { vaultId, title: `Paperclip disposable connector proof ${randomUUID()}`,
        category: "SecureNote", notes: "Synthetic connector test data", fields: [{ id: "test_secret", title: "Test secret", fieldType: "Concealed", value: "disposable-secret" }] });
      itemId = (created.result?.data?.structuredContent as { id: string }).id;
      expect(typeof itemId === "string").toBe(true);
      const listed = await f.call("onepassword_list_items", { vaultId });
      expect((listed.result?.data?.structuredContent as Array<{ id: string }>).some(item => item.id === itemId)).toBe(true);
      const read = await f.call("onepassword_get_item", { vaultId, itemId });
      expect(JSON.stringify(read).includes("Synthetic connector test data")).toBe(true);
      await f.call("onepassword_update_item", { vaultId, itemId, notes: "Updated synthetic connector test data" });
      const reread = await f.call("onepassword_get_item", { vaultId, itemId });
      expect(JSON.stringify(reread).includes("Updated synthetic connector test data")).toBe(true);
      const resolved = await f.call("onepassword_resolve_secret", { reference: `op://${vaultId}/${itemId}/test_secret` });
      expect(JSON.stringify(resolved).includes("disposable-secret")).toBe(true);
      await f.service.refreshCatalog(f.connected.connectionId, actor);
      await f.service.reconnectGalleryApp(f.connected.connectionId, f.company.id, { credentialValues: { "credentials.authorization": credential } }, actor);
      await f.call("onepassword_get_item", { vaultId, itemId });
      const archived = await f.call("onepassword_archive_item", { vaultId, itemId });
      expect(archived.result?.data?.structuredContent).toEqual({ archived: true });
    } finally {
      if (itemId) {
        const deleted = await f.call("onepassword_delete_item", { vaultId, itemId });
        expect(deleted.result?.data?.structuredContent).toEqual({ deleted: true });
      }
    }
    const remaining = await f.call("onepassword_list_items", { vaultId });
    expect((remaining.result?.data?.structuredContent as Array<{ id: string }>).some(item => item.id === itemId)).toBe(false);
    const audit = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
    expect(audit.length > 0).toBe(true);
    expect(JSON.stringify(audit).includes(credential)).toBe(false);
    await f.service.archiveConnection(f.connected.connectionId, f.company.id, actor);
    await expect(f.call("onepassword_list_vaults", {})).rejects.toThrow();
    expect(await f.gateway.listToolsForSession(f.session.token)).toHaveLength(0);
  }, 180_000);

  it.skipIf(live)("enforces action policy, company scope, and revocation on retained sessions", async () => {
    const f = await fixture();
    await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
      enabledCatalogEntryIds: f.connected.catalog.filter(entry => entry.riskLevel === "read").map(entry => entry.id),
      askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    let before = fixtureState.calls;
    await expect(f.call("onepassword_create_item", { vaultId: "a".repeat(26), title: "Blocked", category: "SecureNote" })).rejects.toThrow();
    expect(fixtureState.calls).toBe(before);
    await expect(f.gateway.createSession({ companyId: randomUUID(), agentId: f.agent.id, runId: f.run.id, issueId: f.issue.id })).rejects.toThrow();
    await db.update(toolConnections).set({ enabled: false }).where(and(eq(toolConnections.id, f.connected.connectionId), eq(toolConnections.companyId, f.company.id)));
    before = fixtureState.calls;
    await expect(f.call("onepassword_list_vaults", {})).rejects.toThrow();
    expect(fixtureState.calls).toBe(before);
  });

  it.skipIf(!live)("qualifies a read-only service account through connect, gateway, reconnect and removal", async () => {
    const f = await fixture(true);
    await f.call("onepassword_list_vaults", {});
    await f.service.refreshCatalog(f.connected.connectionId, actor);
    const reconnected = await f.service.reconnectGalleryApp(f.connected.connectionId, f.company.id, {
      credentialValues: { "credentials.authorization": credential },
    }, actor);
    expect(reconnected.connection.id).toBe(f.connected.connectionId);
    await f.call("onepassword_list_vaults", {});
    const audit = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
    expect(audit.length > 0 && !JSON.stringify(audit).includes(credential)).toBe(true);
    await f.service.archiveConnection(f.connected.connectionId, f.company.id, actor);
    await expect(f.call("onepassword_list_vaults", {})).rejects.toThrow();
    expect(await f.gateway.listToolsForSession(f.session.token)).toHaveLength(0);
  }, 120_000);
});
