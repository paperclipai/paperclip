import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, chatEndpoints, authUsers, heartbeatRuns, issues, companies, companyMemberships, principalPermissionGrants, companySecrets, companySecretBindings, companySecretProviderConfigs, connectionGrants, connectionGrantMembers, connectionGrantDelegations, userSecretDefinitions, createDb, plugins, toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls, toolProfiles, toolProfileBindings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { emailConnectionService } from "../services/email-connections.js";
import { accessService } from "../services/access.js";
import { secretService } from "../services/secrets.js";
import { slackSearchOAuthService } from "../services/connectors/slack-search-oauth.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("connector access runtime synchronization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  let peerId: string;
  let pluginId: string;
  let applicationId: string;
  let connectionId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-access-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); peerId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connector runtime fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(agents).values([agentId, peerId].map(id => ({ id, companyId, name: id, adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId] })));
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Fixture MCP", type: "mcp_http" }).returning(); applicationId = application.id;
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId, name: "Fixture connection", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning(); connectionId = connection.id;
  });
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);

  it("captures referenced vault configuration and disablement through the real provider service", async () => {
    const [vault] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "aws_secrets_manager", displayName: "Fixture vault", config: { region: "us-east-1" } }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, provider: "aws_secrets_manager", providerConfigId: vault.id, key: "vault", name: "Vault fixture" }).returning();
    await db.update(toolConnections).set({ credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).where(eq(toolConnections.id, connectionId));
    const before = (await events()).length;
    await db.update(companySecretProviderConfigs).set({ healthStatus: "ok", healthCheckedAt: new Date(), healthDetails: { fixture: true } }).where(eq(companySecretProviderConfigs.id, vault.id));
    expect(await events()).toHaveLength(before);
    await secretService(db).updateProviderConfig(vault.id, { config: { region: "us-west-2" } });
    expect(await events()).toHaveLength(before + 2);
    await secretService(db).disableProviderConfig(vault.id);
    expect(await events()).toHaveLength(before + 4);
    const [unrelated] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "local_encrypted", displayName: "Unreferenced vault" }).returning();
    await secretService(db).disableProviderConfig(unrelated.id);
    expect(await events()).toHaveLength(before + 4);
  });
  it("skips unchanged grant audiences and coalesces replacements to one company refresh per transaction", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization" }).returning();
    const service = toolAccessService(db);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice"]);
    const before = (await events()).length;
    expect((await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice", "alice"])).members).toHaveLength(1);
    expect(await events()).toHaveLength(before);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["bob"]);
    expect(await events()).toHaveLength(before + 2);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
  });
  it.each(["uninstall", "permission save"] as const)("serializes %s with finalization or role changes before runtime locks", async change => {
    let first: (client: Db) => Promise<unknown>;
    let second: (client: Db) => Promise<unknown>;
    let memberId: string | undefined;
    if (change === "uninstall") {
      await toolAccessService(db).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: agentId }] });
      expect((await toolAccessService(db).getConnection(connectionId, companyId)).config.mcpAgentAccessConfigured).toBe(true);
      first = client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [] });
      second = client => toolAccessService(client).finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" });
    } else {
      const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active", membershipRole: "member" }).returning();
      memberId = member.id;
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "alice", permissionKey: "agents:create" });
      first = client => accessService(client).updateMemberAndPermissions(companyId, member.id, { membershipRole: "admin", grants: [{ permissionKey: "agents:create" }] }, null);
      second = client => accessService(client).setMemberPermissions(companyId, member.id, [{ permissionKey: "issues:create" }], null);
    }
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const initial = run(first);
    let concurrent: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      concurrent = run(second);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([initial, concurrent]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    if (change === "uninstall") {
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId))).toHaveLength(0);
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId));
      expect(bindings.some(binding => binding.metadata?.source === "tool_connection_install")).toBe(false);
    } else {
      expect(await accessService(db).getMemberById(companyId, memberId!)).toMatchObject({ membershipRole: "admin" });
      expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId))).toEqual([expect.objectContaining({ permissionKey: "issues:create" })]);
    }
  }, 15000);
  it.each(["email allowAgent", "connection intent"] as const)("orders outer %s with direct install saves", async caller => {
    let outer: (client: Db) => Promise<unknown>;
    if (caller === "email allowAgent") {
      await db.update(toolConnections).set({ config: { provider: "agentmail", mcpAgentAccessConfigured: true } }).where(eq(toolConnections.id, connectionId));
      outer = client => emailConnectionService(client).allowAgent(companyId, connectionId, agentId, { localImplicit: true }, "fixture-setup");
    } else {
      const userId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Fixture user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Use Notion", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId } });
      const pending = await connectionIntentService(db).request({ sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: userId, scope: "connection_intents", iat: 1, exp: 2, instance_id: "test" }, "notion");
      expect(pending.interactionId).toEqual(expect.any(String));
      await db.update(toolConnections).set({ healthStatus: "ok", config: { sourceTemplateKey: "notion", mcpAgentAccessConfigured: true } }).where(eq(toolConnections.id, connectionId));
      await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", status: "active", isDefault: true });
      await db.insert(toolCatalogEntries).values({ companyId, applicationId, connectionId, name: "read", toolName: "read", versionHash: "fixture", riskLevel: "read", isReadOnly: true });
      outer = client => connectionIntentService(client).complete(pending.interactionId!, connectionId, userId, { canManageOrganizationGrant: true });
    }
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connectionId}`, name: "Shared fixture profile", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolApplications).where(eq(toolApplications.id, applicationId)).for("update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const direct = run(client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: peerId }] }));
    let nested: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      nested = run(outer);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([direct, nested]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await toolAccessService(db).listConnectionInstalls(connectionId, companyId)).map(install => install.targetId).sort()).toEqual([agentId, peerId].sort());
    if (caller === "connection intent") expect((results[1] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("accepted");
  }, 15000);
  it("orders Slack search disconnect with concurrent personal delegation creation", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    await db.update(toolConnections).set({ connectionPurpose: "channel", transport: "chat_sdk", config: { provider: "slack" } }).where(eq(toolConnections.id, connectionId));
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId, provider: "slack", publicId: randomUUID(), assignedAgentId: agentId, status: "active", providerAccountId: "T-FIXTURE" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", providerTenant: { slackSearch: { endpointId: endpoint.id, workspaceId: "T-FIXTURE", slackUserId: "U-FIXTURE", clientRevision: "fixture" } } }).returning();
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayDelegate = new Promise<void>(resolve => { resume = resolve; });
    const disconnectStarted = new Promise<number>(resolve => { started = resolve; });
    const creation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      locked(); await mayDelegate;
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    });
    await held;
    const disconnect = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return slackSearchOAuthService(tx as unknown as Db, "https://paperclip.example").disconnect(companyId, endpoint.id, "alice");
    });
    const completed = Promise.allSettled([creation, disconnect]);
    try {
      const pid = await disconnectStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await completed; }
    for (const result of await completed) if (result.status === "rejected") throw result.reason;
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
  }, 15000);
  it("retries Slack disconnect when a grant appears while waiting for the connection", async () => {
    await db.update(toolConnections).set({ connectionPurpose: "channel", transport: "chat_sdk", config: { provider: "slack" } }).where(eq(toolConnections.id, connectionId));
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId, provider: "slack", publicId: randomUUID(), assignedAgentId: agentId, status: "active" }).returning();
    let connectionLocked!: () => void; let releaseConnection!: () => void;
    const held = new Promise<void>(resolve => { connectionLocked = resolve; });
    const mayUnlock = new Promise<void>(resolve => { releaseConnection = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).for("no key update");
      connectionLocked(); await mayUnlock;
    });
    await held;
    let retries = 0; let disconnectPid: number | undefined; let writer: Promise<unknown> | undefined;
    let writerLocked!: () => void; let resumeWriter!: () => void;
    const grantHeld = new Promise<void>(resolve => { writerLocked = resolve; });
    const mayWrite = new Promise<void>(resolve => { resumeWriter = resolve; });
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => {
      try { return await transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
        const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        disconnectPid ??= Number(row.pid);
        return operation(tx);
      }, config); }
      catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "55P03") { retries++; resumeWriter(); await writer; }
        throw error;
      }
    }) as typeof db.transaction);
    const disconnect = slackSearchOAuthService(db, "https://paperclip.example").disconnect(companyId, endpoint.id, "alice");
    const disconnectResult = Promise.allSettled([disconnect]);
    try {
      await vi.waitFor(async () => {
        expect(disconnectPid).toBeDefined();
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${disconnectPid!}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
      const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
      writer = db.transaction(async tx => {
        await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
        writerLocked(); await mayWrite;
        await tx.update(toolConnections).set({ name: "Saved during grant discovery" }).where(eq(toolConnections.id, connectionId));
      });
      await grantHeld;
      releaseConnection(); await blocker;
      await vi.waitFor(() => expect(retries).toBe(1), { timeout: 5000 });
      await writer;
      const [result] = await disconnectResult;
      if (result.status === "rejected") throw result.reason;
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    } finally { releaseConnection(); resumeWriter(); await blocker; await writer; await disconnectResult; spy.mockRestore(); }
  }, 15000);
  it("journals a personal grant delegation only for its target agent", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    const before = await events();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    expect((await events()).slice(before.length).map(event => event.resourceId)).toEqual([agentId]);
  });
  it("keeps repeated delegation creation and revocation independent of an unrelated agent lock", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    const before = await events();
    let locked!: () => void; let resume!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayFinish = new Promise<void>(resolve => { resume = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, peerId)).for("no key update");
      locked(); await mayFinish;
    });
    await held;
    try {
      for (let index = 0; index < 2; index++) {
        const delegation = await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
        await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await toolAccessService(tx as unknown as Db).revokeConnectionGrantDelegation(connectionId, grant.id, delegation.id);
        });
      }
      expect((await events()).slice(before.length).map(row => row.resourceId)).toEqual([agentId, agentId, agentId, agentId]);
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        const service = toolAccessService(tx as unknown as Db);
        const delegation = await service.createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
        await service.revokeConnectionGrantDelegation(connectionId, grant.id, delegation.id);
      });
      expect((await events()).slice(before.length).map(row => row.resourceId)).toEqual(Array(5).fill(agentId));
    } finally { resume(); await blocker; }
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
  }, 15000);
  it("invalidates both delegation targets on reassignment and ignores unchanged updates or rollback", async () => {
    await db.insert(agents).values({ companyId, name: "Unrelated delegation peer", adapterType: "paperclip_runner" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    const [delegation] = await db.insert(connectionGrantDelegations).values({ companyId, grantId: grant.id, agentId, createdByUserId: "alice" }).returning();
    const before = await events();
    await db.update(connectionGrantDelegations).set({ agentId: peerId }).where(eq(connectionGrantDelegations.id, delegation.id));
    const reassigned = await events();
    expect(reassigned.slice(before.length).map(row => row.resourceId).sort()).toEqual([agentId, peerId].sort());
    await db.update(connectionGrantDelegations).set({ agentId: peerId }).where(eq(connectionGrantDelegations.id, delegation.id));
    expect(await events()).toEqual(reassigned);
    await expect(db.transaction(async tx => {
      await tx.delete(connectionGrantDelegations).where(eq(connectionGrantDelegations.id, delegation.id));
      throw new Error("rollback delegation revocation");
    })).rejects.toThrow("rollback delegation revocation");
    expect(await events()).toEqual(reassigned);
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.id, delegation.id))).toEqual([expect.objectContaining({ agentId: peerId })]);
  });
  it("limits delegation creation to its target without waiting on unrelated agents", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const grants = await db.insert(connectionGrants).values(["alice", "bob"].map(subjectUserId => ({ companyId, connectionId, kind: "user", subjectUserId }))).returning();
    const baseline = await events();
    const [lower, higher] = [agentId, peerId].sort();
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const saves = grants.map((grant, index) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids[index] = Number(row.pid);
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, index === 0 ? higher : lower, grant.subjectUserId!);
    }));
    const completed = Promise.allSettled(saves);
    try {
      await expect(saves[0]).resolves.toMatchObject({ agentId: higher });
      expect((await events()).slice(baseline.length).map(event => event.resourceId)).toEqual([higher]);
      await vi.waitFor(async () => {
        expect(pids).toHaveLength(2);
        const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid = ${pids[1]} AND wait_event_type = 'Lock'`);
        expect(rows).toHaveLength(1);
      }, { timeout: 5000 });
    } finally { release(); await blocker; }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.companyId, companyId))).toHaveLength(2);
    const before = await events();
    expect(before.slice(baseline.length).map(event => event.resourceId).sort()).toEqual([lower, higher]);
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grants[0].id, higher, grants[0].subjectUserId!);
    expect(await events()).toEqual(before);
  }, 15000);
  it.each(["grant revocation", "membership suspension"] as const)("orders company locks before delegation cleanup during %s", async change => {
    const [lower, higher] = [agentId, peerId].sort();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "member", status: "active" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, higher, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const maySave = new Promise<void>(resolve => { resume = resolve; });
    const cleanupStarted = new Promise<number>(resolve => { started = resolve; });
    const settings = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
      locked(); await maySave;
      return toolAccessService(tx as unknown as Db).updateApplication(applicationId, { name: "Concurrent delegation settings" });
    });
    await held;
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return change === "grant revocation" ? toolAccessService(tx as unknown as Db).revokeConnectionGrant(connectionId, grant.id)
        : accessService(tx as unknown as Db).updateMember(companyId, member.id, { status: "suspended" });
    });
    const completed = Promise.allSettled([settings, cleanup]);
    try {
      const pid = await cleanupStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    const results = await completed;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
  }, 15000);
  it("orders a personal delegation revocation behind whole-grant cleanup", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    const delegation = await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayRevoke = new Promise<void>(resolve => { resume = resolve; });
    const personalStarted = new Promise<number>(resolve => { started = resolve; });
    const whole = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      await tx.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.id).for("no key update");
      locked(); await mayRevoke;
      return toolAccessService(tx as unknown as Db).revokeConnectionGrant(connectionId, grant.id);
    });
    await held;
    const personal = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).revokeConnectionGrantDelegation(connectionId, grant.id, delegation.id);
    });
    const completed = Promise.allSettled([whole, personal]);
    try {
      const pid = await personalStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    const [wholeResult, personalResult] = await completed;
    if (wholeResult.status === "rejected") throw wholeResult.reason;
    expect(personalResult).toMatchObject({ status: "rejected", reason: { status: 404 } });
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
  }, 15000);
  it("orders grant revocation with a concurrent delegation creation", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayCreate = new Promise<void>(resolve => { resume = resolve; });
    const revokerStarted = new Promise<number>(resolve => { started = resolve; });
    const creation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      locked(); await mayCreate;
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice");
    });
    await held;
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).revokeConnectionGrant(connectionId, grant.id);
    });
    const completed = Promise.allSettled([creation, revocation]);
    try {
      const pid = await revokerStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    await expect(toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice")).rejects.toThrow("Only the active personal grant owner");
  }, 15000);
  it.each(["updateMember", "updateMemberAndPermissions", "archiveMember", "setUserCompanyAccess"] as const)("retries %s secret cleanup as a complete transaction", async command => {
    const userId = `cleanup-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "legacy-cleanup", name: "Legacy cleanup fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "legacy-cleanup", name: "Legacy cleanup fixture", scope: "user", ownerUserId: userId, userSecretDefinitionId: definition.id }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: userId, credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] }).returning();
    const before = await events();
    let locked!: () => void; let resume!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayDisable = new Promise<void>(resolve => { resume = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(companySecrets).where(eq(companySecrets.id, secret.id)).for("no key update");
      locked(); await mayDisable;
      return secretService(tx as unknown as Db).update(secret.id, { status: "disabled" });
    });
    await held;
    let retries = 0;
    let cleanupPid: number | undefined;
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (operation, config) => {
      try { return await transaction(async tx => {
        const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        cleanupPid = Number(row.pid);
        return operation(tx);
      }, config); }
      catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "55P03") { retries++; resume(); await writer; }
        throw error;
      }
    }) as typeof db.transaction);
    const service = accessService(db);
    const cleanup = command === "updateMember" ? service.updateMember(companyId, member.id, { status: "suspended" })
      : command === "updateMemberAndPermissions" ? service.updateMemberAndPermissions(companyId, member.id, { status: "suspended", grants: [] }, "owner")
        : command === "archiveMember" ? service.archiveMember(companyId, member.id)
          : service.setUserCompanyAccess(userId, [], { actorUserId: "owner" });
    const completed = Promise.allSettled([writer, cleanup]);
    try {
      await vi.waitFor(async () => {
        if (retries === 1) return;
        expect(cleanupPid).toBeDefined();
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${cleanupPid!}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await completed; spy.mockRestore(); }
    for (const result of await completed) if (result.status === "rejected") throw result.reason;
    expect(retries).toBe(1);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe(command === "archiveMember" || command === "setUserCompanyAccess" ? "archived" : "suspended");
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual([]);
    expect(await events()).toHaveLength(before.length + 4);
  }, 15000);
  it.each((["suspended", "archived"] as const).flatMap(status => (["revocation", "settings"] as const).map(writer => ({ status, writer }))))("orders membership $status cleanup with concurrent $writer", async ({ status, writer }) => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "member", status: "active" }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "cleanup", name: "Cleanup fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "cleanup", name: "Cleanup fixture", scope: "user", ownerUserId: "alice", userSecretDefinitionId: definition.id }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayRevoke = new Promise<void>(resolve => { resume = resolve; });
    const cleanupStarted = new Promise<number>(resolve => { started = resolve; });
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      if (writer === "revocation") await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      else await tx.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).for("update");
      locked(); await mayRevoke;
      const service = toolAccessService(tx as unknown as Db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      return writer === "revocation" ? service.revokeConnectionGrant(connectionId, grant.id) : service.updateConnection(connectionId, { name: "Concurrent settings" });
    });
    await held;
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      const service = accessService(tx as unknown as Db);
      return status === "suspended" ? service.updateMember(companyId, member.id, { status }) : service.archiveMember(companyId, member.id);
    });
    const completed = Promise.allSettled([revocation, cleanup]);
    try {
      const pid = await cleanupStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe(status);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual([]);
    if (writer === "settings") expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].name).toBe("Concurrent settings");
  }, 15000);
  it("orders audience replacement after membership cleanup without reversing grant locks", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const members = await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "member", status: "active" }))).returning();
    const member = members.find(row => row.principalId === "alice")!;
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "audience", name: "Audience fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "audience", name: "Audience fixture", scope: "user", userSecretDefinitionId: definition.id, ownerUserId: "alice" }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] });
    const [organization] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", isDefault: true }).returning();
    await db.insert(connectionGrantMembers).values({ companyId, grantId: organization.id, subjectType: "user", subjectId: "alice" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const maySuspend = new Promise<void>(resolve => { resume = resolve; });
    const audienceStarted = new Promise<number>(resolve => { started = resolve; });
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)).for("update");
      locked(); await maySuspend;
      return accessService(tx as unknown as Db).updateMember(companyId, member.id, { status: "suspended" });
    });
    await held;
    const replacement = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).replaceConnectionGrantMembers(connectionId, organization.id, ["bob"]);
    });
    const completed = Promise.allSettled([cleanup, replacement]);
    try {
      const pid = await audienceStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe("suspended");
    expect((await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, organization.id))).map(row => row.subjectId)).toEqual(["bob"]);
  }, 15000);
  it("invalidates only the owner of an agent secret binding", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "binding", name: "Binding fixture" }).returning();
    const before = (await events()).length;
    const [binding] = await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: agentId, configPath: "env.FIXTURE" }).returning();
    await db.update(companySecretBindings).set({ versionSelector: "2" }).where(eq(companySecretBindings.id, binding.id));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.id, binding.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agentId, agentId, agentId]);
  });
  it("allows an agent configuration save to finish while a connector refresh waits on that agent", async () => {
    const higher = [agentId, peerId].sort().at(-1)!;
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "concurrent", name: "Concurrent fixture" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: higher, configPath: "env.FIXTURE" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const agentLocked = new Promise<void>(resolve => { locked = resolve; });
    const maySave = new Promise<void>(resolve => { resume = resolve; });
    const connectorStarted = new Promise<number>(resolve => { started = resolve; });
    const save = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(agents).where(eq(agents.id, higher)).for("update");
      locked(); await maySave;
      await updateAgentConfigurationInTransaction(tx as unknown as Db, higher, { adapterConfig: { env: {} } });
    });
    await agentLocked;
    const connector = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId));
    });
    try {
      const pid = await connectorStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await Promise.all([save, connector]); }
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, higher))).toEqual([]);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].enabled).toBe(false);
  }, 15000);
  it("ignores Vercel verification timestamps while retaining credential changes", async () => {
    const credential = { provider: "vercel_connect" as const, subjectType: "user" as const, subjectId: "alice", tokenId: "fixture-token", expiresAt: "2099-01-01T00:00:00.000Z", lastVerifiedAt: "2000-01-01T00:00:00.000Z" };
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", externalCredential: credential }).returning();
    const before = await events();
    await db.update(connectionGrants).set({ externalCredential: { ...credential, lastVerifiedAt: "2000-01-02T00:00:00.000Z" } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toEqual(before);
    await db.update(connectionGrants).set({ externalCredential: { ...credential, tokenId: "rotated-fixture-token" } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before.length + 2);
  });
  it("ignores GitHub webhook health while retaining repository access changes", async () => {
    const github = { userId: "fixture-user", login: "fixture", installationCount: 1, repositoryCount: 1, repositorySelection: "selected" as const, installationIds: ["1"], installationOwnerLogins: ["fixture"], accessRevision: "initial", lastWebhookAt: "2000-01-01T00:00:00.000Z", webhookHealth: "pending" as const };
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", providerTenant: { github } }).returning();
    const before = await events();
    await db.update(connectionGrants).set({ providerTenant: { github: { ...github, lastWebhookAt: "2000-01-02T00:00:00.000Z", webhookHealth: "healthy" } } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toEqual(before);
    await db.update(connectionGrants).set({ providerTenant: { github: { ...github, accessRevision: "changed", repositoryCount: 0, repositorySelection: "none", installationIds: [] } } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before.length + 2);
  });
  it("ignores OAuth grant lease acquisition and release while retaining access changes", async () => {
    const oauth = { scopes: ["read"], tokenEndpoint: "https://oauth.example.test/token" };
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", providerTenant: { oauth } }).returning();
    const before = await events();
    await db.update(connectionGrants).set({ providerTenant: { oauth: { ...oauth, refreshLease: { id: "fixture-lease", expiresAt: "2099-01-01T00:00:00.000Z" } } } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toEqual(before);
    await db.update(connectionGrants).set({ providerTenant: { oauth } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toEqual(before);
    await db.update(connectionGrants).set({ providerTenant: { oauth: { ...oauth, scopes: ["read", "write"] } } }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before.length + 2);
  });
  it("releases removal agent locks when a concurrent credential writer holds the secret", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "busy-delete", name: "Busy deletion fixture", status: "deleted" }).returning();
    await db.update(toolConnections).set({ credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).where(eq(toolConnections.id, connectionId));
    let locked!: () => void; let resume!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayWrite = new Promise<void>(resolve => { resume = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(companySecrets).where(eq(companySecrets.id, secret.id)).for("no key update");
      locked(); await mayWrite;
      await tx.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
    });
    await held;
    let result: PromiseSettledResult<unknown> | undefined;
    const removal = Promise.allSettled([secretService(db).remove(secret.id)]).then(rows => { result = rows[0]; });
    try {
      await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 5000 });
      expect(result).toMatchObject({ status: "rejected", reason: { status: 409, details: { retryable: true } } });
    } finally { resume(); await writer; await removal; }
    const [remaining] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(remaining.latestVersion).toBe(2);
    await expect(secretService(db).remove(secret.id)).resolves.toMatchObject({ id: secret.id });
  }, 15000);
  it("orders secret deletion before cascading bindings against agent configuration saves", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "delete-bound", name: "Deletion fixture" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: agentId, configPath: "env.FIXTURE" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const maySave = new Promise<void>(resolve => { resume = resolve; });
    const deletionStarted = new Promise<number>(resolve => { started = resolve; });
    const save = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
      locked(); await maySave;
      return updateAgentConfigurationInTransaction(tx as unknown as Db, agentId, { adapterConfig: { env: {} } });
    });
    await held;
    const deletion = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return secretService(tx as unknown as Db).remove(secret.id);
    });
    const completed = Promise.allSettled([save, deletion]);
    try {
      const pid = await deletionStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    const results = await completed;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual([]);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.secretId, secret.id))).toEqual([]);
  }, 15000);
  it("captures grant revocation and referenced credential rotation without storing credentials in events", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "fixture", name: "Fixture secret" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).returning();
    const before = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
    expect(await events()).toHaveLength(before + 2);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before + 4);
    expect(Object.keys((await events()).at(-1)!).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
    const unrelated = await db.insert(companySecrets).values({ companyId, key: "unrelated", name: "Unrelated" }).returning();
    const unchanged = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, unrelated[0].id));
    expect(await events()).toHaveLength(unchanged);
  });

});
