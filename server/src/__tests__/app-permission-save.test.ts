import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, toolApplications, toolCatalogEntries,
  toolConnections, toolConnectionInstalls, toolPolicies, toolProfileBindings, toolProfileEntries,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("app permission saves", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("app-permission-save-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(toolCount = 3) {
    const [company] = await db.insert(companies).values({ name: "App permissions", issuePrefix: `AP${randomUUID().slice(0, 6)}` }).returning();
    const roster = await db.insert(agents).values(Array.from({ length: 4 }, (_, i) => ({ companyId: company.id, name: `Agent ${i}` }))).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "App", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
      uid: randomUUID(), name: "App connection", transport: "mcp_remote", status: "active", enabled: true,
      config: { url: "https://example.com/mcp" } }).returning();
    const catalog = await db.insert(toolCatalogEntries).values(Array.from({ length: toolCount }, (_, i) => ({
      companyId: company.id, applicationId: application.id, connectionId: connection.id,
      name: `action_${i}`, toolName: `action_${i}`, riskLevel: i === 0 ? "read" as const : "write" as const,
      status: "active" as const, versionHash: `v${i}`, schemaHash: `s${i}`,
    }))).returning();
    const service = toolAccessService(db);
    const save = (agentIds: string[], enabledIds = catalog.map(entry => entry.id), askIds = catalog.slice(1).map(entry => entry.id)) =>
      service.finishGalleryAppConnection(company.id, connection.id, {
        enabledCatalogEntryIds: enabledIds, askFirstCatalogEntryIds: askIds, access: { agentIds },
      });
    return { company, roster, connection, catalog, service, save };
  }

  it("adds an agent without rewriting unchanged action policies or bindings, including retired rules", async () => {
    const f = await fixture(100);
    const initial = await f.save(f.roster.slice(0, 3).map(agent => agent.id));
    await db.insert(toolPolicies).values(Array.from({ length: 500 }, (_, i) => ({
      companyId: f.company.id, name: `Retired ${i}`, policyType: "require_approval" as const, enabled: false,
      config: { source: "app_gallery_finish", connectionId: f.connection.id, catalogEntryId: randomUUID() },
    })));
    const queries: string[] = [];
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    const timings: number[] = [];
    let result = initial;
    try {
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        result = await f.save(f.roster.map(agent => agent.id));
        timings.push(performance.now() - started);
      }
    } finally {
      db.$client.options.debug = previousDebug;
    }
    const policyWrites = queries.filter(query => /^(insert into|update|delete from) "tool_policies"/i.test(query));
    console.info("app agent-access save", { timingsMs: timings.map(n => Math.round(n)), queries: queries.length, policyWrites: policyWrites.length });
    expect(policyWrites).toHaveLength(0);
    expect(result.profileBindings.map(binding => binding.targetId).sort()).toEqual(f.roster.map(agent => agent.id).sort());
    for (const binding of initial.profileBindings) expect(result.profileBindings).toContainEqual(binding);
    expect(result.profileEntries).toEqual(initial.profileEntries);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...result.policies].sort(byId)).toEqual([...initial.policies].sort(byId));
  });

  it("applies Allowed, Ask first, and Off to newly added agents and preserves other approval policies", async () => {
    const f = await fixture();
    const [allowed, ask, off] = f.catalog;
    const enabledIds = [allowed.id, ask.id];
    await f.save([f.roster[0].id], enabledIds, [ask.id]);
    await f.save([f.roster[0].id, f.roster[1].id], enabledIds, [ask.id]);
    const policy = toolAccessPolicyService(db);
    const decision = (catalogEntry: typeof allowed, agentId = f.roster[1].id) => policy.decide({
      companyId: f.company.id, actor: { actorType: "agent", actorId: agentId, agentId },
      request: { connectionId: f.connection.id, catalogEntryId: catalogEntry.id, toolName: catalogEntry.toolName, arguments: {} },
    });
    expect(await decision(allowed)).toMatchObject({ allowed: true });
    expect(await decision(ask)).toMatchObject({ decision: "require_approval" });
    expect(await decision(off)).toMatchObject({ decision: "deny" });
    expect(await decision(allowed, f.roster[2].id)).toMatchObject({ decision: "deny" });
    const [separatePolicy] = await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Separate approval rule",
      policyType: "require_approval", priority: 0, selectors: { catalogEntryId: allowed.id }, config: { source: "operator" } }).returning();
    await f.save(f.roster.slice(0, 2).map(agent => agent.id), enabledIds, []);
    expect(await decision(ask)).toMatchObject({ allowed: true });
    expect(await decision(allowed)).toMatchObject({ decision: "require_approval", matchedPolicyIds: [separatePolicy.id] });
    const managedPolicies = await db.select().from(toolPolicies).where(and(eq(toolPolicies.companyId, f.company.id), eq(toolPolicies.enabled, true)));
    expect(managedPolicies.map(row => row.id)).toEqual([separatePolicy.id]);
    const [profileBinding] = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetId, f.roster[1].id));
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profileBinding.profileId))).toHaveLength(2);
  });

  it("batches policy changes and keeps other apps, companies, and policy settings intact", async () => {
    const f = await fixture(30);
    const other = await fixture();
    const otherResult = await other.save([other.roster[0].id]);
    const [otherConnection] = await db.insert(toolConnections).values({
      companyId: f.company.id, applicationId: f.connection.applicationId,
      uid: randomUUID(), name: "Other connection", transport: "mcp_remote", status: "active", enabled: true,
    }).returning();
    const [otherPolicy] = await db.insert(toolPolicies).values({
      companyId: f.company.id, name: "Other app policy", policyType: "require_approval",
      config: { source: "app_gallery_finish", connectionId: otherConnection.id, catalogEntryId: randomUUID() },
    }).returning();
    const initial = await f.save([f.roster[0].id]);
    const original = initial.policies[0];
    await db.update(toolPolicies).set({ priority: 17, conditions: { actorType: "agent" }, createdByUserId: "original-owner" })
      .where(eq(toolPolicies.id, original.id));
    const queries: string[] = [];
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    try {
      await f.save([f.roster[0].id], f.catalog.map(entry => entry.id), []);
      expect(queries.filter(query => /^update "tool_policies"/i.test(query))).toHaveLength(1);
      expect(queries.filter(query => /^insert into "tool_policies"/i.test(query))).toHaveLength(0);
      queries.length = 0;
      const restored = await f.save([f.roster[0].id]);
      expect(queries.filter(query => /^insert into "tool_policies"/i.test(query))).toHaveLength(1);
      expect(restored.policies.find(policy => policy.id === original.id)).toMatchObject({
        enabled: true, priority: 17, conditions: { actorType: "agent" }, createdByUserId: "original-owner", createdAt: original.createdAt,
      });
    } finally {
      db.$client.options.debug = previousDebug;
    }
    expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, otherPolicy.id)))[0]).toEqual(otherPolicy);
    expect(await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, other.company.id)))
      .toEqual(otherResult.policies);
  });

  it("preserves additive access and removes bindings and actions when access is replaced", async () => {
    const f = await fixture();
    const [first, second] = f.catalog;
    const initial = await f.save([f.roster[0].id], [first.id], [first.id]);
    const additive = await f.service.finishGalleryAppConnection(f.company.id, f.connection.id, {
      access: { agentIds: [f.roster[1].id] }, enabledCatalogEntryIds: [second.id],
      askFirstCatalogEntryIds: [second.id], preserveExistingAccess: true,
    });
    expect(additive.profileBindings).toEqual(expect.arrayContaining(initial.profileBindings));
    expect(additive.profileEntries).toEqual(expect.arrayContaining(initial.profileEntries));
    expect((await db.select().from(toolPolicies).where(and(
      eq(toolPolicies.companyId, f.company.id), eq(toolPolicies.enabled, true),
    )))).toHaveLength(2);
    const replaced = await f.save([f.roster[1].id], [second.id], []);
    expect(replaced.profileBindings).toEqual(additive.profileBindings.filter(binding => binding.targetId === f.roster[1].id));
    expect(replaced.profileEntries).toEqual(additive.profileEntries.filter(entry => entry.catalogEntryId === second.id));
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id)))
      .toMatchObject([{ targetType: "agent", targetId: f.roster[1].id }]);
    const empty = await f.save([], [], []);
    expect(empty.profileBindings).toEqual([]);
    expect(empty.profileEntries).toEqual([]);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id))).toEqual([]);
  });

});
