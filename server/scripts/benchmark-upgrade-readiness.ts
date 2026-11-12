// Compares one upgrade readiness probe between a pre-fix revision and the working tree
// on the same PostgreSQL rows. See "Native runner restart recovery" in doc/DEVELOPING.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto, { randomBytes, randomUUID } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import { promises as fs } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { agentTaskSessions, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { createLocalEncryptedCipher } from "../src/secrets/local-encrypted-provider.js";
import { createAgentLifecycle } from "../src/services/agent-lifecycle.js";
import { readUpgradeReadiness } from "../src/services/heartbeat/upgrade-readiness.js";
import { currentNativeControllerIdentity } from "../src/services/native-runtime/native-restart-recovery.js";
import { DurablePrpControlPlane } from "../src/vendor/paperclip-runner/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const argument = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineRef = argument("baseline-ref");
assert.ok(baselineRef, "Pass a pinned pre-fix --baseline-ref");
const iterations = Number(argument("iterations") ?? 12);
// Active runs and the plaintext bytes of each header. Every scenario stays under the
// 8 MiB inspection bound, above which the read declines to inspect any header.
const scenarios = (argument("scenarios") ?? "10x300000,50x100000,200x24000").split(",").map(value => {
  const [runs, headerBytes] = value.split("x").map(Number);
  return { runs, headerBytes };
});
const retainedSessions = Number(argument("retained") ?? 20), retainedHeaderBytes = 24_000;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
const baselineRevision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim();
const treatmentRevision = git("rev-parse", "HEAD").trim();
const sources = ["server/src/services/heartbeat/upgrade-readiness.ts",
  "server/src/services/native-runtime/native-runner-checkpoint.ts",
  "server/src/services/native-runtime/native-controller-recovery-inventory.ts"];
const treatmentDiff = git("diff", "--stat", "HEAD", "--", ...sources).trim();

process.env.PAPERCLIP_SECRETS_MASTER_KEY = "b".repeat(64);
let decryptions = 0;
const createDecipheriv = crypto.createDecipheriv;
crypto.createDecipheriv = ((...args: Parameters<typeof createDecipheriv>) => { decryptions++; return createDecipheriv(...args); }) as typeof createDecipheriv;
syncBuiltinESMExports();
const sockets = new Set<Socket>();
diagnosticsChannel.subscribe("net.client.socket", message => { sockets.add((message as { socket: Socket }).socket); });
const bytesReceived = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0);
const bytesSent = () => [...sockets].reduce((sum, socket) => sum + socket.bytesWritten, 0);

/** The baseline copies import each other; everything else resolves to the working tree. */
async function loadBaseline(directory: string) {
  const copies = new Map(sources.map(source => [path.join(repoRoot, source), path.join(directory, path.basename(source))]));
  for (const source of sources) {
    const original = pathToFileURL(path.join(repoRoot, source));
    await fs.writeFile(copies.get(path.join(repoRoot, source))!, git("show", `${baselineRevision}:${source}`)
      .replace(/(from |import\()"(\.{1,2}\/[^"]+)"/g, (_match, prefix: string, specifier: string) => {
        const resolved = fileURLToPath(new URL(specifier, original));
        return `${prefix}${JSON.stringify(copies.get(resolved.replace(/\.js$/, ".ts"))?.replace(/\.ts$/, ".js") ?? resolved)}`;
      }));
  }
  return await import(pathToFileURL(path.join(directory, "upgrade-readiness.ts")).href) as { readUpgradeReadiness: typeof readUpgradeReadiness };
}

function databaseCpuSeconds(port: string) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,cputime=,command="], { encoding: "utf8" }).split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(match => match !== null);
  const postmaster = rows.find(row => /postgres/.test(row[4]) && row[4].includes(`-p ${port}`))?.[1];
  assert.ok(postmaster, "The PostgreSQL server process was not found");
  return rows.filter(row => row[1] === postmaster || row[2] === postmaster).reduce((sum, row) =>
    sum + row[3].split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0), 0);
}

