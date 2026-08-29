import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const ACCEPTANCE_CLOSE_LISTENER = "paperclip:acceptance:close-listener";
const ACCEPTANCE_LISTENER_CLOSED = "paperclip:acceptance:listener-closed";
const ACCEPTANCE_SHUTDOWN = "paperclip:acceptance:shutdown";
const ACCEPTANCE_ERROR = "paperclip:acceptance:error";
const ACCEPTANCE_CHILD_EXIT = "paperclip:acceptance:child-exit";
const WORKING_LISTENER_PORT = 3100;
const STARTUP_TIMEOUT_MS = 240_000;
const RECOVERY_TIMEOUT_MS = 120_000;

class FatalSmokeError extends Error {}

function assertWindowsNodeVersion() {
  assert.equal(process.platform, "win32", "This smoke harness must run on native Windows.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 24 || (major === 24 && minor >= 11), `Node 24.11+ is required; found ${process.version}.`);
}

function assertUnderWindowsTemp(candidate) {
  const resolved = path.resolve(candidate);
  const requiredRoot = path.resolve("C:\\temp");
  assert.ok(
    resolved.toLowerCase() === requiredRoot.toLowerCase()
      || resolved.toLowerCase().startsWith(`${requiredRoot.toLowerCase()}${path.sep}`),
    `Smoke paths must stay under ${requiredRoot}; received ${resolved}.`,
  );
  return resolved;
}

async function allocatePort(excluded = new Set()) {
  for (;;) {
    const server = net.createServer();
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!excluded.has(port)) return port;
  }
}

async function waitFor(description, check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalSmokeError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function windowsProcessSnapshot() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], { encoding: "utf8", timeout: 30_000, windowsHide: true }).replace(/^\uFEFF/, "").trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function listeningPids(port) {
  const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const localAddress = match[1];
    if (localAddress.endsWith(`:${port}`)) pids.push(Number(match[2]));
  }
  return [...new Set(pids)];
}

function directServerChildren(snapshot, supervisorPid) {
  return snapshot.filter((row) =>
    Number(row.ParentProcessId) === supervisorPid
    && String(row.Name ?? "").toLowerCase() === "node.exe"
    && String(row.CommandLine ?? "").includes("--supervised-child"),
  );
}

function instancePostmasters(snapshot, databaseDir) {
  const needle = databaseDir.toLowerCase();
  return snapshot.filter((row) =>
    String(row.Name ?? "").toLowerCase() === "postgres.exe"
    && String(row.CommandLine ?? "").toLowerCase().includes(needle),
  );
}

function writeConfig({ configPath, instanceRoot, appPort, databasePort }) {
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: databasePort,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: path.join(instanceRoot, "data", "backups"),
      },
    },
    logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: appPort,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(instanceRoot, "data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets", "master.key") },
    },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function buildIsolatedEnvironment({ taskRoot, homeRoot, instanceId, configPath }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) delete env[key];
  }
  for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "HOST", "PORT"]) delete env[key];
  const tempDir = path.join(taskRoot, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  return {
    ...env,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    PAPERCLIP_HOME: homeRoot,
    PAPERCLIP_INSTANCE_ID: instanceId,
    PAPERCLIP_CONFIG: configPath,
    PAPERCLIP_WINDOWS_RUN_ACCEPTANCE_HARNESS: "1",
    PAPERCLIP_DB_BACKUP_ENABLED: "true",
    PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS: "24",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    SERVE_UI: "false",
  };
}

function createApi(baseUrl) {
  return async function api(method, pathname, body) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
      body: body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8"),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value = null;
    if (text) {
      try { value = JSON.parse(text); } catch { value = text; }
    }
    if (!response.ok) {
      throw new Error(`${method} ${pathname} returned ${response.status}: ${text.slice(0, 1000)}`);
    }
    return value;
  };
}

