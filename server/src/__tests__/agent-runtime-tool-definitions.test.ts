import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, plugins, toolApplications, toolConnections, toolCatalogEntries, toolProfiles, toolProfileEntries, toolProfileBindings, toolPolicies, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("tool definition runtime synchronization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  let peerId: string;
  let pluginId: string;
  let applicationId: string;
  let connectionId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-definitions-"); db = createDb(database.connectionString); }, 90_000);
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

  it("captures settings and removal while ignoring health bookkeeping and empty writes", async () => {
    const before = (await events()).length;
    await db.update(toolConnections).set({ healthCheckedAt: new Date(), lastHealthAt: new Date(), lastError: "fixture", updatedAt: new Date() }).where(eq(toolConnections.id, connectionId));
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, randomUUID()));
    expect(await events()).toHaveLength(before);
    await db.update(toolConnections).set({ config: { endpoint: "https://mcp.example.test/mcp" }, enabled: false }).where(eq(toolConnections.id, connectionId));
    expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual([agentId, peerId].sort());
    const changed = (await events()).length;
    await db.delete(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(await events()).toHaveLength(changed + 2);
  });
  it("batches catalog refresh fanout once per company per statement", async () => {
    const before = (await events()).length;
    await db.insert(toolCatalogEntries).values(Array.from({ length: 250 }, (_, index) => ({ companyId, applicationId, connectionId, name: `tool-${index}`, toolName: `tool-${index}`, versionHash: `fixture-${index}` })));
    expect(await events()).toHaveLength(before + 2);
    await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(eq(toolCatalogEntries.connectionId, connectionId));
    expect(await events()).toHaveLength(before + 4);
  });
  it("does not invalidate runtime inputs when a real health probe records failure", async () => {
    const before = await events();
    await expect(toolAccessService(db).checkHealth(connectionId)).rejects.toThrow();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(connection.healthStatus).not.toBe("unknown");
    expect(connection.healthCheckedAt).not.toBeNull();
    expect(await events()).toEqual(before);
  });
  it.each([250, 2500])("batches a real %i-tool catalog refresh and ignores unchanged rediscovery", async count => {
    const tools = Array.from({ length: count }, (_, index) => ({ name: `search_${index}`, description: "Search fixture records", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }));
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    const service = toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }), { headers: { "content-type": "application/json" } });
      },
    });
    const before = (await events()).length;
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    const after = (await events()).length;
    expect(after - before).toBeGreaterThanOrEqual(2);
    expect(after - before).toBeLessThanOrEqual(count === 250 ? 12 : 24);
    const first = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect((await service.refreshCatalog(connectionId)).catalog).toHaveLength(count);
    expect(await events()).toHaveLength(after);
    const second = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connectionId)).orderBy(toolCatalogEntries.toolName);
    expect(second.map(row => [row.id, row.firstSeenAt, row.status])).toEqual(first.map(row => [row.id, row.firstSeenAt, row.status]));
  });
  it.each(["catalog refresh", "profile edit", "policy edit"] as const)("serializes %s with action finalization before runtime locks", async change => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    let description = "Initial search";
    const options = {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      remoteHttpRequest: async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "search", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } }), { headers: { "content-type": "application/json" } });
      },
    };
    await toolAccessService(db, options).refreshCatalog(connectionId);
    const [entry] = await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(eq(toolCatalogEntries.connectionId, connectionId)).returning();
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connectionId}`)));
    const [policy] = change === "policy edit" ? await db.insert(toolPolicies).values({ companyId, name: "Managed search review", policyType: "require_approval", selectors: { catalogEntryId: entry.id }, config: { source: "app_gallery_finish", connectionId, catalogEntryId: entry.id } }).returning() : [];
    if (change === "catalog refresh") description = "Changed search";
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (service: ReturnType<typeof toolAccessService>, policies: ReturnType<typeof toolAccessPolicyService>) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(toolAccessService(tx as unknown as Db, options), toolAccessPolicyService(tx as unknown as Db));
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const finish = run(writer => writer.finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: change === "policy edit" ? [entry.id] : [], reviewedCatalogEntryIds: [entry.id], access: "all_agents" }));
    let refresh: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      refresh = run((writer, policies) => change === "catalog refresh" ? writer.refreshCatalog(connectionId)
        : change === "profile edit" ? writer.updateProfile(profile.id, { description: "Edited concurrently" })
        : policies.updatePolicy({ companyId, policyId: policy!.id, body: { description: "Edited concurrently", config: null } }));
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([finish, refresh]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [updated] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, entry.id));
    expect(updated).toMatchObject({ status: "active", description });
    if (change === "profile edit") expect((await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id)))[0].description).toBe("Edited concurrently");
    if (change === "policy edit") expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, policy!.id)))[0].description).toBe("Edited concurrently");
  }, 15000);
  it("orders managed policy reorder with install saves by policy ID", async () => {
    await db.update(toolConnections).set({ config: { mcpAgentAccessConfigured: true } }).where(eq(toolConnections.id, connectionId));
    await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connectionId}`, name: "Install profile" });
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    await db.insert(toolPolicies).values([higher, lower].map((id, index) => ({ id, companyId, name: `Managed policy ${index}`, policyType: "require_approval", priority: (index + 1) * 100, config: { source: "app_gallery_finish", connectionId } })));
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolPolicies).where(eq(toolPolicies.id, lower)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>, sequentialScan = false) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      if (sequentialScan) {
        await tx.execute(sql`SET LOCAL enable_indexscan = off`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      }
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const install = run(client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: peerId }] }));
    let reorder: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      reorder = run(client => toolAccessPolicyService(client).reorderPolicies(companyId, { policyIds: [lower, higher] }), true);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([install, reorder]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await toolAccessPolicyService(db).listPolicies(companyId)).map(policy => [policy.id, policy.priority])).toEqual([[lower, 100], [higher, 200]]);
    expect((await toolAccessService(db).listConnectionInstalls(connectionId, companyId)).map(install => install.targetId)).toEqual([peerId]);
  }, 15000);
  it("ignores real trust-rule hits while retaining meaningful rule changes", async () => {
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId, applicationId, connectionId, name: "Search", toolName: "search", versionHash: "fixture" }).returning();
    const [rule] = await db.insert(toolPolicies).values({ companyId, name: "Trusted search", policyType: "trust_rule", selectors: { agentId, connectionId, toolName: "search" }, config: { trustRule: { hitCount: 0 } } }).returning();
    const before = await events();
    const decision = await toolAccessPolicyService(db).decide({ companyId, actor: { actorType: "agent", actorId: agentId, agentId }, request: { connectionId, catalogEntryId: entry.id, toolName: "search", arguments: {} }, consumeRateLimit: true });
    expect(decision).toMatchObject({ allowed: true, reasonCode: "allow_trust_rule" });
    const [used] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, rule.id));
    expect(used.config).toMatchObject({ trustRule: { hitCount: 1, lastHitAt: expect.any(String) } });
    expect(await events()).toEqual(before);
    await db.update(toolPolicies).set({ config: { ...used.config, trustRule: { ...(used.config?.trustRule as object), revokedAt: new Date().toISOString() } } }).where(eq(toolPolicies.id, rule.id));
    expect((await events()).slice(before.length).map(row => row.resourceId)).toEqual([agentId]);
  });
  it.each(["profile entry add", "profile entry edit", "profile entry delete", "profile replacement"] as const)("orders %s before action finalization and runtime fanout", async change => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    let description = "Initial search";
    const options = {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      remoteHttpRequest: async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "search", description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } }), { headers: { "content-type": "application/json" } });
      },
    };
    await toolAccessService(db, options).refreshCatalog(connectionId);
    const [entry] = await db.update(toolCatalogEntries).set({ status: "quarantined" }).where(eq(toolCatalogEntries.connectionId, connectionId)).returning();
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connectionId}`)));
    const [profileEntry] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (service: ReturnType<typeof toolAccessService>, policies: ReturnType<typeof toolAccessPolicyService>) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(toolAccessService(tx as unknown as Db, options), toolAccessPolicyService(tx as unknown as Db));
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const mutation = run(writer => change === "profile entry add"
      ? writer.addProfileEntry(profile.id, { selectorType: "catalog_entry", catalogEntryId: entry.id, connectionId, applicationId })
      : change === "profile entry edit" ? writer.updateProfileEntry(profileEntry.id, { effect: "exclude" })
      : change === "profile entry delete" ? writer.deleteProfileEntry(profileEntry.id)
      : writer.updateProfile(profile.id, { entries: [{ selectorType: "catalog_entry", catalogEntryId: entry.id, connectionId, applicationId }] }));
    const mutationResult = Promise.allSettled([mutation]);
    let finishResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await waitForLock(0);
      finishResult = Promise.allSettled([run(writer => writer.finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: [], reviewedCatalogEntryIds: [entry.id], access: "all_agents" }))]);
      await waitForLock(1);
    } finally { release(); await blocker; }
    for (const result of [...await mutationResult, ...await finishResult!]) if (result.status === "rejected") throw result.reason;
    const [updated] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, entry.id));
    expect(updated).toMatchObject({ status: "active", description });
  }, 15000);

  it("orders connection removal before setup finalization and runtime fanout", async () => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connectionId}`, name: "Removal fixture" }).returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", connectionId, applicationId });
    const single = createDb(database.connectionString, { maxConnections: 1 });
    await single.execute(sql`SET lock_timeout = '8s'`);
    const [removalPid] = await single.execute(sql`SELECT pg_backend_pid() AS pid`);
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    let removal: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const waitForLock = (pid: number) => vi.waitFor(async () => {
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    let finishPid: number | undefined;
    let finish: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      try {
        finish = Promise.allSettled([db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
          const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          finishPid = Number(row.pid);
          return toolAccessService(tx as unknown as Db).finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" });
        })]);
        await vi.waitFor(() => expect(finishPid).toBeDefined(), { timeout: 5000 });
        await waitForLock(finishPid!);
        removal = Promise.allSettled([toolAccessService(single).archiveConnection(connectionId, companyId)]);
        await waitForLock(Number(removalPid.pid));
      } finally { release(); await blocker; }
      for (const result of [...await removal!, ...await finish!]) if (result.status === "rejected") throw result.reason;
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].status).toBe("archived");
    } finally { release(); await blocker; await finish; await removal; await single.$client.end({ timeout: 1 }); }
  }, 15000);

  it.each(["add", "edit", "delete", "replace"] as const)("completes profile entry %s with a single database connection", async change => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "single-entry", name: "Single entry" }).returning();
    const input = { selectorType: "connection" as const, applicationId, connectionId };
    const [entry] = await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, ...input }).returning();
    const single = createDb(database.connectionString, { maxConnections: 1 });
    const service = toolAccessService(single);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = change === "add" ? service.addProfileEntry(profile.id, input)
      : change === "edit" ? service.updateProfileEntry(entry.id, { effect: "exclude" })
        : change === "delete" ? service.deleteProfileEntry(entry.id)
          : service.updateProfile(profile.id, { entries: [{ ...input, effect: "exclude" }] });
    const settled = Promise.allSettled([work]);
    try {
      await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Profile entry waited for another pooled connection")), 3000); })]);
      const rows = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
      expect(rows).toHaveLength(change === "delete" ? 0 : change === "add" ? 2 : 1);
      if (change === "edit" || change === "replace") expect(rows[0].effect).toBe("exclude");
    } finally { clearTimeout(timer); await single.$client.end({ timeout: 1 }); await settled; }
  }, 10000);

  it.each(["entry", "policy"] as const)("keeps repeated single-agent %s changes scoped and atomic", async change => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "scoped", name: "Scoped" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    const [entry] = await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", connectionId }).returning();
    const [policy] = await db.insert(toolPolicies).values({ companyId, name: "Scoped", policyType: "deny", selectors: { agentId } }).returning();
    for (let index = 0; index < 4; index++) {
      const before = (await events()).length;
      if (change === "entry") await db.update(toolProfileEntries).set({ effect: index % 2 ? "include" : "exclude" }).where(eq(toolProfileEntries.id, entry.id));
      else await db.update(toolPolicies).set({ description: `Edit ${index}` }).where(eq(toolPolicies.id, policy.id));
      expect((await events()).slice(before).map(row => row.resourceId)).toEqual([agentId]);
    }
    const before = await events();
    await expect(db.transaction(async tx => {
      await tx.update(toolPolicies).set({ description: "Rolled back" }).where(eq(toolPolicies.id, policy.id));
      await tx.update(toolProfileEntries).set({ effect: "exclude" }).where(eq(toolProfileEntries.id, entry.id));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toEqual(before);
  });

  it("uses old and new policy selectors with the execution match semantics", async () => {
    const [policy] = await db.insert(toolPolicies).values({ companyId, name: "Retarget", policyType: "deny", selectors: { agentId } }).returning();
    const write = async (selectors: Record<string, unknown>, expected: string[]) => {
      const before = (await events()).length;
      await db.update(toolPolicies).set({ selectors }).where(eq(toolPolicies.id, policy.id));
      expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual(expected.sort());
    };
    await write({ agentId: peerId }, [agentId, peerId]);
    await write({ agentIds: [agentId] }, [agentId, peerId]);
    await write({ agentId, agentIds: [peerId] }, [agentId]);
    await write({ agentIds: ` ${peerId} ` }, [peerId]);
    await write({ agentIds: [" ", null, agentId] }, [agentId, peerId]);
    const whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    await write({ agentIds: `${whitespace}${peerId}${whitespace}` }, [agentId, peerId]);
    await write({ agentIds: [whitespace] }, [agentId, peerId]);
    await write({ agentIds: [`${whitespace}${peerId}${whitespace}`] }, [agentId, peerId]);
    await write({ agentIds: [agentId] }, [agentId]);
    await write({ agentId: randomUUID() }, [agentId]);
    await write({ agentIds: [] }, [agentId, peerId]);
    await write({ agentId: "invalid" }, [agentId, peerId]);
    const before = (await events()).length;
    await db.delete(toolPolicies).where(eq(toolPolicies.id, policy.id));
    expect(await events()).toHaveLength(before);
  });

  it("uses both profile-entry parents and skips profiles outside standing assignments", async () => {
    const profiles = await db.insert(toolProfiles).values(["first", "second", "unassigned"].map(profileKey => ({ companyId, profileKey, name: profileKey }))).returning();
    await db.insert(toolProfileBindings).values([
      { companyId, profileId: profiles[0].id, targetType: "agent", targetId: agentId },
      { companyId, profileId: profiles[1].id, targetType: "agent", targetId: peerId },
      { companyId, profileId: profiles[2].id, targetType: "project", targetId: randomUUID() },
    ]);
    const [entry] = await db.insert(toolProfileEntries).values({ companyId, profileId: profiles[0].id, selectorType: "connection", connectionId }).returning();
    let before = (await events()).length;
    await db.update(toolProfileEntries).set({ profileId: profiles[1].id }).where(eq(toolProfileEntries.id, entry.id));
    expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual([agentId, peerId].sort());
    before = (await events()).length;
    await db.update(toolProfileEntries).set({ profileId: profiles[2].id }).where(eq(toolProfileEntries.id, entry.id));
    expect((await events()).slice(before).map(row => row.resourceId)).toEqual([peerId]);
    before = (await events()).length;
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, entry.id));
    expect(await events()).toHaveLength(before);
  });

  it("coalesces scoped definitions and preserves explicit company recipients", async () => {
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "coalesced", name: "Coalesced" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    const [entry] = await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", connectionId }).returning();
    const [policy] = await db.insert(toolPolicies).values({ companyId, name: "Coalesced", policyType: "deny", selectors: { agentId } }).returning();
    let before = (await events()).length;
    await db.transaction(async tx => {
      await tx.update(toolProfileEntries).set({ effect: "exclude" }).where(eq(toolProfileEntries.id, entry.id));
      await tx.update(toolPolicies).set({ description: "Scoped" }).where(eq(toolPolicies.id, policy.id));
    });
    expect((await events()).slice(before).map(row => row.resourceId)).toEqual([agentId]);
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
    before = (await events()).length;
    await db.transaction(async tx => {
      await tx.update(toolProfileEntries).set({ effect: "include" }).where(eq(toolProfileEntries.id, entry.id));
      await tx.update(toolPolicies).set({ description: "Company" }).where(eq(toolPolicies.id, policy.id));
    });
    expect((await events()).slice(before).map(row => row.resourceId).sort()).toEqual([agentId, peerId].sort());
  });

  it("orders scoped policy reorder before company agent fanout", async () => {
    const [lower, higher] = [agentId, peerId].sort();
    const policies = await db.insert(toolPolicies).values([higher, lower].map((target, index) => ({ companyId, name: `Scoped ${index}`, policyType: "deny", priority: (index + 5) * 100, selectors: { agentId: target } }))).returning();
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
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
    const settings = Promise.allSettled([run(client => client.update(toolConnections).set({ name: "Settings race" }).where(eq(toolConnections.id, connectionId)))]);
    let reorder: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await waitForLock(0);
      reorder = Promise.allSettled([run(client => toolAccessPolicyService(client).reorderPolicies(companyId, { policyIds: policies.map(row => row.id) }))]);
      await waitForLock(1);
    } finally { release(); await blocker; }
    for (const result of [...await settings, ...await reorder!]) if (result.status === "rejected") throw result.reason;
    expect((await toolAccessPolicyService(db).listPolicies(companyId)).map(row => row.id)).toEqual(policies.map(row => row.id));
  }, 15000);

  it("locks old profile references before replacement and application deletion", async () => {
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Old application", type: "mcp_http" }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "old-reference", name: "Old reference" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "application", applicationId: application.id });
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (service: ReturnType<typeof toolAccessService>) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(toolAccessService(tx as unknown as Db));
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const replacement = Promise.allSettled([run(service => service.updateProfile(profile.id, { name: "Replacement", entries: [] }))]);
    let deletion: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await waitForLock(0);
      deletion = Promise.allSettled([run(service => service.deleteApplication(application.id))]);
      await waitForLock(1);
    } finally { release(); await blocker; }
    for (const result of [...await replacement, ...await deletion!]) if (result.status === "rejected") throw result.reason;
    expect(await db.select().from(toolApplications).where(eq(toolApplications.id, application.id))).toHaveLength(0);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toHaveLength(0);
    expect((await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id)))[0].name).toBe("Replacement");
  }, 15000);

  it("retries changed old references before taking profile runtime locks", async () => {
    const [oldApp, newApp] = await db.insert(toolApplications).values(["Old retry app", "New retry app"].map(name => ({ companyId, name, type: "mcp_http" }))).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "retry-references", name: "Retry references" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: agentId });
    const [entry] = await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "application", applicationId: oldApp.id }).returning();
    const single = createDb(database.connectionString, { maxConnections: 1 });
    await single.execute(sql`SET lock_timeout = '8s'`);
    const [replacementPid] = await single.execute(sql`SELECT pg_backend_pid() AS pid`);
    let refLocked!: () => void; let releaseRef!: () => void;
    const refsHeld = new Promise<void>(resolve => { refLocked = resolve; });
    const refsResume = new Promise<void>(resolve => { releaseRef = resolve; });
    const refBlocker = db.transaction(async tx => {
      await tx.select().from(toolApplications).where(eq(toolApplications.id, oldApp.id)).for("update");
      refLocked(); await refsResume;
    });
    await refsHeld;
    const replacement = Promise.allSettled([toolAccessService(single).updateProfile(profile.id, { name: "Retried replacement", entries: [] })]);
    const waitForLock = (pid: number, query?: string) => vi.waitFor(async () => {
      const [row] = await db.execute(sql`SELECT wait_event_type, query FROM pg_stat_activity WHERE pid = ${pid}`);
      expect(row.wait_event_type).toBe("Lock");
      if (query) expect(row.query).toContain(query);
    }, { timeout: 5000 });
    let agentBlocker: Promise<unknown> | undefined; let releaseAgent: (() => void) | undefined;
    let deletion: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let deletionPid: number | undefined;
    try {
      await waitForLock(Number(replacementPid.pid));
      await toolAccessService(db).updateProfileEntry(entry.id, { applicationId: newApp.id });
      await toolAccessService(db).updateProfile(profile.id, { description: "Concurrent description" });
      let agentLocked!: () => void;
      const agentHeld = new Promise<void>(resolve => { agentLocked = resolve; });
      const agentResume = new Promise<void>(resolve => { releaseAgent = resolve; });
      agentBlocker = db.transaction(async tx => {
        await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
        agentLocked(); await agentResume;
      });
      await agentHeld;
      releaseRef(); await refBlocker;
      await waitForLock(Number(replacementPid.pid), 'update "tool_profiles"');
      deletion = Promise.allSettled([db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
        const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        deletionPid = Number(row.pid);
        return toolAccessService(tx as unknown as Db).deleteApplication(newApp.id);
      })]);
      await vi.waitFor(() => expect(deletionPid).toBeDefined(), { timeout: 5000 });
      await waitForLock(deletionPid!);
      releaseAgent!(); await agentBlocker;
      for (const result of [...await replacement, ...await deletion]) if (result.status === "rejected") throw result.reason;
      expect((await db.select().from(toolProfiles).where(eq(toolProfiles.id, profile.id)))[0]).toMatchObject({ name: "Retried replacement", description: "Concurrent description" });
      expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id))).toHaveLength(0);
      expect(await db.select().from(toolApplications).where(eq(toolApplications.id, newApp.id))).toHaveLength(0);
    } finally {
      releaseRef(); releaseAgent?.(); await refBlocker; await agentBlocker; await replacement; await deletion;
      await single.$client.end({ timeout: 1 });
    }
  }, 20000);

  it("journals application and connection configuration", async () => {
    const before = (await events()).length;
    await db.update(toolApplications).set({ name: "Changed application" }).where(eq(toolApplications.id, applicationId));
    await db.update(toolConnections).set({ config: { endpoint: "fixture" } }).where(eq(toolConnections.id, connectionId));
    expect(await events()).toHaveLength(before + 4);
  });

});
