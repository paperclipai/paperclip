import assert from "node:assert/strict";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { createConnectionReviewCountsFixture } from "../src/__tests__/helpers/tool-connection-review-counts-fixture.js";
import { createToolAppAttention } from "../src/services/tool-access/catalog/attention.js";
import { getToolConnectionReviewCounts } from "../src/services/tool-access/catalog/review-counts.js";
const database = await startEmbeddedPostgresTestDatabase("connection-review-counts-benchmark-");
const db = createDb(database.connectionString, { maxConnections: 1 });
let queries = 0, rows = 0, returnedValueBytes = 0, collectBytes = false;
const measuredDb = new Proxy(db, { get(target, key) {
  if (key !== "select") return Reflect.get(target, key);
  return (...fields: Parameters<Db["select"]>) => {
    const builder = target.select(...fields), from = builder.from.bind(builder);
    builder.from = ((...args: Parameters<typeof from>) => {
      const selection = from(...args), execute = selection.execute.bind(selection);
      selection.execute = async () => { const result = await execute(); queries++; rows += result.length; if (collectBytes) returnedValueBytes += Buffer.byteLength(JSON.stringify(result)); return result; };
      return selection;
    }) as typeof builder.from;
    return builder;
  };
} });
try {
  const f = await createConnectionReviewCountsFixture(db, true);
  const legacy = createToolAppAttention(measuredDb, () => new Date("2026-02-01T00:00:00Z"));
  const invoke = async (label: "before" | "after") => {
    if (label === "after") return getToolConnectionReviewCounts(measuredDb, f.company.id, f.connection.id);
    const item = (await legacy(f.company.id)).apps.find(app => app.connection.id === f.connection.id);
    return { pendingActionRequestCount: item?.pendingActionRequestCount ?? 0, quarantinedCatalogEntryCount: item?.quarantinedCatalogEntryCount ?? 0 };
  };
  const expected = await invoke("before");
  assert.deepEqual(await invoke("after"), expected);
  console.log(JSON.stringify({ fixture: { profiles: 200, rules: 76000, activeTools: 1900, removedTools: 695, agents: 12, siblingConnections: 1, extraInvocationHistory: 2000 }, equality: true, expected, node: process.version, platform: process.platform, baseline: "3f8ebfff8a", scope: "service only; excludes HTTP admission and serialization; returnedValueBytes is application JSON value size, not wire bytes" }));
  for (const label of ["before", "after"] as const) {
    queries = 0; rows = 0; returnedValueBytes = 0; collectBytes = true;
    assert.deepEqual(await invoke(label), expected);
    console.log(JSON.stringify({ label, kind: "work-counts", queries, rows, returnedValueBytes }));
  }
  collectBytes = false;
  for (let round = -2; round < 7; round++) {
    for (const label of round % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
      global.gc?.(); queries = 0; rows = 0; returnedValueBytes = 0;
      const cpu = process.cpuUsage(), start = performance.now();
      const result = await invoke(label);
      const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
      assert.deepEqual(result, expected);
      if (round >= 0) console.log(JSON.stringify({ round, label, elapsedMs, cpuMs: (used.user + used.system) / 1000, queries, rows, forcedGc: Boolean(global.gc) }));
    }
  }
} finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
