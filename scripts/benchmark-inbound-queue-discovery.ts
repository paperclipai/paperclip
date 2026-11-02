import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import { captureInboundQuery, runQuery, seedInboundDiscovery, type QueueFactory, type ServiceFactory } from "../server/src/__tests__/helpers/inbound-discovery-fixture.js";

const ref = process.argv.find(arg => arg.startsWith("--baseline-ref="))?.slice(15);
assert.ok(ref, "Pass an explicit pre-change --baseline-ref=<commit>");
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
const root = fileURLToPath(new URL("../", import.meta.url));
const sources = ["server/src/services/chat-channels/inbound/delivery-ledger.ts", "server/src/services/chat-channels/inbound/conversation-queue.ts", "server/src/services/chat-channels.ts"];
const runtimeChanges = execFileSync("git", ["diff", "--name-only", baselineRevision, "--", "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
assert.deepEqual(runtimeChanges.filter(name => !sources.includes(name)), [], "Baseline must not import changed runtime helpers or dependencies");
const dir = await fs.mkdtemp(path.join(root, "server/scripts/.inbound-baseline-"));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
const keepAlive = setInterval(() => {}, 1000);
function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  return [plan, ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)];
}
const started = performance.now();
try {
  const targets = new Map(sources.map(source => [path.join(root, source).replace(/\.ts$/, ".js"), path.join(dir, path.basename(source))]));
  for (const source of sources) {
    const original = path.join(root, source);
    const text = execFileSync("git", ["show", `${baselineRevision}:${source}`], { encoding: "utf8" });
    const rewritten = text.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_match, specifier: string) => {
      const resolved = path.resolve(path.dirname(original), specifier);
      return `from ${JSON.stringify(targets.get(resolved) ?? resolved)}`;
    });
    await fs.writeFile(path.join(dir, path.basename(source)), rewritten);
  }
  const oldQueue = await import(pathToFileURL(path.join(dir, "conversation-queue.ts")).href) as { createChatConversationDeliveryQueue: QueueFactory };
  const oldService = await import(pathToFileURL(path.join(dir, "chat-channels.ts")).href) as { chatChannelService: ServiceFactory };
  database = await startEmbeddedPostgresTestDatabase("inbound-discovery-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
  const [{ version }] = await db.$client.unsafe("select version()");
  const settings = await db.$client.unsafe("select name, setting from pg_settings where name in ('shared_buffers', 'work_mem', 'jit', 'jit_above_cost', 'jit_inline_above_cost', 'random_page_cost', 'max_connections') order by name");
  const results = [];
  const malformedReadyControls = [];
  let baselineExceedsWorkBudget = false;
  const budgetFailures: string[] = [];
  for (const fixture of [{ name: "small", history: 20, payloadBytes: 0 }, { name: "retained-history", history: 1500, payloadBytes: 32 * 1024 }].filter(value => !process.argv.includes("--retained-only") || value.name === "retained-history")) {
    const f = await seedInboundDiscovery(db, fixture.history, fixture.payloadBytes);
    await db.$client.unsafe("begin");
    if (process.argv.includes("--jit-off")) await db.$client.unsafe("set local jit = off");
    try {
      const pairs = [];
      for (const kind of ["deadline", "head", "ready"] as const) {
        const before = await captureInboundQuery(db, f, kind, oldQueue.createChatConversationDeliveryQueue, oldService.chatChannelService);
        const after = await captureInboundQuery(db, f, kind);
        pairs.push({ kind, before, after });
      }
      const connection = await db.$client.reserve();
      const timedDb = new Proxy(db, { get(target, key) { return key === "$client" ? connection : Reflect.get(target, key); } });
      try {
        if (process.argv.includes("--wait-for-slot")) {
          process.stderr.write(`READY ${fixture.name}: database seeded, all real queries captured; press Enter to time\n`);
          await new Promise<void>(resolve => { process.stdin.once("data", () => { process.stdin.pause(); resolve(); }); process.stdin.resume(); });
        }
        for (const { kind, before, after } of pairs) {
          const samples = { before: [] as number[], after: [] as number[] };
          const expected = await runQuery(timedDb, before);
          assert.deepEqual(await runQuery(timedDb, after), expected, `${fixture.name}/${kind}: complete positional output differs`);
          for (let n = 0; n < 7; n++) {
            for (const arm of n % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
              const start = performance.now();
              await runQuery(timedDb, arm === "before" ? before : after);
              if (n >= 2) samples[arm].push(performance.now() - start);
            }
          }
          const plans = {} as Record<"before" | "after", unknown>;
          const actionLoops = {} as Record<"before" | "after", number>;
          for (const arm of ["before", "after"] as const) {
            const query = arm === "before" ? before : after;
            const [row] = await connection.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
            plans[arm] = row["QUERY PLAN"];
            actionLoops[arm] = Math.max(0, ...nodes(row["QUERY PLAN"][0].Plan).filter(node => node["Relation Name"] === "chat_actions").map(node => Number(node["Actual Loops"])));
          }
          if (fixture.name === "retained-history") {
            const oldPlan = (plans.before as { JIT?: unknown; Plan: Record<string, number> }[])[0]!;
            const newPlan = (plans.after as { JIT?: unknown; Plan: Record<string, number> }[])[0]!;
            const oldBuffers = Number(oldPlan.Plan["Shared Hit Blocks"] ?? 0) + Number(oldPlan.Plan["Shared Read Blocks"] ?? 0);
            const newBuffers = Number(newPlan.Plan["Shared Hit Blocks"] ?? 0) + Number(newPlan.Plan["Shared Read Blocks"] ?? 0);
            baselineExceedsWorkBudget ||= Boolean(oldPlan.JIT) || (kind === "deadline" && oldBuffers > 1000);
            if (kind !== "ready" && newPlan.JIT) budgetFailures.push(`${kind}: unnecessary JIT on the retained-history fixture`);
            if (kind === "deadline" && newBuffers > 1000) budgetFailures.push(`${kind}: ${newBuffers} shared buffer accesses exceeds fixture budget 1000`);
          }
          const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
          results.push({ fixture, kind, equalPositionalRows: expected.length, before, after, samples, beforeMedianMs: median(samples.before), afterMedianMs: median(samples.after), actionLoops, plans });
          process.stderr.write(`${fixture.name}/${kind}: ${median(samples.before).toFixed(2)} -> ${median(samples.after).toFixed(2)} ms; action scans ${actionLoops.before} -> ${actionLoops.after}\n`);
        }
      } finally { connection.release(); }
      if (fixture.name === "small") {
        const unrelated = await f.delivery({ state: "filtered" });
        const other = await seedInboundDiscovery(db, 0);
        for (const input of [
          { scope: "same-company-unrelated-delivery", companyId: f.companyId, endpointId: f.endpointId, deliveryId: unrelated.id },
          { scope: "other-company", companyId: other.companyId, endpointId: other.endpointId, deliveryId: other.pending.id },
          { scope: "null-delivery", companyId: f.companyId, endpointId: f.endpointId, deliveryId: null },
        ]) {
          const action = await f.action(input.deliveryId, { companyId: input.companyId, endpointId: input.endpointId, result: { retryAt: "invalid timestamp" } });
          const before = await captureInboundQuery(db, f, "ready", oldQueue.createChatConversationDeliveryQueue, oldService.chatChannelService, f.pending.id);
          const after = await captureInboundQuery(db, f, "ready", undefined, undefined, f.pending.id);
          const outcome = async (query: typeof before) => {
            await db!.$client.unsafe("savepoint malformed_probe");
            try { return { rows: await runQuery(db!, query) }; }
            catch (error) { await db!.$client.unsafe("rollback to savepoint malformed_probe"); return { error: (error as { code?: string }).code }; }
            finally { await db!.$client.unsafe("release savepoint malformed_probe"); }
          };
          const oldResult = await outcome(before), newResult = await outcome(after);
          assert.deepEqual(newResult, oldResult, `${input.scope}: malformed ready selection outcome differs`);
          malformedReadyControls.push({ scope: input.scope, before: oldResult, after: newResult });
          await db.$client.unsafe("delete from chat_actions where id = $1::uuid", [action.id]);
        }
      }
    } finally { await db.$client.unsafe("rollback"); }
    await db.$client.unsafe("delete from chat_endpoints where id = $1::uuid", [f.endpointId]);
  }
  const runtimeSources = sources.map(source => ({ path: source,
    baselineSha256: createHash("sha256").update(execFileSync("git", ["show", `${baselineRevision}:${source}`])).digest("hex"),
    treatmentDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "--no-ext-diff", baselineRevision, "--", source])).digest("hex"),
  }));
  console.log(JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runtimeSources,
    version, settings, jitOffControl: process.argv.includes("--jit-off"), baselineExceedsWorkBudget, budgetFailures,
    malformedReadyControls, warmups: 2, timedSamplesPerArm: 5, setupAndProofMs: performance.now() - started, results }, null, 2));
  if (process.argv.includes("--require-work-budget")) assert.deepEqual(budgetFailures, [], "Fixture work budget failed");
} finally {
  try { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); await fs.rm(dir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
