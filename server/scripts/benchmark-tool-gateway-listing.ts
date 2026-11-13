/**
 * Reproducible discovery load probe. Uses a throwaway embedded PostgreSQL DB;
 * no provider calls, production data, or model inference.
 * node --expose-gc --import tsx scripts/benchmark-tool-gateway-listing.ts
 *   --tools 50,300,900 --parallel 1,16 --repeat 3
 * --implementation accepts a local tool-gateway module for before/after replay.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import {
  createDb, heartbeatRuns, toolCatalogEntries, toolConnections, toolPolicies,
  toolProfileEntries, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { createListingFixture, recordingDb } from "../src/__tests__/helpers/tool-gateway-listing-fixture.js";
import type { createToolGatewayService } from "../src/services/tool-gateway.js";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}
function counts(value: string) {
  const result = value.split(",").map(Number);
  if (result.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("Expected positive integer counts");
  return result;
}
const toolCounts = counts(option("--tools", "50,300,900"));
const parallels = counts(option("--parallel", "1,16"));
const repeats = counts(option("--repeat", "3"))[0]!;
const connections = counts(option("--connections", "1"))[0]!;
const implementation = option("--implementation", "");
const moduleUrl = implementation ? pathToFileURL(implementation) : new URL("../src/services/tool-gateway.js", import.meta.url);
const factory = (await import(moduleUrl.href)).createToolGatewayService as typeof createToolGatewayService;
const temp = await startEmbeddedPostgresTestDatabase("paperclip-listing-benchmark-");
const db = createDb(temp.connectionString);
try {
  for (const tools of toolCounts) {
    const fixture = await createListingFixture(db, tools, { connectionCount: connections });
    await db.update(heartbeatRuns).set({
      contextSnapshot: { issueId: fixture.issue.id, projectId: fixture.project.id, taskMarkdown: "x".repeat(400_000) },
      resultJson: { summary: "x".repeat(140_000) },
    }).where(eq(heartbeatRuns.id, fixture.run.id));
    await db.update(toolConnections).set({ config: { url: "https://8.8.8.8/mcp", notes: "x".repeat(15_000) } })
      .where(eq(toolConnections.companyId, fixture.company.id));
    await db.update(toolCatalogEntries).set({ inputSchema: {
      type: "object", properties: { query: { type: "string", description: "x".repeat(5_000) } },
    } }).where(eq(toolCatalogEntries.companyId, fixture.company.id));
    await db.insert(toolProfileEntries).values(fixture.entries.map((entry) => ({
      companyId: fixture.company.id, profileId: fixture.namedGateway.profileId,
      selectorType: "catalog_entry" as const, effect: "include" as const, catalogEntryId: entry.id,
    })));
    await db.insert(toolPolicies).values(Array.from({ length: 371 }, (_, i) => ({
      companyId: fixture.company.id, name: `Unmatched fixture policy ${i}`, policyType: "block" as const,
      selectors: { catalogEntryId: randomUUID() }, priority: 100 + i,
    })));
    const input = { gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token };
    await factory(db).listToolsForNamedGateway(input);
    for (const parallel of parallels) {
      for (let iteration = 1; iteration <= repeats; iteration += 1) {
        global.gc?.();
        const before = process.memoryUsage();
        let peakHeap = before.heapUsed;
        let peakRss = before.rss;
        const sample = () => {
          const memory = process.memoryUsage();
          peakHeap = Math.max(peakHeap, memory.heapUsed);
          peakRss = Math.max(peakRss, memory.rss);
        };
        const timer = setInterval(sample, 2);
        const recorder = recordingDb(db);
        const started = performance.now();
        let visible = 0;
        try {
          const listings = await Promise.all(Array.from({ length: parallel }, () =>
            factory(recorder.db).listToolsForNamedGateway(input)));
          visible = listings[0]!.length;
          sample();
        } finally {
          clearInterval(timer);
        }
        const elapsedMs = performance.now() - started;
        global.gc?.();
        const after = process.memoryUsage();
        console.log(JSON.stringify({
          tools, connections, parallel, iteration, visible, queries: recorder.statements.length,
          elapsedMs: Math.round(elapsedMs), peakHeapIncreaseMiB: Math.round((peakHeap - before.heapUsed) / 1_048_576),
          peakRssMiB: Math.round(peakRss / 1_048_576), retainedHeapIncreaseMiB: Math.round((after.heapUsed - before.heapUsed) / 1_048_576),
          forcedGc: Boolean(global.gc), fixture: { snapshotBytes: 400_000, schemaBytes: 5_000, policyCount: 373 },
        }));
      }
    }
  }
} finally {
  await temp.cleanup();
}
