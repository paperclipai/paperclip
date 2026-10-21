// Opt-in provider qualification, separate from the cheap default suite:
// PAPERCLIP_RECOVERY_LIVE=1 DAYTONA_API_KEY=... PAPERCLIP_DAYTONA_SDK_PATH=...
// PAPERCLIP_RECOVERY_IMAGE=ghcr.io/...@sha256:... vitest run --config vitest.config.ts scripts/workspace-recovery-provider.test.mjs
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions,
  issues, workspaceOperations } from "@paperclipai/db";
import { NOOP_PLUGIN_TRACER } from "@paperclipai/plugin-sdk";
import { startEmbeddedPostgresTestDatabase } from "../src/__tests__/helpers/embedded-postgres.js";
import { readSystemRecovery } from "../src/services/system-recovery-state.js";
import { recoverRetainedWorkspace } from "../src/services/workspace-recovery.js";
import { attachPreservedWorkspaceSnapshots } from "../src/services/workspace-recovery-snapshot.js";
import { performSyncOut } from "../../packages/plugins/sandbox-providers/daytona/src/file-sync.js";

const boundary = vi.hoisted(() => ({ target: null }));
vi.mock("../src/services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: async () => boundary.target,
}));
vi.mock("../../packages/plugins/sandbox-providers/daytona/src/plugin.js", () => ({
  getPluginTracer: () => NOOP_PLUGIN_TRACER,
}));

const live = process.env.PAPERCLIP_RECOVERY_LIVE === "1";
const worker = process.env.PAPERCLIP_RECOVERY_WORKER;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function client() {
  const modulePath = process.env.PAPERCLIP_DAYTONA_SDK_PATH;
  if (!modulePath || !process.env.DAYTONA_API_KEY) throw new Error("Explicit Daytona qualification settings are required");
  const { Daytona } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  return new Daytona({ apiKey: process.env.DAYTONA_API_KEY, requestTimeoutMs: 120_000 });
}

it.skipIf(!live || !worker)("provider controller", async () => {
  const f = JSON.parse(await readFile(process.env.PAPERCLIP_RECOVERY_FIXTURE, "utf8"));
  process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(f.directory, "storage");
  const db = createDb(f.connectionString);
  try {
    const sandbox = await (await client()).get(f.providerLeaseId);
    const download = sandbox.fs.downloadFiles.bind(sandbox.fs);
    sandbox.fs.downloadFiles = async (...args) => {
      const result = await download(...args);
      if (worker === "interrupt") {
        // Interrupt after the real provider transfer and before host extraction.
        // The controller joins its work and stops the export-only sandbox before
        // exiting; an unjoined hard crash is separately fenced by ownership tests.
        await writeFile(path.join(f.directory, "interrupted"), "archive received; extraction interrupted");
        throw new Error("qualification_export_interrupted");
      }
      return result;
    };
    boundary.target = { kind: "remote", transport: "sandbox", providerKey: "daytona", leaseId: f.leaseId,
      remoteCwd: f.remoteCwd, timeoutMs: 120_000,
      runner: {
        syncIn: async () => { throw new Error("Recovery must not upload into the retained source"); },
        execute: async input => {
          const startedAt = new Date().toISOString();
          const result = await sandbox.process.executeCommand([input.command, ...(input.args ?? [])].map(quote).join(" "),
            input.cwd, input.env, 120);
          return { exitCode: result.exitCode, stdout: result.result, stderr: "", timedOut: false,
            signal: null, pid: null, startedAt };
        },
        syncOut: operations => performSyncOut({ sandbox, operations, remoteDir: f.remoteCwd, timeoutSeconds: 120 }),
      } };
    const environmentRuntime = {
      resumeRunLease: async () => {
        await sandbox.start(120); await sandbox.refreshData();
        if (sandbox.state !== "started") throw new Error("Provider did not confirm start");
        return { providerLeaseId: sandbox.id, metadata: { remoteCwd: f.remoteCwd } };
      },
      retryPendingSandboxTeardown: async () => {
        await sandbox.stop(120); await sandbox.refreshData();
        if (sandbox.state !== "stopped") throw new Error("Provider did not confirm stop");
        return { providerLeaseId: sandbox.id, state: "stopped" };
      },
    };
    await recoverRetainedWorkspace({ db, ...f, environmentRuntime });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const state = readSystemRecovery(action.evidence);
    expect(state?.state).toBe(worker === "interrupt" ? "scheduled" : "complete");
    await writeFile(path.join(f.directory, `${worker}.json`), JSON.stringify(state));
  } finally { await db.$client.end(); }
}, 300_000);