const keepAlive = setInterval(() => {}, 1000);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let baselineDirectory: string | undefined;
const profiler = new Session();
try {
  database = await startEmbeddedPostgresTestDatabase("upgrade-readiness-benchmark-");
  db = createDb(database.connectionString);
  const port = new URL(database.connectionString).port;
  baselineDirectory = await fs.mkdtemp(path.join(fileURLToPath(new URL("./", import.meta.url)), ".upgrade-readiness-baseline-"));
  const baseline = await loadBaseline(baselineDirectory);
  profiler.connect();
  await profiler.post("HeapProfiler.enable");
  const owner = await currentNativeControllerIdentity();
  const cipher = createLocalEncryptedCipher("write");
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic upgrade readiness", issuePrefix: `U${companyId.replaceAll("-", "")}` });
  await createAgentLifecycle(db).requestHire(companyId, { id: agentId, name: "Fixture", role: "engineer", status: "idle",
    adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { runnerResolved: true });

  // A header a real control plane wrote, then given each run's identity and a provider
  // attachment template of the scenario's size (the part that makes real headers large).
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-readiness-header-"));
  let template = "";
  const core = new DurablePrpControlPlane({ stateDirectory, identity: { runId: randomUUID(), runnerInstanceId: randomUUID(),
    normalizedSessionId: randomUUID(), environmentLeaseId: randomUUID(), turnId: "turn", itemId: "item" },
    expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  core.setCheckpointPersistence(async checkpoint => { template = checkpoint.records.get("header")!; });
  try { core.issueBootstrapTicket(); await core.flushCheckpoint(); }
  finally { await core.stop(); await fs.rm(stateDirectory, { recursive: true, force: true }); }
  type Run = { runId: string; issueId: string; runnerInstanceId: string; sessionId: string; workspaceId: string };
  const headerMaterial = (run: Run, bytes: number, key = cipher, environmentLeaseId = run.workspaceId) => {
    const header = JSON.parse(template);
    const contents = JSON.stringify({ ...header, state: { ...header.state,
      identity: { runId: run.runId, runnerInstanceId: run.runnerInstanceId, normalizedSessionId: run.sessionId,
        environmentLeaseId, turnId: "turn", itemId: "item" },
      runAttachTemplate: { provider: { instructions: randomBytes(Math.ceil(bytes * 0.75)).toString("base64").slice(0, bytes) } } } });
    return key.encrypt(JSON.stringify({ companyId, issueId: run.issueId, runId: run.runId, part: "header", contents }));
  };
  async function seed(count: number, headerBytes: number, active: boolean) {
    const runs: Run[] = Array.from({ length: count }, () => ({ runId: randomUUID(), issueId: randomUUID(),
      runnerInstanceId: randomUUID(), sessionId: randomUUID(), workspaceId: randomUUID() }));
    for (let offset = 0; offset < runs.length; offset += 10) {
      const batch = runs.slice(offset, offset + 10);
      await db!.insert(issues).values(batch.map(run => ({ id: run.issueId, companyId, title: "Synthetic work", status: "todo" })));
      await db!.insert(heartbeatRuns).values(batch.map(run => ({ id: run.runId, companyId, agentId, issueId: run.issueId,
        nativeIssueId: run.issueId, runtimeMode: "native", runnerInstanceId: run.runnerInstanceId, nativeSessionId: run.sessionId,
        ...(active ? { status: "running", processPid: process.pid, processStartedAt: new Date(),
          runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
            descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId: run.workspaceId,
            leaseId: randomUUID(), providerLeaseId: "synthetic-sandbox", remoteCwd: "/workspace" } } }
          : { status: "succeeded", finishedAt: new Date(),
            runnerProfileJson: { nativeControllerRecovery: { schema: "paperclip.native-controller-recovery.v1",
              checkpoint: { runId: run.runId, runnerInstanceId: run.runnerInstanceId, normalizedSessionId: run.sessionId } } } }) })));
      await db!.insert(nativeRunFinalizations).values(batch.map(run => ({ runId: run.runId, companyId, issueId: run.issueId,
        ...(active ? { phase: "observed", controllerBootId: owner.bootId, leaseOwner: "benchmark-lease", controllerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 3_600_000) } : { phase: "committed" }) })));
      await db!.insert(nativeRunnerCheckpoints).values(batch.map(run => ({ companyId, runId: run.runId, issueId: run.issueId,
        part: "header", material: headerMaterial(run, headerBytes) })));
      if (!active) await db!.insert(agentTaskSessions).values(batch.map(run => ({ companyId, agentId,
        adapterType: "paperclip_runner", taskKey: run.issueId, lastRunId: run.runId })));
    }
    return runs;
  }
  type Read = typeof readUpgradeReadiness;
  const comparable = (report: Awaited<ReturnType<Read>>) => ({ ...report, observedAt: null,
    nativeControllerRecovery: { ...report.nativeControllerRecovery, retained: { ...report.nativeControllerRecovery.retained, observedAt: null } } });
  let input = { activeRunIds: new Set<string>(), counters: () => ({ activeRuns: 0, pendingWakes: 0, draining: false }) };
  /** Header rows whose material reached this process in one read, and their JSON size. */
  let rows = 0, materials = 0, materialBytes = 0;
  const recorded = new Proxy(db, { get(target, key) {
    if (key !== "transaction") return Reflect.get(target, key);
    return (work: (tx: unknown) => Promise<unknown>, options: unknown) => (target.transaction as (...args: unknown[]) => Promise<unknown>)(
      (tx: { execute: (...args: unknown[]) => Promise<unknown> }) => work(new Proxy(tx, { get(inner, name) {
        if (name !== "execute") return Reflect.get(inner, name);
        return async (...args: unknown[]) => {
          const result = await inner.execute(...args);
          for (const row of Array.isArray(result) ? result as Array<{ material?: unknown }> : []) {
            rows++;
            if (row.material) { materials++; materialBytes += Buffer.byteLength(JSON.stringify(row.material)); }
          }
          return result;
        };
      } })), options);
  } });
  async function materialRead(read: Read) {
    rows = materials = materialBytes = 0;
    const before = decryptions;
    const report = comparable(await read(recorded, input));
    return { report, rows, materials, materialBytes, decryptions: decryptions - before };
  }
  async function measure(read: Read, calls: number, concurrency = 1) {
    await read(db!, input); // The measured reads repeat a state this revision has already read.
    const databaseCpu = databaseCpuSeconds(port);
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const wall: number[] = [];
    const bytes = bytesReceived(), sent = bytesSent(), decrypted = decryptions;
    const cpu = process.cpuUsage(), loop = performance.eventLoopUtilization();
    for (let call = 0; call < calls; call++) {
      const start = performance.now();
      await Promise.all(Array.from({ length: concurrency }, () => read(db!, input)));
      wall.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu), busy = performance.eventLoopUtilization(loop).active;
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    const databaseCpuMs = (databaseCpuSeconds(port) - databaseCpu) * 1000;
    let allocated = 0, decryptAllocated = 0;
    const visit = (node: typeof profile.head, underDecrypt: boolean) => {
      const decrypt = underDecrypt || node.callFrame.functionName === "decryptPart";
      allocated += node.selfSize;
      if (decrypt) decryptAllocated += node.selfSize;
      for (const child of node.children) visit(child, decrypt);
    };
    visit(profile.head, false);
    const reads = calls * concurrency, round = (value: number) => Math.round(value * 100) / 100;
    return { reads, concurrency, medianWallMs: round([...wall].sort((a, b) => a - b)[Math.floor(wall.length / 2)]),
      bytesFromDatabasePerRead: Math.round((bytesReceived() - bytes) / reads),
      bytesToDatabasePerRead: Math.round((bytesSent() - sent) / reads), decryptionsPerRead: round((decryptions - decrypted) / reads),
      processCpuMsPerRead: round((used.user + used.system) / 1000 / reads), mainThreadBusyMsPerRead: round(busy / reads),
      sampledAllocationBytesPerRead: Math.round(allocated / reads), sampledDecryptAllocationBytesPerRead: Math.round(decryptAllocated / reads),
      databaseCpuMsPerRead: round(databaseCpuMs / reads) };
  }

  const retained = await seed(retainedSessions, retainedHeaderBytes, false);
  const results = [];
  let last: Run[] = [];
  for (const scenario of scenarios) {
    if (last.length) await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, last.map(run => run.runId)));
    last = await seed(scenario.runs, scenario.headerBytes, true);
    await db.$client.unsafe("ANALYZE");
    const ids = new Set(last.map(run => run.runId));
    input = { activeRunIds: ids, counters: () => ({ activeRuns: ids.size, pendingWakes: 0, draining: false }) };
    const reference = await materialRead(baseline.readUpgradeReadiness);
    assert.equal(reference.report.ready, true, "Every fixture run must be recoverable");
    assert.equal(reference.report.recoverableRuns, scenario.runs);
    assert.equal((reference.report.nativeControllerRecovery.retained as { selectedRetainedEvidence?: number }).selectedRetainedEvidence, retained.length);
    const first = await materialRead(readUpgradeReadiness);
    const repeated = await materialRead(readUpgradeReadiness);
    assert.deepEqual(first.report, reference.report);
    assert.deepEqual(repeated.report, reference.report);
    const pick = ({ report: _report, ...counts }: typeof reference) => counts;
    const before = await measure(baseline.readUpgradeReadiness, iterations);
    const after = await measure(readUpgradeReadiness, iterations);
    results.push({ scenario: { activeRuns: scenario.runs, headerPlaintextBytes: scenario.headerBytes, retainedSessions, retainedHeaderBytes },
      headerRows: { baseline: pick(reference), treatmentFirstRead: pick(first), treatmentRepeatedRead: pick(repeated) },
      unchangedRead: { baseline: before, treatment: after },
      eightConcurrentReads: { baseline: await measure(baseline.readUpgradeReadiness, 3, 8), treatment: await measure(readUpgradeReadiness, 3, 8) } });
    assert.deepEqual(comparable(await readUpgradeReadiness(db, input)), reference.report);
  }

  // Same answer in every state, with the working tree warm from the reads above.
  const [changed, undecryptable, deleted] = last;
  const setHeader = (run: Run, material: Record<string, unknown>) => db!.update(nativeRunnerCheckpoints).set({ material })
    .where(eq(nativeRunnerCheckpoints.runId, run.runId));
  const otherKey = (() => {
    const saved = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    try { return createLocalEncryptedCipher("write"); } finally { process.env.PAPERCLIP_SECRETS_MASTER_KEY = saved; }
  })();
  const headerBytes = scenarios.at(-1)!.headerBytes;
  const states: Array<[string, () => Promise<unknown>, number]> = [
    ["a header changes to another workspace identity (updated_at untouched)", () => setHeader(changed, headerMaterial(changed, headerBytes, cipher, randomUUID())), last.length - 1],
    ["the changed header is restored", () => setHeader(changed, headerMaterial(changed, headerBytes)), last.length],
    ["a header is encrypted under another key", () => setHeader(undecryptable, headerMaterial(undecryptable, headerBytes, otherKey)), last.length - 1],
    ["a header is not encrypted material", () => setHeader(undecryptable, {}), last.length - 1],
    ["a header is deleted", () => db!.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, deleted.runId)), last.length - 2],
    ["the secrets key is replaced", async () => { process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64); }, 0],
    ["the secrets key is restored", async () => { process.env.PAPERCLIP_SECRETS_MASTER_KEY = "b".repeat(64); }, last.length - 2],
  ];
  const equivalence = [];
  for (const [state, change, recoverableRuns] of states) {
    await change();
    const expected = comparable(await baseline.readUpgradeReadiness(db, input));
    assert.equal(expected.recoverableRuns, recoverableRuns, state);
    assert.equal(expected.ready, recoverableRuns === last.length, state);
    for (let read = 0; read < 2; read++) assert.deepEqual(comparable(await readUpgradeReadiness(db, input)), expected, state);
    equivalence.push({ state, ready: expected.ready, recoverableRuns: expected.recoverableRuns, blockingRuns: expected.blockingRuns, equal: true });
  }
  console.log(JSON.stringify({ baselineRevision, treatmentRevision, treatmentDiff: treatmentDiff || null,
    node: process.version, postgres: (await db.$client.unsafe("select version()"))[0].version, iterations,
    boundaries: { bytesFromDatabase: "bytes read from (and written to) the PostgreSQL sockets, protocol framing included",
      mainThreadBusy: "event-loop active time, which includes every synchronous stretch",
      sampledAllocation: "V8 sampling heap profile at 16 KiB, collected objects included; Buffer backing stores are outside the V8 heap and not counted",
      databaseCpu: "CPU time of the PostgreSQL server processes, 10 ms resolution" },
    results, equivalence }, null, 2));
} finally {
  try {
    profiler.disconnect();
    await db?.$client.end({ timeout: 0 }); await database?.cleanup();
    if (baselineDirectory) await fs.rm(baselineDirectory, { recursive: true, force: true });
  } finally { clearInterval(keepAlive); }
}
