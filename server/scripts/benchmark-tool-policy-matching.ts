/**
 * Main-thread cost of the policy decisions in one tools/list response, against
 * enabled policies shaped like the staging company (see
 * stagingShapedToolPolicies). Uses a throwaway embedded PostgreSQL database; no
 * provider calls, production data, or model inference. Alternates the baseline
 * and current policy services, one listing (fresh decision cache) per run.
 *
 * pnpm --filter @paperclipai/server exec tsx scripts/benchmark-tool-policy-matching.ts \
 *   --baseline-ref origin/master --tools 800 --rounds 9
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createDb, toolPolicies, type Db as DbClient } from "@paperclipai/db";
import type { ToolAccessDecisionInput } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { createListingFixture } from "../src/__tests__/helpers/tool-gateway-listing-fixture.js";
import { stagingShapedToolPolicies } from "../src/__tests__/helpers/tool-policy-index-fixture.js";
import * as current from "../src/services/tool-access-policy.js";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}
const toolCount = Number(option("--tools", "800"));
const rounds = Number(option("--rounds", "9"));
const baselineRef = option("--baseline-ref", "origin/master");
const concurrency = 16; // LISTING_DECISION_CONCURRENCY in tool-gateway.ts

// The baseline imports its siblings by relative path, so it sits next to the
// current service for the run. Each run uses its own file, so overlapping runs
// cannot replace or remove another run's baseline.
const baselineSource = execFileSync("git", ["show", `${baselineRef}:server/src/services/tool-access-policy.ts`], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 64 * 1024 * 1024,
});
const baselineUrl = new URL(
  `../src/services/tool-access-policy.benchmark-baseline-${process.pid}-${randomBytes(4).toString("hex")}.ts`,
  import.meta.url,
);
type Service = typeof current.toolAccessPolicyService;
let baseline: { toolAccessPolicyService: Service; createToolAccessDecisionCache: typeof current.createToolAccessDecisionCache };
try {
  writeFileSync(baselineUrl, baselineSource, { flag: "wx" });
  baseline = await import(pathToFileURL(fileURLToPath(baselineUrl)).href);
} finally {
  rmSync(baselineUrl, { force: true });
}

async function mapWithConcurrency<T, R>(items: readonly T[], mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

type Db = ReturnType<typeof createDb>;

/** Counts reads of the raw selectors on every tool_policies row. */
function countingDb(db: Db) {
  const counter = { reads: 0, selectorMatches: 0 };
  const counted = new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<DbClient["select"]>) => {
      const builder = target.select(...fields);
      const from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args);
        if (args[0] !== toolPolicies) return selection;
        const execute = selection.execute.bind(selection);
        selection.execute = (async (...rest: Parameters<typeof execute>) => (await execute(...rest) as Array<typeof toolPolicies.$inferSelect>)
          .map((row) => ({ ...row, selectors: new Proxy(row.selectors, {
            get(selector, property, receiver) { counter.reads += 1; return Reflect.get(selector, property, receiver); },
            // A raw selector match starts with Object.keys(selector).
            ownKeys(selector) { counter.reads += 1; counter.selectorMatches += 1; return Reflect.ownKeys(selector); },
          }) }))) as typeof execute;
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  } });
  return { db: counted, counter };
}