it.skipIf(!live || Boolean(worker))("preserves provider files across an interrupted export and controller restart without restarting the old agent", async () => {
  const image = process.env.PAPERCLIP_RECOVERY_IMAGE;
  if (!image?.includes("@sha256:")) throw new Error("An immutable qualification image is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-provider-recovery-"));
  const priorHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = path.join(directory, "home");
  const priorStorage = process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
  process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(directory, "storage");
  const database = await startEmbeddedPostgresTestDatabase("provider-recovery-");
  const db = createDb(database.connectionString);
  const daytona = await client();
  let sandbox;
  const evidence = { image, interrupted: false, restored: false, oldAgentStarts: null, externalOperations: null,
    prematureCleanup: false, controllerProcesses: [], snapshotCount: 0 };
  try {
    sandbox = await daytona.create({ image, autoStopInterval: 10, autoArchiveInterval: 60,
      resources: { cpu: 2, memory: 4, disk: 10 }, labels: { purpose: "paperclip-recovery-qualification" } }, { timeout: 300 });
    const remoteCwd = "/tmp/paperclip-recovery-fixture";
    await sandbox.process.executeCommand(`mkdir -p ${remoteCwd}`, undefined, undefined, 30);
    await sandbox.process.createSession("old-agent");
    await sandbox.process.executeSessionCommand("old-agent", {
      command: `sh -c ${quote(`echo start >> ${remoteCwd}/agent-starts; echo published >> ${remoteCwd}/external-operations; printf 'saved work\\n' > ${remoteCwd}/saved.txt; while :; do sleep 1; done`)}`,
      runAsync: true,
    });
    await expect.poll(async () => (await sandbox.process.executeCommand(`cat ${remoteCwd}/saved.txt`, undefined, undefined, 30)).result)
      .toContain("saved work");
    const companyId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Disposable provider qualification", issuePrefix: "LIVE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Disposable preservation fixture", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, issueId, agentId, status: "failed", runtimeMode: "legacy",
      contextSnapshot: { issueId }, finishedAt: new Date() });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: sandbox.id,
      leasePolicy: "retain_on_failure", status: "released", releasedAt: new Date(),
      metadata: { remoteCwd, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true } }).returning();
    const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] };
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreRecovery: recovery, workspaceRestoreFailure: "restore_failed" } })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "system", fingerprint: runId, nextAction: "",
      cause: "legacy_execution_requires_reconciliation", evidence: { runId, workspaceRestoreRecovery: recovery } });
    const fixture = path.join(directory, "fixture.json");
    await writeFile(fixture, JSON.stringify({ connectionString: database.connectionString, companyId, issueId, runId, actionId,
      leaseId: lease.id, providerLeaseId: sandbox.id, remoteCwd, directory }), { mode: 0o600 });
    async function runController(phase) {
      const child = spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts",
        "scripts/workspace-recovery-provider.test.mjs", "-t", "provider controller"], {
        cwd: path.join(root, "server"), env: { ...process.env, PAPERCLIP_RECOVERY_WORKER: phase, PAPERCLIP_RECOVERY_FIXTURE: fixture },
        stdio: ["ignore", "pipe", "pipe"],
      });
      evidence.controllerProcesses.push(child.pid);
      // Keep provider/auth diagnostics off the terminal. Only the bounded,
      // scrubbed verdict is published by the parent.
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      const code = await new Promise(resolve => child.on("exit", resolve));
      if (code !== 0) {
        await writeFile(path.join(directory, `${phase}.log`), output, { mode: 0o600 });
        throw new Error(`Provider controller ${phase} failed; protected log: ${directory}/${phase}.log`);
      }
    }
    await runController("interrupt");
    evidence.interrupted = Boolean(await readFile(path.join(directory, "interrupted"), "utf8"));
    const failed = JSON.parse(await readFile(path.join(directory, "interrupt.json"), "utf8"));
    expect(failed.attempts).toBe(1);
    // Honor the production persisted backoff; the probe never replenishes it.
    if (failed.nextAttemptAt > Date.now()) await new Promise(resolve => setTimeout(resolve, failed.nextAttemptAt - Date.now() + 10));
    await runController("resume");
    const finished = JSON.parse(await readFile(path.join(directory, "resume.json"), "utf8"));
    expect(finished.attempts).toBe(2);
    const fresh = path.join(directory, "fresh"); await mkdir(fresh);
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId, issueId, sourceRunIds: [runId], cwd: fresh });
    const files = path.join(attached[0].path, "files");
    expect(await readFile(path.join(files, "saved.txt"), "utf8")).toBe("saved work\n");
    evidence.oldAgentStarts = (await readFile(path.join(files, "agent-starts"), "utf8")).trim().split("\n").length;
    evidence.externalOperations = (await readFile(path.join(files, "external-operations"), "utf8")).trim().split("\n").length;
    expect(evidence.oldAgentStarts).toBe(1); expect(evidence.externalOperations).toBe(1);
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
    evidence.snapshotCount = operations.filter(op => op.phase === "workspace_recovery_snapshot" && op.status === "succeeded").length;
    expect(evidence.snapshotCount).toBe(1);
    await sandbox.refreshData(); expect(sandbox.state).toBe("stopped");
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(retained.providerLeaseId).toBe(sandbox.id); expect(retained.metadata.workspaceRecoveryCleanup).toBeUndefined();
    evidence.restored = true;
    evidence.savedFileSha256 = createHash("sha256").update(await readFile(path.join(files, "saved.txt"))).digest("hex");
  } finally {
    // This test owns the disposable source. Production recovery never destroys it.
    if (sandbox) await sandbox.delete(120);
    if (process.env.PAPERCLIP_RECOVERY_EVIDENCE) await writeFile(process.env.PAPERCLIP_RECOVERY_EVIDENCE, JSON.stringify(evidence, null, 2));
    await db.$client.end(); await database.cleanup();
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    if (priorStorage === undefined) delete process.env.PAPERCLIP_STORAGE_LOCAL_DIR; else process.env.PAPERCLIP_STORAGE_LOCAL_DIR = priorStorage;
    if (evidence.restored) await rm(directory, { recursive: true, force: true });
  }
}, 900_000);
