import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, startEmbeddedPostgresTestDatabase, toolApplications, toolCatalogEntries, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";
import { createToolProfileResolver } from "../src/services/tool-access/profiles/resolution.js";

const baselinePath = process.argv[process.argv.indexOf("--baseline") + 1];
if (!process.argv.includes("--baseline") || !baselinePath) throw new Error("--baseline module required");
const baselineFactory = (await import(pathToFileURL(baselinePath).href)).createToolProfileResolver as typeof createToolProfileResolver;
const database = await startEmbeddedPostgresTestDatabase("profile-matching-benchmark-");
const db = createDb(database.connectionString, { maxConnections: 1 });
let queries = 0, rows = 0;
const observedDb = new Proxy(db, { get(target, key) {
  if (key !== "select") return Reflect.get(target, key);
  return (...fields: Parameters<Db["select"]>) => {
    const builder = target.select(...fields), from = builder.from.bind(builder);
    builder.from = ((...args: Parameters<typeof from>) => {
      const selection = from(...args), execute = selection.execute.bind(selection);
      selection.execute = async () => { const result = await execute(); queries++; rows += result.length; return result; };
      return selection;
    }) as typeof builder.from;
    return builder;
  };
} });
try {
  const [company] = await db.insert(companies).values({ name: "Synthetic profile matching", issuePrefix: `BM${randomUUID().slice(0, 6)}` }).returning();
  const companyAgents = await db.insert(agents).values(Array.from({ length: 12 }, (_, i) => ({ companyId: company.id, name: `Agent ${i}` }))).returning();
  const agent = companyAgents[0]!;
  const [app] = await db.insert(toolApplications).values({ companyId: company.id, name: "Synthetic app", type: "mcp_http" }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: app.id, name: "Synthetic connection", uid: randomUUID(), transport: "mcp_remote" }).returning();
  const catalog = await db.insert(toolCatalogEntries).values(Array.from({ length: 1890 }, (_, i) => ({ companyId: company.id, applicationId: app.id, connectionId: connection.id, name: `tool_${i}`, toolName: `tool_${i}`, versionHash: `v${i}`, riskLevel: "read" as const }))).returning();
  const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: "selected", name: "Selected tools", defaultAction: "deny" }).returning();
  await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
  await db.insert(toolProfileEntries).values(catalog.slice(0, 1575).map((entry, i) => ({ companyId: company.id, profileId: profile.id, selectorType: "catalog_entry" as const, catalogEntryId: entry.id, effect: i % 5 === 0 ? "exclude" as const : "include" as const })));
  const dependencies = {
    assertOptionalAgent: async (companyId: string, agentId: string | null | undefined) => {
      const valid = await observedDb.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId!)));
      assert.equal(valid.length, 1);
    },
    resolveInstalledConnectionsForAgent: async () => [],
    toCatalogEntry: () => { throw new Error("Full catalog definitions are not used by this assignment benchmark"); },
  };
  const before = baselineFactory(observedDb, dependencies);
  const after = createToolProfileResolver(observedDb, dependencies);
  const invoke = (resolver: typeof after) => resolver.getEffectiveToolAssignmentsForAgent(company.id, agent.id);
  assert.deepEqual(await invoke(after), await invoke(before));
  for (let i = 0; i < 2; i++) { await invoke(before); await invoke(after); }
  for (let round = 0; round < 7; round++) {
    for (const [label, resolver] of round % 2 ? [["after", after], ["before", before]] as const : [["before", before], ["after", after]] as const) {
      queries = 0; rows = 0;
      const cpu = process.cpuUsage(), start = performance.now();
      for (let i = 0; i < 10; i++) await invoke(resolver);
      const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
      console.log(JSON.stringify({ round, label, operations: 10, tools: 1890, rules: 1575, agents: 12, queries, rows, elapsedMs, cpuMs: (used.user + used.system) / 1000 }));
    }
  }
} finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