const database = await startEmbeddedPostgresTestDatabase("paperclip-policy-matching-benchmark-");
const db = createDb(database.connectionString);
try {
  const fixture = await createListingFixture(db, toolCount);
  await db.insert(toolPolicies).values(stagingShapedToolPolicies({
    catalogEntries: fixture.entries,
    agentId: fixture.agent.id,
    projectId: fixture.project.id,
    applicationId: fixture.application.id,
    connectionId: fixture.connection.id,
  }).map((values) => ({ ...values, companyId: fixture.company.id })));
  const inputs: ToolAccessDecisionInput[] = fixture.entries.map((entry) => ({
    companyId: fixture.company.id,
    actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
    runContext: { heartbeatRunId: fixture.run.id, issueId: fixture.issue.id, projectId: fixture.project.id, gatewayId: fixture.namedGateway.id },
    request: {
      toolName: entry.toolName!, applicationId: fixture.application.id, connectionId: fixture.connection.id,
      catalogEntryId: entry.id, upstreamToolName: entry.toolName!, riskLevel: entry.riskLevel, arguments: {},
    },
    consumeRateLimit: false,
  }));
  const policyRows = await db.select().from(toolPolicies);
  const implementations = {
    baseline: { service: baseline.toolAccessPolicyService(db), cache: baseline.createToolAccessDecisionCache },
    current: { service: current.toolAccessPolicyService(db), cache: current.createToolAccessDecisionCache },
  };
  const listing = async (name: keyof typeof implementations) => {
    const { service, cache } = implementations[name];
    const decisionCache = cache();
    return mapWithConcurrency(inputs, (input) => service.decide(input, { cache: decisionCache }));
  };

  // Same decisions from both before measuring.
  const [before, after] = [await listing("baseline"), await listing("current")];
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Baseline and current decisions differ");

  // Selector work per listing, measured on the raw rows.
  const work: Record<string, { rawSelectorReads: number; selectorEvaluations: number }> = {};
  for (const [name, factory] of [["baseline", baseline.toolAccessPolicyService], ["current", current.toolAccessPolicyService]] as const) {
    const { db: counted, counter } = countingDb(db);
    const service = factory(counted);
    const decisionCache = current.createToolAccessDecisionCache();
    await mapWithConcurrency(inputs, (input) => service.decide(input, { cache: decisionCache }));
    work[name] = { rawSelectorReads: counter.reads, selectorEvaluations: counter.selectorMatches };
  }
  // The current path evaluates compiled selectors, one per candidate policy.
  const index = current.indexEnabledToolPolicies(policyRows);
  work.current!.selectorEvaluations = fixture.entries.reduce((sum, entry) => sum + index.candidates({
    actorType: "agent", agentId: null, projectId: null, routineId: null, issueId: null, gatewayId: null, applicationId: null,
    connectionId: null, catalogEntryId: entry.id, applicationKey: null, providerType: null, toolName: entry.toolName!,
    upstreamToolName: entry.toolName!, riskLevel: null,
  }).length, 0);

  const samples: Record<string, Array<{ wallMs: number; cpuMs: number; maxBlockMs: number }>> = { baseline: [], current: [] };
  for (let round = 0; round < rounds + 2; round += 1) {
    const order = round % 2 === 0 ? ["baseline", "current"] as const : ["current", "baseline"] as const;
    for (const name of order) {
      global.gc?.();
      const delay = monitorEventLoopDelay({ resolution: 1 });
      // The delay timer runs before the timed work starts and after it ends, so
      // it also records a long final synchronous stretch.
      delay.enable();
      await sleep(5);
      const cpu = process.cpuUsage();
      const started = performance.now();
      await listing(name);
      const wallMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      await sleep(5);
      delay.disable();
      // Two warm-up rounds are not recorded.
      if (round >= 2) samples[name]!.push({ wallMs, cpuMs: (used.user + used.system) / 1000, maxBlockMs: delay.max / 1e6 });
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const round1 = (value: number) => Math.round(value * 10) / 10;
    return { median: round1(sorted[Math.floor(sorted.length / 2)]!), min: round1(sorted[0]!), max: round1(sorted.at(-1)!) };
  };
  for (const name of ["baseline", "current"] as const) {
    const values = samples[name]!;
    console.log(JSON.stringify({
      implementation: name, tools: toolCount, policies: policyRows.length, runs: values.length,
      wallMs: stats(values.map((sample) => sample.wallMs)),
      cpuMs: stats(values.map((sample) => sample.cpuMs)),
      maxEventLoopBlockMs: stats(values.map((sample) => sample.maxBlockMs)),
      ...work[name],
    }));
  }
} finally {
  await database.cleanup();
}
