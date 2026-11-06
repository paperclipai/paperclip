/** Explicit infrastructure-only operation. Importing or typechecking never
 * starts Docker, a database, Paperclip, a scenario, a model or a native run. */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRunnerE2ETemporaryRoot } from "./server-config.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import { DATABASE_LANE_ENV, DOCKER_DATABASE_ENV, dockerDatabaseLaunchState, publicDockerDatabaseIdentity, runDocker, startOwnedDockerDatabase } from "./docker-postgres.js";
import { createProcessTreeOwner, stopOwnedProcessTree } from "./process-tree-owner.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";
import { assertRunnerDatabaseIsolation } from "./instance-isolation.js";
import { resolveRunnerE2ESource } from "./source.js";
import { findSecretLeakInDirectory, sanitizeJson } from "./redaction.js";

export async function runOwnedDockerInfrastructureHealth() {
  const source = resolveRunnerE2ESource();
  if (!source.sha || !/^[a-f0-9]{40}$/.test(source.sha)) throw new Error("Infrastructure health requires the explicit immutable source SHA");
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const root = await createRunnerE2ETemporaryRoot(), privateDir = path.join(root, "infrastructure-health-private");
  await mkdir(privateDir, { mode: 0o700 });
  const log = createWriteStream(path.join(privateDir, "server.log"), { mode: 0o600 });
  const secrets: string[] = [], startedAt = new Date().toISOString();
  let database: Awaited<ReturnType<typeof startOwnedDockerDatabase>> | undefined;
  let child: ReturnType<typeof spawn> | undefined, owner: ReturnType<typeof createProcessTreeOwner> | undefined, observation: ReturnType<typeof setInterval> | undefined;
  let persistedStateScanPassed = false;
  let phase = "owned-postgres-startup", failure: unknown; const cleanupFailures: string[] = [];
  let health: { status: string; deploymentMode?: string } | undefined, schema: Record<string, number> | undefined;
  try {
    database = await startOwnedDockerDatabase({ temporaryRoot: root, privateSecrets: secrets });
    phase = "normal-source-onboarding-migrations";
    const port = await reserveRunnerE2EServerPort(), home = path.join(root, "paperclip-home"), instance = `runner-e2e-docker-health-${randomBytes(6).toString("hex")}`;
    const configPath = path.join(home, "instances", instance, "config.json");
    const env: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { NODE_ENV: "test", DO_NOT_TRACK: "1", PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: instance,
      PAPERCLIP_RUNNER_E2E_SOURCE_SHA: source.sha, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root, PAPERCLIP_RUNNER_E2E_PORT: String(port), PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: "[]", PAPERCLIP_RUNNER_E2E_SERVER_LOG: path.join(privateDir, "supervisor.log"),
      [DATABASE_LANE_ENV]: "owned-docker-postgres", [DOCKER_DATABASE_ENV]: database.filename });
    for (const name of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "BETTER_AUTH_SECRET"]) { const value = randomBytes(48).toString("hex"); secrets.push(value); env[name] = value; }
    child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(repositoryRoot, path.join(repositoryRoot, "tests/runner-e2e/server.ts")), { cwd: repositoryRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let spawnFailure = false; child.on("error", () => { spawnFailure = true; });
    owner = createProcessTreeOwner(child); await owner.observe(); observation = setInterval(() => { void owner!.observe().catch(() => {}); }, 100);
    child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
    const deadline = Date.now() + 180000, origin = `http://127.0.0.1:${port}`;
    while (Date.now() < deadline) {
      if (spawnFailure || child.exitCode !== null || child.signalCode !== null) throw new Error("Owned source supervisor exited before API readiness; private logs retained");
      try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) }); const value = await response.json() as typeof health; if (response.ok && value?.status === "ok") { health = value; break; } } catch { /* Keep the genuine readiness deadline; no fabricated response. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!health) throw new Error("Owned source onboarding/API readiness deadline expired");
    phase = "actual-api-schema-and-isolation";
    const companies = await fetch(`${origin}/api/companies`, { signal: AbortSignal.timeout(5000) }); const companyRows = await companies.json();
    const ui = await fetch(origin, { signal: AbortSignal.timeout(5000) });
    if (!companies.ok || !Array.isArray(companyRows) || companyRows.length !== 0 || !ui.ok) throw new Error("Fresh source instance did not expose healthy empty-company API/UI");
    await assertRunnerDatabaseIsolation(configPath, root, database.filename);
    phase = "same-final-persisted-state-secret-scan";
    const leak = await findSecretLeakInDirectory(home, secrets, { includeShapes: false, privateDockerDatabaseConfig: { temporaryRoot: root, configPath, receiptPath: database.filename } });
    if (leak) throw new Error("Owned infrastructure persisted-state scan detected a secret outside intended custody");
    persistedStateScanPassed = true;
    await database.verify();
    // Only the exact already-owned CID can receive this read-only SQL command.
    const r = database.receipt;
    schema = JSON.parse(await runDocker(["--context", r.engine.context, "exec", r.containerId!, "psql", "-X", "-U", r.username, "-d", r.database, "-At", "-c",
      "SELECT json_build_object('migrations',(SELECT count(*) FROM drizzle.__drizzle_migrations),'companies',(SELECT count(*) FROM companies),'runs',(SELECT count(*) FROM heartbeat_runs),'agents',(SELECT count(*) FROM agents))"]));
    if (!schema || !Number.isSafeInteger(schema.migrations) || schema.migrations <= 0 || schema.companies !== 0 || schema.agents !== 0 || schema.runs !== 0) throw new Error("Fresh normal migrations/zero-work SQL assertions failed");
    phase = "verified-zero-work-infrastructure";
  } catch (error) {
    failure = error; await writeFile(path.join(privateDir, "primary-error.txt"), error instanceof Error ? error.stack ?? error.message : "Infrastructure health failed", { mode: 0o600 });
  } finally {
    if (observation) clearInterval(observation);
    if (child && owner) try { await stopOwnedProcessTree(child, owner); } catch { cleanupFailures.push("Owned source supervisor/descendant cleanup unconfirmed"); }
    // Never stop a database beneath a source process whose exit is unconfirmed.
    if (database && !cleanupFailures.length) try { await database.close(); } catch { cleanupFailures.push("Owned Docker container/volume cleanup unconfirmed"); }
    await new Promise<void>(resolve => log.end(resolve));
  }
  const startupState = await dockerDatabaseLaunchState("owned-docker-postgres", root);
  if (startupState.cleanupUnconfirmed && !cleanupFailures.length) cleanupFailures.push("Owned Docker resource absence is unconfirmed");
  const receipt = { schemaVersion: 1, kind: "owned-docker-postgres-infrastructure-only", source, productionBaseline: "8373d7867963674ff960d2345d0d28086f799bc7", startedAt, finishedAt: new Date().toISOString(),
    status: failure || cleanupFailures.length ? "failed" : "passed", phase, primaryFailure: failure ? "Actual infrastructure operation failed; primary private diagnostics retained" : null, cleanupFailures,
    database: database ? publicDockerDatabaseIdentity(database.receipt) : startupState.identity,
    checks: { sameFinalPersistedStateSecretScan: persistedStateScanPassed, actualApiHealth: !!health, actualNormalMigrations: !!schema?.migrations, zeroCompanies: schema?.companies === 0, zeroNativeRuns: schema?.runs === 0, zeroAgents: schema?.agents === 0, zeroScenarios: true, zeroModels: true },
    canonicalAttempts: 0, privateRoot: failure || cleanupFailures.length ? root : undefined };
  const destination = path.join(repositoryRoot, "tests/runner-e2e/results/chat-catalog-campaign"); await mkdir(destination, { recursive: true });
  const filename = path.join(destination, `docker-infrastructure-health-${startedAt.replaceAll(/[:.]/g, "-")}.json`);
  await writeFile(filename, `${JSON.stringify(sanitizeJson(receipt, secrets), null, 2)}\n`, { mode: 0o600 });
  if (!failure && !cleanupFailures.length) await rm(root, { recursive: true, force: true });
  return { status: receipt.status, receipt: filename };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join() !== "--run-owned-infrastructure-health") throw new Error("Requires explicit --run-owned-infrastructure-health; never a canonical scenario");
  const result = await runOwnedDockerInfrastructureHealth(); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== "passed") process.exitCode = 1;
}
