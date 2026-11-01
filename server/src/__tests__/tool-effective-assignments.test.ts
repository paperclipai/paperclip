import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, toolApplications, toolCatalogEntries,
  toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles, type Db,
} from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { toolAccessService } from "../services/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("effective tool assignments", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("effective-tool-assignments-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Assignments", issuePrefix: `AT${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Assigned agent" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Fixture app", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
      name: "Fixture connection", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true }).returning();
    const payload = "schema payload ".repeat(4096);
    const entries = await db.insert(toolCatalogEntries).values([
      { name: "read_item", riskLevel: "read" as const },
      { name: "write_item", riskLevel: "write" as const },
      { name: "removed_item", riskLevel: "read" as const, status: "removed" as const },
    ].map(entry => ({ companyId: company.id, applicationId: application.id, connectionId: connection.id,
      ...entry, toolName: entry.name, versionHash: entry.name, inputSchema: { type: "object", description: payload },
      outputSchema: { description: payload }, annotations: { description: payload },
      firstSeenAt: new Date(Date.now() - 86_400_000) }))).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: "fixture", name: "Fixture", defaultAction: "deny" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const [read, write, removed] = entries;
    return { company, agent, application, connection, profile, read, write, removed };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>) {
    const service = toolAccessService(db);
    const full = await service.getEffectiveProfilesForAgent(f.company.id, f.agent.id);
    const assignments = await service.getEffectiveToolAssignmentsForAgent(f.company.id, f.agent.id);
    expect(assignments).toEqual({ ...full, allowedTools: full.allowedTools.map(
      ({ id, applicationId, connectionId, toolName }) => ({ id, applicationId, connectionId, toolName }),
    ) });
    const connections = await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id]);
    expect(connections).toEqual({
      installedConnections: full.installedConnections,
      allowedConnectionIds: [...new Set(full.allowedTools.filter(tool => tool.connectionId === f.connection.id).map(tool => tool.connectionId))],
    });
    return { service, full, assignments };
  }

  it.each(["application", "connection", "catalog_entry", "tool_name", "risk_level"] as const)("preserves %s selectors and exclusions", async selectorType => {
    const f = await fixture();
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id, selectorType, effect: "include",
      ...(selectorType === "application" ? { applicationId: f.application.id } : {}),
      ...(selectorType === "connection" ? { connectionId: f.connection.id } : {}),
      ...(selectorType === "catalog_entry" ? { catalogEntryId: f.read.id } : {}),
      ...(selectorType === "tool_name" ? { toolName: f.read.toolName } : {}),
      ...(selectorType === "risk_level" ? { riskLevel: "read" as const } : {}),
    });
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id,
      selectorType: "catalog_entry", effect: "exclude", catalogEntryId: f.write.id });
    const { full, assignments } = await compare(f);
    expect(assignments.allowedTools.map(tool => tool.id)).toEqual([f.read.id]);
    expect(full.allowedTools[0].inputSchema).toEqual(f.read.inputSchema);
    expect(full.allowedTools[0].outputSchema).toEqual(f.read.outputSchema);
    expect(full.allowedTools[0].annotations).toEqual(f.read.annotations);
  });

  it("keeps unresolved exact names and observes changed catalog, profile and binding state", async () => {
    const f = await fixture();
    await db.insert(toolProfileEntries).values([
      { companyId: f.company.id, profileId: f.profile.id, selectorType: "risk_level", effect: "include", riskLevel: "read" },
      { companyId: f.company.id, profileId: f.profile.id, selectorType: "tool_name", effect: "include", toolName: "not_discovered_yet" },
    ]);
    expect((await compare(f)).assignments.allowedToolNames).toEqual(["not_discovered_yet", "read_item"]);
    await db.update(toolCatalogEntries).set({ riskLevel: "write" }).where(eq(toolCatalogEntries.id, f.read.id));
    expect((await compare(f)).assignments.allowedTools).toEqual([]);
    await db.update(toolProfiles).set({ status: "archived" }).where(eq(toolProfiles.id, f.profile.id));
    expect((await compare(f)).assignments.profiles).toEqual([]);
    await db.update(toolProfiles).set({ status: "active", defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    expect((await compare(f)).assignments.allowedTools.map(tool => tool.id)).toEqual([f.read.id, f.write.id]);
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    expect((await compare(f)).assignments.allowedTools).toEqual([]);
  });

  it("preserves company bindings and rejects an agent from another company", async () => {
    const f = await fixture();
    await db.update(toolProfileBindings).set({ targetType: "company", targetId: f.company.id }).where(eq(toolProfileBindings.profileId, f.profile.id));
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    expect((await compare(f)).assignments.allowedToolNames).toEqual(["read_item", "write_item"]);
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: `OT${randomUUID().slice(0, 6)}` }).returning();
    const [foreign] = await db.insert(agents).values({ companyId: other.id, name: "Foreign" }).returning();
    await expect(toolAccessService(db).getEffectiveToolAssignmentsForAgent(f.company.id, foreign.id)).rejects.toThrow("same company");
    expect((await toolAccessService(db).getEffectiveToolAssignmentsForAgent(other.id, foreign.id)).allowedTools).toEqual([]);
  });

  it("reads small catalog rows from real PostgreSQL while preserving complete public definitions", async () => {
    const f = await fixture();
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    const observed: Array<{ rows: number; bytes: number }> = [];
    const measuredDb = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          if (args[0] === toolCatalogEntries) {
            const execute = selection.execute.bind(selection);
            selection.execute = async () => {
              const rows = await execute();
              observed.push({ rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
              return rows;
            };
          }
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    const service = toolAccessService(measuredDb);
    const full = await service.getEffectiveProfilesForAgent(f.company.id, f.agent.id);
    const assignments = await service.getEffectiveToolAssignmentsForAgent(f.company.id, f.agent.id);
    expect(assignments.allowedTools.map(tool => tool.id)).toEqual(full.allowedTools.map(tool => tool.id));
    expect(observed).toHaveLength(2);
    expect(observed[1].rows).toBe(observed[0].rows);
    expect(observed[1].bytes).toBeLessThan(observed[0].bytes / 100);
    expect(full.allowedTools[0].inputSchema).toEqual(f.read.inputSchema);
  });
  it("scopes catalog reads, omits rule payloads, and keeps current full definitions", async () => {
    const f = await fixture();
    const bulk = randomBytes(128 * 1024).toString("base64");
    const [rule] = await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id,
      selectorType: "application", effect: "include", applicationId: f.application.id, conditions: { savedRuleMetadata: bulk } }).returning();
    const [unrelated] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: f.application.id,
      name: "Other connection", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true }).returning();
    await db.insert(toolCatalogEntries).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.company.id,
      applicationId: f.application.id, connectionId: unrelated.id, name: `other_${index}`, toolName: `other_${index}`, versionHash: `v${index}` })));
    const service = toolAccessService(db);
    const before = await service.getEffectiveToolAssignmentsForAgent(f.company.id, f.agent.id);
    expect(before.allowedTools).toHaveLength(102);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { toolCatalogEntries, toolProfileEntries }, capture);
    let scoped: Awaited<ReturnType<typeof service.getConnectionAssignmentsForAgent>>;
    try { scoped = await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id]); }
    finally { capture.flush(); }
    expect(Number(events.at(-1)?.completedQueries)).toBeGreaterThan(0);
    expect(Number(events.at(-1)?.responseValueBytes)).toBeLessThan(16 * 1024);
    const catalogQueries = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1"
      && event.table === "tool_catalog_entries" && event.operation === "select");
    expect(catalogQueries).toHaveLength(1);
    expect(catalogQueries[0]).toMatchObject({ calls: 1, rows: 2 });
    expect(scoped!).toEqual({ allowedConnectionIds: [f.connection.id], installedConnections: before.installedConnections });
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
    expect((await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, rule.id)))[0]).toEqual(rule);
    expect(await service.getEffectiveToolAssignmentsForAgent(f.company.id, f.agent.id)).toEqual(before);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [])).allowedConnectionIds).toEqual([]);
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
  });

  it("omits unrelated rules and bindings while retaining current connection decisions", async () => {
    const f = await fixture();
    const [otherApplication] = await db.insert(toolApplications).values({ companyId: f.company.id, name: "Other app", type: "mcp_http" }).returning();
    const [otherConnection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: otherApplication.id,
      name: "Other connection", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [otherTool] = await db.insert(toolCatalogEntries).values({ companyId: f.company.id, applicationId: otherApplication.id,
      connectionId: otherConnection.id, name: "other", toolName: "other", versionHash: "other", riskLevel: "destructive" }).returning();
    await db.insert(toolProfileEntries).values(Array.from({ length: 200 }, (_, index) => [
      { selectorType: "application" as const, applicationId: otherApplication.id },
      { selectorType: "connection" as const, connectionId: otherConnection.id },
      { selectorType: "catalog_entry" as const, catalogEntryId: otherTool.id },
      { selectorType: "tool_name" as const, toolName: `unrelated_${index}` },
      { selectorType: "risk_level" as const, riskLevel: "destructive" as const },
    ].map(entry => ({ companyId: f.company.id, profileId: f.profile.id, effect: index % 2 ? "include" as const : "exclude" as const, ...entry }))).flat());
    await db.insert(toolProfileBindings).values(Array.from({ length: 200 }, () => ({ companyId: f.company.id,
      profileId: f.profile.id, targetType: "agent" as const, targetId: randomUUID() })));
    const [include, exclude] = await db.insert(toolProfileEntries).values([
      { companyId: f.company.id, profileId: f.profile.id, selectorType: "connection", effect: "include", connectionId: f.connection.id },
      { companyId: f.company.id, profileId: f.profile.id, selectorType: "catalog_entry", effect: "exclude", catalogEntryId: f.write.id },
    ]).returning();
    const service = toolAccessService(db), before = await compare(f);
    const savedRules = await db.select().from(toolProfileEntries);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { toolProfileEntries, toolProfileBindings }, capture);
    try {
      const scoped = await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id]);
      capture.flush();
      const rules = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1" && event.table === "tool_profile_entries");
      const bindings = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1" && event.table === "tool_profile_bindings");
      expect(rules).toHaveLength(1);
      expect(Number(rules[0].responseValueBytes)).toBeLessThan(4096);
      expect(rules[0]).toMatchObject({ calls: 1, rows: 2 });
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ calls: 1, rows: 1 });
      expect(scoped).toEqual({ allowedConnectionIds: [f.connection.id], installedConnections: before.full.installedConnections });
      expect(await db.select().from(toolProfileEntries)).toEqual(savedRules);
      await db.update(toolProfileEntries).set({ effect: "exclude" }).where(eq(toolProfileEntries.id, include.id));
      expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
      await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, include.id));
      expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
      expect((await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, exclude.id)))[0]).toEqual(exclude);
    } finally { capture.flush(); }
  });

  it("preserves null application matches and exact special-character tool names", async () => {
    const f = await fixture(), toolName = "quoted' path\\tool_🙂";
    await db.update(toolCatalogEntries).set({ status: "removed" }).where(eq(toolCatalogEntries.id, f.write.id));
    await db.update(toolCatalogEntries).set({ applicationId: null, toolName }).where(eq(toolCatalogEntries.id, f.read.id));
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    const [rule] = await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id,
      selectorType: "application", applicationId: null, effect: "exclude" }).returning();
    const service = toolAccessService(db);
    expect((await compare(f)).assignments.allowedTools).toEqual([]);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
    await db.update(toolProfileEntries).set({ selectorType: "tool_name", toolName }).where(eq(toolProfileEntries.id, rule.id));
    expect((await compare(f)).assignments.allowedTools).toEqual([]);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
    await db.update(toolProfileEntries).set({ toolName: `${toolName}different` }).where(eq(toolProfileEntries.id, rule.id));
    expect((await compare(f)).assignments.allowedTools.map(tool => tool.id)).toEqual([f.read.id]);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([f.connection.id]);
  });

  it.each(["application", "connection", "catalog_entry", "tool_name", "risk_level"] as const)("denies the connection when a %s exclusion blocks its only active tool", async selectorType => {
    const f = await fixture();
    await db.update(toolCatalogEntries).set({ status: "removed" }).where(eq(toolCatalogEntries.id, f.write.id));
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    const [rule] = await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id, selectorType, effect: "exclude",
      ...(selectorType === "application" ? { applicationId: f.application.id } : {}),
      ...(selectorType === "connection" ? { connectionId: f.connection.id } : {}),
      ...(selectorType === "catalog_entry" ? { catalogEntryId: f.read.id } : {}),
      ...(selectorType === "tool_name" ? { toolName: f.read.toolName } : {}),
      ...(selectorType === "risk_level" ? { riskLevel: "read" as const } : {}),
    }).returning();
    const service = toolAccessService(db);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
    expect((await compare(f)).assignments.allowedTools).toEqual([]);
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, rule.id));
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([f.connection.id]);
  });

  it("filters rules against the catalog rows being evaluated when the catalog changes during the read", async () => {
    const f = await fixture();
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    await db.update(toolCatalogEntries).set({ status: "removed" }).where(eq(toolCatalogEntries.id, f.write.id));
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: f.profile.id,
      selectorType: "tool_name", toolName: f.read.toolName, effect: "exclude" });
    let changed = false;
    const changingDb = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          if (args[0] === toolCatalogEntries) {
            const execute = selection.execute.bind(selection);
            selection.execute = async () => {
              const rows = await execute();
              if (!changed) {
                changed = true;
                await db.update(toolCatalogEntries).set({ toolName: "changed-after-read" }).where(eq(toolCatalogEntries.id, f.read.id));
              }
              return rows;
            };
          }
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    const service = toolAccessService(changingDb);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([]);
    expect(changed).toBe(true);
    expect((await service.getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [f.connection.id])).allowedConnectionIds).toEqual([f.connection.id]);
  });

  it("keeps other companies' catalog rows out of scoped assignments", async () => {
    const f = await fixture();
    const other = await fixture();
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id));
    expect((await toolAccessService(db).getConnectionAssignmentsForAgent(f.company.id, f.agent.id, [other.connection.id])).allowedConnectionIds).toEqual([]);
    await expect(toolAccessService(db).getConnectionAssignmentsForAgent(f.company.id, other.agent.id, [f.connection.id])).rejects.toThrow("same company");
  });

});
