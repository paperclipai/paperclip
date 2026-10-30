import { readUpgradeArtifacts, upgradeArtifactKey } from "./upgrade-artifacts.js";
/** Credential-free main-server replacement. This proves the wrapper/startup/DB
 * boundary; only the hosted workflow can qualify an active Daytona agent.
 * Run: node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/controller-replacement-smoke.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/index.js";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { configuredControllerOutage, validControllerOutageReceipt, type ControllerOutage } from "./controller-outage.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { createRunnerE2ETemporaryRoot, prepareRunnerE2EServerConfig } from "./server-config.js";
import { createRunnerE2EServerStopper } from "./server-stop.js";
import { cleanupControllerSmokeDatabase } from "./controller-smoke-cleanup.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";

let outage: ControllerOutage;
let upgrades: Awaited<ReturnType<typeof readUpgradeArtifacts>> = null;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoot = await createRunnerE2ETemporaryRoot();
const home = path.join(temporaryRoot, "home");
const configPath = path.join(home, "instances", "default", "config.json");
const control = runnerE2EServerControlPaths(temporaryRoot);
const reportPath = path.join(temporaryRoot, "replacement-evidence.json");
console.info(JSON.stringify({ started: true, evidence: reportPath }));
const report: Record<string, unknown> = { schema: "paperclip.e2e.controller-replacement-smoke/v1",
  providerTurns: 0, activeAgentContinuityQualified: false, cleanupConfirmed: false,
  databaseCreated: false, wrapperStarted: false };
// Register resources only after creation so setup failures still have evidence
// and cleanup never assumes a database or client exists.
let database: { connectionString: string; cleanup(): Promise<void> } | undefined;
let db: ReturnType<typeof createDb> | undefined;
const log = createWriteStream(path.join(temporaryRoot, "wrapper.log"), { mode: 0o600 });
const stopper = createRunnerE2EServerStopper({ gracefulTimeoutMs: 35_000, forcedTimeoutMs: 5_000,
  hasSpawnError: () => false, markExpectedStop: () => {}, log: message => log.write(message) });
let wrapper: ReturnType<typeof spawn> | undefined;
let failure: unknown;
let ownedPostgresProcessId: number | null | undefined = process.env.PAPERCLIP_TEST_DATABASE_URL ? null : undefined;
report.databaseCleanupScope = ownedPostgresProcessId === null ? "owned_database" : "owned_cluster_process";
try {
  report.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  report.sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim().length > 0;
  outage = configuredControllerOutage(process.env);
  report.outage = outage;
  upgrades = await readUpgradeArtifacts(process.env[upgradeArtifactKey]);
  const port = await reserveRunnerE2EServerPort();
  // The database belongs to this driver, never to either server process tree.
  const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (!external) {
    if (upgrades) throw new Error("Artifact migration proof requires PAPERCLIP_TEST_DATABASE_URL; the embedded test helper pre-migrates its database");
    database = await startEmbeddedPostgresTestDatabase("controller-replacement-smoke-");
  } else {
    // Create an empty database. Artifact A applies its own migrations before B.
    // Record ownership before closing the admin client, which can itself fail.
    const name = `upgrade_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(external); url.pathname = `/${name}`;
    const admin = createDb(external);
    try {
      await admin.$client.unsafe(`create database "${name}"`);
      database = { connectionString: url.toString(), cleanup: async () => {
        const cleanup = createDb(external);
        try { await cleanup.$client.unsafe(`drop database "${name}"`); }
        finally { await cleanup.$client.end(); }
      } };
      report.databaseCreated = true;
    } finally { await admin.$client.end(); }
  }
  report.databaseCreated = true;
  db = createDb(database.connectionString);
  if (ownedPostgresProcessId !== null) {
    const [owner] = await db.$client`select split_part(pg_read_file('postmaster.pid', 0, 64), chr(10), 1)::int as pid`;
    const pid = Number(owner?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("owned_postgres_identity_unavailable");
    ownedPostgresProcessId = pid;
  }
  const reservation = await prepareRunnerE2EServerConfig({ temporaryRoot, configPath, serverPort: port });
  await reservation?.close();
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  config.database = { ...config.database, mode: "postgres", connectionString: database.connectionString };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const source = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR,
    ...(upgrades ? { ...upgrades.artifacts.A.pins, [upgradeArtifactKey]: process.env[upgradeArtifactKey] } : {}),
    NODE_ENV: "test", PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_AGENT_JWT_SECRET: randomUUID(), PAPERCLIP_DECISION_SIGNING_SECRET: randomUUID(),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
    PAPERCLIP_RUNNER_E2E_SERVER_LOG: path.join(temporaryRoot, "server.log"),
    PAPERCLIP_RUNNER_E2E_TEMP_ROOT: temporaryRoot, PAPERCLIP_RUNNER_E2E_PORT: String(port),
    PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify(["everyday-workflows.runner-codex.daytona.recover-controller"]) };
  wrapper = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(repositoryRoot, path.join(import.meta.dirname, "server.ts")),
    { cwd: repositoryRoot, env: source, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  wrapper.once("spawn", () => { report.wrapperStarted = true; });
  wrapper.stdout!.pipe(log, { end: false }); wrapper.stderr!.pipe(log, { end: false });
  const stopped = new Promise<void>((resolve, reject) => { wrapper!.once("error", reject); wrapper!.once("close", () => resolve()); });
  void stopped.catch(() => {});
  await stopper.watch(wrapper);
  async function poll<T>(load: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (wrapper!.exitCode !== null || wrapper!.signalCode !== null) throw new Error("Server supervisor exited; inspect private logs");
      const value = await load();
      if (accept(value)) return value;
      await delay(200);
    }
    throw new Error("Main-server replacement smoke timed out; inspect private logs");
  }
  const base = `http://127.0.0.1:${port}`;
  async function api(route: string, body?: object) {
    const response = await fetch(`${base}/api${route}`, { method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", origin: base }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Smoke API ${route} returned ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  await poll(() => api("/health").catch(() => null), health => health?.status === "ok", 180_000);
  const company = await api("/companies", { name: `Restart smoke ${randomUUID()}` });
  const [before] = await db.$client<{ started: string }[]>`select pg_postmaster_start_time()::text as started`;
  const receipts: unknown[] = [];
  for (let index = 1; index < (upgrades?.sequence.length ?? 2); index += 1) {
    // Empty fixture cache exercises retirement without pretending a runner exists.
    const cache = path.join(home, "instances", "default", "runtime", "paperclip-runner");
    await mkdir(cache, { recursive: true });
    const requestId = `smoke-${index}-${randomUUID()}`;
    await writeFile(`${control.restartRequestPath}.tmp`, JSON.stringify({ requestId, discardControllerCache: true, controllerOutage: outage }), { mode: 0o600 });
    await rename(`${control.restartRequestPath}.tmp`, control.restartRequestPath);
    const ack = await poll(async () => {
      const value = await readFile(control.restartAcknowledgementPath, "utf8").then(text => JSON.parse(text) as Record<string, unknown>)
        .catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (value?.requestId === requestId && value.status === "failed") throw new Error(String(value.message));
      return value;
    }, value => value?.requestId === requestId && value.status === "ready", outage.holdMs + 180_000);
    assert(validControllerOutageReceipt(ack!.controllerOutage, outage, requestId, upgrades ? {
      previous: upgrades.artifacts[upgrades.sequence[index - 1]!],
      replacement: upgrades.artifacts[upgrades.sequence[index]!],
    } : undefined), "Invalid replacement fault or requested artifact receipt");
    receipts.push(ack!.controllerOutage);
    report.replacements = receipts;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    assert.equal((await api(`/companies/${company.id}`)).id, company.id);
    const after: { started: string } = (await db.$client<{ started: string }[]>`select pg_postmaster_start_time()::text as started`)[0]!;
    assert.equal(after.started, before.started, "Postgres must remain alive across the web-server replacement");
    await api("/companies", { name: `New admission after restart ${randomUUID()}` });
  }
  Object.assign(report, { postgresStayedAlive: true, existingDataReadable: true, newMutationAccepted: true, passed: true });
  await stopper.stopAll();
  await stopped;
} catch (error) {
  failure = error;
  Object.assign(report, { passed: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  const cleanupErrors: string[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];
  if (wrapper) cleanups.push(() => stopper.stopAll());
  if (db) { const client = db.$client; cleanups.push(() => client.end()); }
  if (database) { const owned = database; cleanups.push(() => cleanupControllerSmokeDatabase(owned, ownedPostgresProcessId)); }
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (error) { failure ??= error; cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  report.cleanupConfirmed = cleanupErrors.length === 0;
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.passed = false; }
  await new Promise<void>(resolve => log.end(resolve));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.info(JSON.stringify({ passed: report.passed, evidence: reportPath, cleanupConfirmed: report.cleanupConfirmed }));
}
if (failure) throw failure;
