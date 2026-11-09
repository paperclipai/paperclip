import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, toolApplications, toolCatalogEntries,
  toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles, type Db,
} from "@paperclipai/db";
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
});
