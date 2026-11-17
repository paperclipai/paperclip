import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { agents, createDb, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { createToolProfileMatchingFixture } from "../src/__tests__/helpers/tool-profile-matching-fixture.js";
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
  const { company, agent } = await createToolProfileMatchingFixture(db);
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
