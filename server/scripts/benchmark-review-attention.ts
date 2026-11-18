/**
 * Local reproduction of the two slowest board requests of a company with many
 * tasks in review, measured through the real routes on a real PostgreSQL:
 *
 *   GET /api/companies/:companyId/attention/summary   (the sidebar count)
 *   GET /api/companies/:companyId/issues              (the dashboard task list)
 *
 * For each request and each fixture size the script reports the statements
 * and transactions sent, the rows and the bytes that the database returned,
 * the server time, the process CPU time, the time the main thread was busy,
 * the bytes allocated, and where a CPU profile of the handler puts the time.
 * With --baseline-ref it runs the pre-fix modules in a second process against
 * the same database and fails unless both versions return the same summary
 * counts, the same attention feed, the same task index, the same task list
 * and the same review attention for every task in review.
 *
 *   pnpm --filter @paperclipai/server exec tsx scripts/benchmark-review-attention.ts \
 *     --baseline-ref=<pre-fix commit> --tasks=3000,9000 --agents=60 --company-sources
 *
 * Options: --tasks (comma-separated fixture sizes, default 3000,9000),
 * --agents (default 60), --company-sources (add what the review fixture leaves
 * out: budget policies, pull requests, plans, questions and failed runs),
 * --rounds (default 3: each version runs in a new process once per round, in
 * alternating order), --samples (requests measured per round, default 5),
 * --cpu-profile-dir (keep the .cpuprofile files), --statement-log-dir (write
 * every statement of one more request of each kind).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { Session } from "node:inspector/promises";
import express from "express";
import { and, desc, eq } from "drizzle-orm";
import { createDb, issues } from "@paperclipai/db";
import { meterDatabaseStatements } from "../src/__tests__/helpers/database-statement-meter.js";
import { seedAttentionSummaryVolume } from "../src/__tests__/helpers/attention-summary-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { seedReviewAttentionFixture } from "../src/__tests__/helpers/review-attention-fixture.js";

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
// The modules of the fix. The baseline process loads their pre-fix source;
// every other module is the current tree in both processes.
const modules = ["server/src/services/issues.ts", "server/src/services/recovery/issue-graph-liveness.ts",
  "server/src/services/attention.ts", "server/src/services/budgets.ts"];
// Functions of the attention read path, reported from the CPU profile with the
// time spent in them and everything they call.
const profiledFunctions = ["listIssueReviewAttentionMap", "classifyIssueGraphLiveness", "classifyIssueReviewPaths",
  "reviewFinding", "ownerCandidatesForRecoveryIssue", "orderedInvokableAgents", "isInvokableAgent",
  "getAgentWorkEligibility", "getAgentOrgChainHealth", "listIssueBlockerAttentionMap", "listIssueBlockedInboxAttentionMap",
  "filterIssuesForActor", "enrichAttentionItems", "readIssueBlockerAttentionBatch", "issueSummaryMap", "blockingIssueMap",
  "blockedWorkCountMap", "resolveIssueAudienceContextMap", "syncItems", "materializeSeedSources", "withIssueLabels",
  "lastActivityStatsForIssues", "blockedByMapForIssues", "decodeDatabaseTextPreview", "buildPolicySummary",
  "attentionChangeFingerprint"];
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
// Bytes this process has allocated since it started, also the collected ones.
// A Node version that does not report it gives null in the allocation column.
const allocatedBytes = () => (getHeapStatistics() as { total_allocated_bytes?: number }).total_allocated_bytes ?? Number.NaN;

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

function summarizeProfile(profile: Profile, requests: number) {
  const self = new Map<number, number>();
  for (const [index, id] of profile.samples.entries()) self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[index]! / 1_000);
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const total = new Map<number, number>();
  const totalOf = (id: number): number => {
    const node = nodes.get(id)!;
    const value = (self.get(id) ?? 0) + (node.children ?? []).reduce((sum, child) => sum + totalOf(child), 0);
    total.set(id, value);
    return value;
  };
  const rootNode = profile.nodes[0]!;
  totalOf(rootNode.id);
  // Time under a function counts its outermost frames only.
  const inclusive = new Map<string, number>();
  const walk = (id: number, open: Set<string>) => {
    const node = nodes.get(id)!;
    const name = node.callFrame.functionName;
    const counted = profiledFunctions.includes(name) && !open.has(name);
    if (counted) inclusive.set(name, (inclusive.get(name) ?? 0) + total.get(id)!);
    const next = counted ? new Set(open).add(name) : open;
    for (const child of node.children ?? []) walk(child, next);
  };
  walk(rootNode.id, new Set());
  const selfByFunction = new Map<string, number>();
  for (const node of profile.nodes) {
    const file = node.callFrame.url ? `${path.basename(node.callFrame.url)}:${node.callFrame.lineNumber + 1}` : "";
    const key = `${node.callFrame.functionName || "(anonymous)"}${file ? ` ${file}` : ""}`;
    selfByFunction.set(key, (selfByFunction.get(key) ?? 0) + (self.get(node.id) ?? 0));
  }
  // The profiler's own stop call is not part of a request.
  const excluded = (key: string) => key.startsWith("(idle)") || key.startsWith("post node:inspector");
  const idle = [...selfByFunction].filter(([key]) => excluded(key)).reduce((sum, [, ms]) => sum + ms, 0);
  const busy = [...selfByFunction].reduce((sum, [, ms]) => sum + ms, 0) - idle;
  const perRequest = (ms: number) => round(ms / requests);
  return {
    busyMsPerRequest: perRequest(busy),
    garbageCollectorMsPerRequest: perRequest(selfByFunction.get("(garbage collector)") ?? 0),
    inclusiveMsPerRequest: Object.fromEntries([...inclusive].sort((a, b) => b[1] - a[1])
      .map(([name, ms]) => [name, { ms: perRequest(ms), shareOfBusy: round(ms / busy * 100) }])),
    topSelfMsPerRequest: Object.fromEntries([...selfByFunction].filter(([key]) => !excluded(key))
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, ms]) => [key, perRequest(ms)])),
  };
}

async function runArm() {
  const { attentionRoutes } = await import("../src/routes/attention.js");
  const { issueRoutes } = await import("../src/routes/issues.js");
  const { errorHandler } = await import("../src/middleware/index.js");
  const { issueService } = await import("../src/services/issues.js");
  const companyId = arg("company")!, userId = arg("user")!, samples = Number(arg("samples") ?? 5);
  const db = createDb(arg("database-url")!);
  const meter = meterDatabaseStatements(db, arg("database-url")!);
  let serverMs = 0;
  const app = express();
  app.use((req, res, next) => {
    const started = performance.now();
    res.on("finish", () => { serverMs = performance.now() - started; });
    (req as unknown as { actor: unknown }).actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false };
    next();
  });
  app.use("/api", attentionRoutes(db));
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}`;
  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${route}: ${body.toString("utf8").slice(0, 400)}`);
    return body;
  };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const requests = { summary: "/attention/summary", taskList: "/issues" };
  const results: Record<string, unknown> = {};
  try {
    for (const [name, route] of Object.entries(requests)) {
      let bytes = 0;
      for (let warm = 0; warm < 2; warm++) bytes = (await get(route)).length;
      const measured: Array<Record<string, number>> = [];
      for (let sample = 0; sample < samples; sample++) {
        globalThis.gc?.();
        const database = meter.read();
        const cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
        const allocated = allocatedBytes(), started = performance.now();
        await get(route);
        const used = process.cpuUsage(cpu), sent = meter.read();
        measured.push({ wallMs: performance.now() - started, serverMs, cpuMs: (used.user + used.system) / 1_000,
          mainThreadBusyMs: performance.eventLoopUtilization(loop).active,
          allocatedMb: (allocatedBytes() - allocated) / 1_048_576, statements: sent.statements - database.statements,
          transactions: sent.transactions - database.transactions, waits: sent.waits - database.waits,
          rows: sent.rows - database.rows,
          sqlBytes: sent.sqlBytes - database.sqlBytes, fetchedBytes: sent.bytesReceived - database.bytesReceived });
      }
      if (arg("statement-log")) {
        meter.startLog();
        await get(route);
        await fs.writeFile(`${arg("statement-log")}.${name}.json`, JSON.stringify(meter.stopLog().map(statement => ({
          ...statement, ms: round(statement.ms), sql: statement.sql.replace(/\s+/g, " ").slice(0, 400), sqlBytes: Buffer.byteLength(statement.sql),
        })), null, 1));
      }
      const profiler = new Session();
      profiler.connect();
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.setSamplingInterval", { interval: 200 });
      await profiler.post("Profiler.start");
      const profiledRequests = 3;
      for (let request = 0; request < profiledRequests; request++) await get(route);
      const { profile } = await profiler.post("Profiler.stop");
      profiler.disconnect();
      if (arg("cpu-profile")) await fs.writeFile(`${arg("cpu-profile")}.${name}.cpuprofile`, JSON.stringify(profile));
      results[name] = { route, responseBytes: bytes, measured, profile: summarizeProfile(profile as unknown as Profile, profiledRequests) };
    }
    // What both versions must agree on.
    const summary = JSON.parse((await get(requests.summary)).toString("utf8"));
    const feed = JSON.parse((await get("/attention?all=true")).toString("utf8"));
    const taskIndex = JSON.parse((await get("/attention/tasks")).toString("utf8"));
    const taskList = JSON.parse((await get(requests.taskList)).toString("utf8")) as Array<{ status: string; reviewAttention?: { state: string } }>;
    const reviewRows = await db.select().from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"))).orderBy(desc(issues.id));
    const reviewAttention = [...await issueService(db).listReviewAttention(companyId, reviewRows)];
    const states: Record<string, number> = {};
    for (const [, attention] of reviewAttention) states[attention.state] = (states[attention.state] ?? 0) + 1;
    console.log(`RESULT ${JSON.stringify({
      results,
      shape: { totalCount: summary.totalCount, countsBySourceKind: summary.countsBySourceKind, feedItems: feed.items.length,
        taskListRows: taskList.length, taskListReviews: taskList.filter(row => row.status === "in_review").length,
        reviewAttentionStates: states },
      digests: { summary: digest({ ...summary, generatedAt: null }), feed: digest({ ...feed, generatedAt: null }),
        taskIndex: digest({ ...taskIndex, generatedAt: null }), taskList: digest(taskList),
        reviewAttention: digest(reviewAttention) },
    })}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.$client.end({ timeout: 0 });
  }
}

async function main() {
  const sizes = (arg("tasks") ?? "3000,9000").split(",").map(Number), agentCount = Number(arg("agents") ?? 60);
  const samples = Number(arg("samples") ?? 5), rounds = Number(arg("rounds") ?? 3);
  for (const value of [...sizes, agentCount, samples, rounds]) assert.ok(Number.isSafeInteger(value) && value > 0, "sizes must be positive integers");
  const baselineRef = arg("baseline-ref");
  const baselineRevision = baselineRef ? git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim() : null;
  let baselineDir: string | undefined;
  const report: Record<string, unknown> = {};
  try {
    if (baselineRevision) {
      baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.review-attention-baseline-"));
      const redirects: Record<string, string> = {};
      for (const file of modules) {
        // Relative imports of a pre-fix module resolve to the current tree;
        // the hook below sends the ones that name a module of the fix to its
        // pre-fix copy.
        const source = git("show", `${baselineRevision}:${file}`).replace(/from "(\.{1,2}\/[^"]+)"/g,
          (_match, specifier: string) => `from ${JSON.stringify(fileURLToPath(new URL(specifier, pathToFileURL(path.join(root, file)))))}`);
        const copy = path.join(baselineDir, file.replaceAll("/", "__"));
        await fs.writeFile(copy, source);
        redirects[pathToFileURL(path.join(root, file)).href] = pathToFileURL(copy).href;
      }
      await fs.writeFile(path.join(baselineDir, "hooks.mjs"), `let redirects = {};
export function initialize(data) { redirects = data; }
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  return redirects[resolved.url] ? { ...resolved, url: redirects[resolved.url] } : resolved;
}
`);
      await fs.writeFile(path.join(baselineDir, "register.mjs"), `import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url), { data: ${JSON.stringify(redirects)} });
`);
    }
    const arms = baselineDir ? ["baseline", "treatment"] : ["treatment"];
    for (const [sizeIndex, tasks] of sizes.entries()) {
      const temporary = await startEmbeddedPostgresTestDatabase("review-attention-benchmark-");
      try {
        const db = createDb(temporary.connectionString);
        const seedStarted = performance.now();
        // A second company with the same shapes, which no request may read.
        await seedReviewAttentionFixture(db, { tasks: Math.ceil(tasks / 5), agents: agentCount, prefix: "OTH" });
        const fixture = await seedReviewAttentionFixture(db, { tasks, agents: agentCount, prefix: "SYN" });
        const companySources = process.argv.includes("--company-sources") ? await seedAttentionSummaryVolume(db, fixture) : null;
        await db.$client.unsafe("vacuum analyze");
        await db.$client.end({ timeout: 0 });
        const seedMs = Math.round(performance.now() - seedStarted);
        type ArmRequest = { route: string; responseBytes: number; measured: Array<Record<string, number>>; profile: ReturnType<typeof summarizeProfile> };
        type ArmOutput = { results: Record<string, ArmRequest>; shape: unknown; digests: Record<string, string> };
        const byArm: Record<string, ArmOutput[]> = {};
        // Each version runs once per round, in an order that alternates
        // between rounds and sizes, so load on the host reaches both.
        for (let turn = 0; turn < rounds; turn++) for (const arm of (sizeIndex + turn) % 2 === 0 ? arms : [...arms].reverse()) {
          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx",
              ...(arm === "baseline" ? ["--import", pathToFileURL(path.join(baselineDir!, "register.mjs")).href] : []),
              scriptPath, `--arm=${arm}`, `--database-url=${temporary.connectionString}`, `--company=${fixture.companyId}`,
              `--user=${fixture.userId}`, `--samples=${samples}`,
              ...(arg("cpu-profile-dir") ? [`--cpu-profile=${path.join(arg("cpu-profile-dir")!, `${arm}-${tasks}`)}`] : []),
              ...(arg("statement-log-dir") ? [`--statement-log=${path.join(arg("statement-log-dir")!, `${arm}-${tasks}`)}`] : [])],
            { cwd: path.join(root, "server"), stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_ENV: "production" } });
            let stdout = "";
            child.stdout.on("data", chunk => { stdout += chunk; });
            child.on("error", reject);
            child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`${arm} exited with ${code}\n${stdout.slice(-2000)}`)));
          });
          const line = output.split("\n").find(value => value.startsWith("RESULT "));
          assert.ok(line, `${arm} printed no result`);
          (byArm[arm] ??= []).push(JSON.parse(line.slice(7)));
        }
        const first = byArm.treatment![0]!;
        for (const output of Object.values(byArm).flat()) {
          assert.deepEqual(output.shape, first.shape, "Every run of both versions must return the same counts");
          assert.deepEqual(output.digests, first.digests,
            "Every run of both versions must return the same summary, feed, task index, task list and review attention");
        }
        // The samples of every round of a version, and the profile of its last round.
        const summarize = (outputs: ArmOutput[]) => Object.fromEntries(Object.keys(first.results).map(name => {
          const measured = outputs.flatMap(output => output.results[name]!.measured);
          const field = (key: string) => measured.map(sample => sample[key]!);
          const last = outputs.at(-1)!.results[name]!;
          return [name, {
            route: last.route, responseBytes: last.responseBytes, statements: median(field("statements")),
            transactions: median(field("transactions")), databaseWaits: median(field("waits")),
            rowsFetched: median(field("rows")),
            fetchedBytes: median(field("fetchedBytes")), sqlTextBytes: median(field("sqlBytes")),
            serverMs: { median: round(median(field("serverMs"))), min: round(Math.min(...field("serverMs"))) },
            cpuMs: { median: round(median(field("cpuMs"))), min: round(Math.min(...field("cpuMs"))) },
            mainThreadBusyMs: { median: round(median(field("mainThreadBusyMs"))), min: round(Math.min(...field("mainThreadBusyMs"))) },
            allocatedMb: round(median(field("allocatedMb"))), profile: last.profile,
          }];
        }));
        report[`tasks=${tasks}`] = {
          fixture: { synthetic: true, ...fixture.counts, companySources, otherCompanyTasks: Math.ceil(tasks / 5), seedMs },
          shape: first.shape,
          identicalResponses: byArm.baseline ? Object.keys(first.digests) : "no baseline",
          ...Object.fromEntries(Object.entries(byArm).map(([arm, outputs]) => [arm, summarize(outputs)])),
        };
      } finally {
        await temporary.cleanup();
      }
    }
    console.log(JSON.stringify({
      baselineRevision, treatmentRevision: git("rev-parse", "HEAD").trim(),
      treatmentDirty: git("status", "--porcelain", "--", ...modules).trim().length > 0,
      node: process.version, host: { availableCpus: availableParallelism(), loadAverage: loadavg().map(value => round(value, 2)) },
      rounds, samplesPerRound: samples, warmupsPerRound: 2, report,
    }, null, 2));
  } finally {
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true });
  }
}

const keepAlive = setInterval(() => {}, 1_000);
try {
  await (arg("arm") ? runArm() : main());
} finally {
  clearInterval(keepAlive);
}