function tail(value, limit = 16_000) {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

async function main() {
  assertWindowsNodeVersion();
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const cliEntrypoint = path.join(repoRoot, "cli", "src", "index.ts");
  const tsxLoader = path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "loader.mjs");
  assert.ok(fs.existsSync(cliEntrypoint), `Missing CLI entrypoint: ${cliEntrypoint}`);
  assert.ok(fs.existsSync(tsxLoader), "Install workspace dependencies before running the smoke harness.");

  const tempBase = assertUnderWindowsTemp(process.env.PAPERCLIP_WINDOWS_SMOKE_ROOT ?? "C:\\temp");
  fs.mkdirSync(tempBase, { recursive: true });
  const taskRoot = fs.mkdtempSync(path.join(tempBase, "paperclip-win-listener-recovery-"));
  const instanceId = `win-listener-recovery-${process.pid}-${Date.now()}`;
  const homeRoot = path.join(taskRoot, "home");
  const instanceRoot = path.join(homeRoot, "instances", instanceId);
  const configPath = path.join(instanceRoot, "config.json");
  const runtimeInfoPath = path.join(instanceRoot, "runtime-info.json");
  const databaseDir = path.join(instanceRoot, "db");
  const appPort = await allocatePort(new Set([WORKING_LISTENER_PORT]));
  const databasePort = await allocatePort(new Set([WORKING_LISTENER_PORT, appPort]));
  assert.notEqual(appPort, WORKING_LISTENER_PORT);
  writeConfig({ configPath, instanceRoot, appPort, databasePort });

  const childEnv = buildIsolatedEnvironment({ taskRoot, homeRoot, instanceId, configPath });
  let output = "";
  const messages = [];
  let supervisor;
  let success = false;

  try {
    supervisor = spawn(process.execPath, [
      "--import", pathToFileURL(tsxLoader).href,
      cliEntrypoint,
      "run",
      "--config", configPath,
      "--instance", instanceId,
      "--force",
    ], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    assert.ok(supervisor.pid, "Failed to start the paperclipai run supervisor.");
    supervisor.stdout.on("data", (chunk) => { output = tail(output + chunk.toString("utf8"), 2_000_000); });
    supervisor.stderr.on("data", (chunk) => { output = tail(output + chunk.toString("utf8"), 2_000_000); });
    supervisor.on("message", (message) => messages.push(message));

    const baseUrl = `http://127.0.0.1:${appPort}`;
    const api = createApi(baseUrl);
    const initialHealth = await waitFor("initial Paperclip health", async () => {
      if (supervisor.exitCode !== null) {
        throw new FatalSmokeError(`paperclipai run exited before health became ready (exit=${supervisor.exitCode}).\n${tail(output)}`);
      }
      const earlyChildExit = messages.find((message) => message?.type === ACCEPTANCE_CHILD_EXIT);
      if (earlyChildExit) {
        throw new FatalSmokeError(`supervised child exited before health became ready (${JSON.stringify(earlyChildExit)}).\n${tail(output)}`);
      }
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const health = await response.json();
      return health.status === "ok" ? health : null;
    }, STARTUP_TIMEOUT_MS, 500);
    assert.equal(initialHealth.status, "ok");

    const initialRuntime = readJson(runtimeInfoPath);
    const oldServerPid = initialRuntime.pid;
    assert.ok(isPidAlive(oldServerPid), `Initial server child ${oldServerPid} is not alive.`);
    const initialSnapshot = windowsProcessSnapshot();
    const initialServerChildren = directServerChildren(initialSnapshot, supervisor.pid);
    const oldPostmasters = instancePostmasters(initialSnapshot, databaseDir);
    assert.equal(initialServerChildren.length, 1, "Expected exactly one initial supervised server child.");
    assert.equal(initialServerChildren[0].ProcessId, oldServerPid);
    assert.equal(oldPostmasters.length, 1, "Expected exactly one initial embedded PostgreSQL postmaster.");

    await api("POST", "/api/instance/database-backups", {});
    const backedUpHealth = await api("GET", "/api/health");
    assert.equal(backedUpHealth.status, "ok");
    assert.equal(backedUpHealth.databaseBackup?.status, "ok");

    const company = await api("POST", "/api/companies", { name: `Windows Recovery Smoke ${Date.now()}` });
    const goal = await api("POST", `/api/companies/${company.id}/goals`, {
      title: "Verify listener process-loss recovery",
      level: "company",
      status: "active",
    });
    const terminalAgent = await api("POST", `/api/companies/${company.id}/agents`, {
      name: "Terminal Recovery Fixture",
      role: "qa",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], graceSec: 5 },
    });
    const activeAgent = await api("POST", `/api/companies/${company.id}/agents`, {
      name: "Active Recovery Fixture",
      role: "qa",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
        graceSec: 5,
      },
    });
    const terminalIssue = await api("POST", `/api/companies/${company.id}/issues`, {
      title: "Terminal run must not replay",
      status: "todo",
      priority: "high",
      assigneeAgentId: terminalAgent.id,
      goalId: goal.id,
    });
    const activeIssue = await api("POST", `/api/companies/${company.id}/issues`, {
      title: "Active run must retry exactly once",
      status: "todo",
      priority: "high",
      assigneeAgentId: activeAgent.id,
      goalId: goal.id,
    });

    const terminalRun = await api("POST", `/api/agents/${terminalAgent.id}/heartbeat/invoke`, {
      reason: "windows_listener_recovery_terminal_fixture",
    });
    await waitFor("terminal fixture run", async () => {
      const run = await api("GET", `/api/heartbeat-runs/${terminalRun.id}`);
      if (["failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) {
        throw new FatalSmokeError(`Terminal fixture entered ${run.status}: ${JSON.stringify(run)}`);
      }
      return run.status === "succeeded" ? run : null;
    }, 60_000);
    await api("PATCH", `/api/issues/${terminalIssue.id}`, {
      status: "done",
      comment: "Windows recovery terminal fixture completed.",
    });
    await waitFor("terminal fixture issue", async () => {
      const issue = await api("GET", `/api/issues/${terminalIssue.id}`);
      return issue.status === "done" ? issue : null;
    }, 30_000);
    const terminalRunsBefore = await api("GET", `/api/companies/${company.id}/heartbeat-runs?agentId=${terminalAgent.id}&limit=100`);

    const activeRun = await api("POST", `/api/agents/${activeAgent.id}/heartbeat/invoke`, {
      reason: "windows_listener_recovery_active_fixture",
    });
    const runningActive = await waitFor("active fixture process", async () => {
      const run = await api("GET", `/api/heartbeat-runs/${activeRun.id}`);
      return run.status === "running" && Number.isInteger(run.processPid) ? run : null;
    }, 60_000);
    assert.ok(isPidAlive(runningActive.processPid), `Active fixture process ${runningActive.processPid} is not alive.`);

    const recoveryStartedAt = performance.now();
    supervisor.send({ type: ACCEPTANCE_CLOSE_LISTENER });
    const closeAck = await waitFor("listener close acknowledgement", async () => {
      const failure = messages.find((message) => message?.type === ACCEPTANCE_ERROR);
      if (failure) throw new Error(failure.message);
      return messages.find((message) => message?.type === ACCEPTANCE_LISTENER_CLOSED) ?? null;
    }, 15_000);
    assert.equal(closeAck.pid, oldServerPid);
    assert.ok(isPidAlive(oldServerPid), "The old Node child exited before listener loss was observed.");
    await waitFor("listener loss", async () => listeningPids(appPort).length === 0, 15_000);
    assert.ok(isPidAlive(oldServerPid), "The old Node child did not remain alive after its listener closed.");

    const recovered = await waitFor("bounded listener recovery", async () => {
      if (!fs.existsSync(runtimeInfoPath)) return null;
      const runtime = readJson(runtimeInfoPath);
      if (runtime.pid === oldServerPid) return null;
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) return null;
        const health = await response.json();
        if (health.status !== "ok" || health.databaseBackup?.status !== "ok") return null;
        return { runtime, health };
      } catch {
        return null;
      }
    }, RECOVERY_TIMEOUT_MS, 500);
    const recoveryMs = Math.round(performance.now() - recoveryStartedAt);
    const newServerPid = recovered.runtime.pid;
    assert.notEqual(newServerPid, oldServerPid);
    await waitFor("old server child exit", async () => !isPidAlive(oldServerPid), 30_000);

    const finalSnapshot = windowsProcessSnapshot();
    const finalServerChildren = directServerChildren(finalSnapshot, supervisor.pid);
    const finalPostmasters = instancePostmasters(finalSnapshot, databaseDir);
    const finalListeners = listeningPids(appPort);
    assert.equal(finalServerChildren.length, 1, "Expected exactly one final supervised server child.");
    assert.equal(finalServerChildren[0].ProcessId, newServerPid);
    assert.deepEqual(finalListeners, [newServerPid], "Expected exactly one final listener owned by the replacement child.");
    assert.equal(finalPostmasters.length, 1, "Expected exactly one final embedded PostgreSQL postmaster.");
    for (const oldPostmaster of oldPostmasters) {
      assert.ok(!isPidAlive(oldPostmaster.ProcessId), `Old postmaster ${oldPostmaster.ProcessId} is orphaned.`);
    }

    const activeRunsAfter = await waitFor("exactly one process-loss retry", async () => {
      const runs = await api("GET", `/api/companies/${company.id}/heartbeat-runs?agentId=${activeAgent.id}&limit=100`);
      const original = runs.find((run) => run.id === activeRun.id);
      const retries = runs.filter((run) => run.retryOfRunId === activeRun.id);
      return original?.status === "interrupted" && retries.length === 1 ? { runs, original, retry: retries[0] } : null;
    }, 60_000);
    assert.equal(
      activeRunsAfter.original.errorCode,
      "server_shutdown_interrupted",
      `Unexpected original run recovery state: ${JSON.stringify(activeRunsAfter.original)}`,
    );
    assert.equal(
      activeRunsAfter.retry.processLossRetryCount,
      1,
      `Unexpected retry accounting: ${JSON.stringify(activeRunsAfter.retry)}`,
    );
    assert.ok(
      ["queued", "running", "failed"].includes(activeRunsAfter.retry.status),
      `Unexpected retry status: ${JSON.stringify(activeRunsAfter.retry)}`,
    );
    if (activeRunsAfter.retry.status === "failed") {
      assert.equal(activeRunsAfter.retry.errorCode, "process_lost");
    }

    const terminalRunsAfter = await api("GET", `/api/companies/${company.id}/heartbeat-runs?agentId=${terminalAgent.id}&limit=100`);
    const terminalIssueAfter = await api("GET", `/api/issues/${terminalIssue.id}`);
    assert.equal(terminalIssueAfter.status, "done");
    assert.equal(terminalRunsAfter.length, terminalRunsBefore.length, "Terminal agent unexpectedly ran again.");
    assert.equal(terminalRunsAfter.filter((run) => run.retryOfRunId === terminalRun.id).length, 0);

    const restoredMarker = `oldPid=${oldServerPid} newPid=${newServerPid} health=ok databaseBackup=ok`;
    await waitFor("ordered recovery success log", async () => output.includes(restoredMarker), 10_000);
    const reasonIndex = output.indexOf(`reason=listener_loss oldPid=${oldServerPid}`);
    const newChildIndex = output.indexOf(`started server child pid=${newServerPid}`);
    const restoredIndex = output.indexOf(restoredMarker);
    assert.ok(reasonIndex >= 0, "Recovery log is missing listener_loss reason and old PID.");
    assert.ok(newChildIndex > reasonIndex, "Replacement child started before the listener-loss restart was logged.");
    assert.ok(restoredIndex > newChildIndex, "Recovery success was logged before the replacement child started.");

    const lockPath = path.join(instanceRoot, "windows-run-supervisor.lock");
    assert.equal(fs.readFileSync(lockPath, "utf8").trim().split(":", 1)[0], String(supervisor.pid));

    const summary = {
      status: "passed",
      platform: process.platform,
      node: process.version,
      instanceId,
      appPort,
      workingListener3100Used: false,
      oldServerPid,
      newServerPid,
      oldPostmasterPids: oldPostmasters.map((row) => row.ProcessId),
      newPostmasterPids: finalPostmasters.map((row) => row.ProcessId),
      finalListenerPids: finalListeners,
      finalServerChildCount: finalServerChildren.length,
      recoveryMs,
      recoveryBoundMs: RECOVERY_TIMEOUT_MS,
      health: recovered.health.status,
      databaseBackup: recovered.health.databaseBackup.status,
      restartReason: "listener_loss",
      activeRun: {
        oldRunId: activeRun.id,
        oldStatus: activeRunsAfter.original.status,
        retryRunId: activeRunsAfter.retry.id,
        retryCount: activeRunsAfter.retry.processLossRetryCount,
        retryStatus: activeRunsAfter.retry.status,
        retryErrorCode: activeRunsAfter.retry.errorCode,
      },
      terminalRun: {
        issueId: terminalIssue.id,
        runId: terminalRun.id,
        status: terminalIssueAfter.status,
        replayCount: 0,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    success = true;
  } finally {
    if (supervisor && supervisor.exitCode === null) {
      try { supervisor.send({ type: ACCEPTANCE_SHUTDOWN }); } catch {}
      await waitFor("acceptance supervisor shutdown", async () => supervisor.exitCode !== null, 45_000).catch(() => null);
    }
    if (supervisor?.pid && isPidAlive(supervisor.pid)) {
      try {
        execFileSync("taskkill.exe", ["/pid", String(supervisor.pid), "/t", "/f"], {
          stdio: "ignore",
          timeout: 30_000,
          windowsHide: true,
        });
      } catch {}
    }
    if (!success) process.stderr.write(`\n--- paperclipai run output tail ---\n${tail(output, 4_000)}\n`);
    fs.rmSync(taskRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
