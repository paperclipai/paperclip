import { parseRestartRunnerIdentity, type RestartRunnerIdentity } from "./process-tree-owner.js";
import { usesInstalledCli, verifyInstalledCli } from "./installed-cli.js";
import { runnerMatrix } from "./catalog.js";
import { createRunnerE2EServerStopper, runnerE2EServerDetached } from "./server-stop.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";
import { qualifyLegacyClaudeCli } from "./legacy-claude-cli.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareRunnerE2EServerConfig } from "./server-config.js";
import { installedReleaseEnvironment, installedReleaseLaunch } from "./installed-release.js";
import {
  assertIsolatedServerEnvironment,
  buildPaperclipServerEnvironment,
  runnerE2EServerControlPaths,
} from "./harness-env.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const logPath = required("PAPERCLIP_RUNNER_E2E_SERVER_LOG");
const temporaryRoot = required("PAPERCLIP_RUNNER_E2E_TEMP_ROOT");
const paperclipHome = required("PAPERCLIP_HOME");
const configPath = required("PAPERCLIP_CONFIG");
const port = required("PAPERCLIP_RUNNER_E2E_PORT");
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const paperclipCli = path.join(repositoryRoot, "tests/runner-e2e/server-entry.ts");
const executionIds: string[] = JSON.parse(process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "[]");
const selectedExecutions = usesInstalledCli(process.env) ? executionIds.map(id => {
  const execution = runnerMatrix.find(row => row.id === id);
  if (!execution) throw new Error("Unknown installed CLI proof execution");
  return execution;
}) : [];
const {
  controlDirectory,
  restartRequestPath,
  restartAcknowledgementPath: restartAckPath,
} = runnerE2EServerControlPaths(temporaryRoot);
const restartTimeoutMs = 180_000;
const gracefulStopTimeoutMs = 30_000;
const installedRelease = process.env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI
  ? installedReleaseLaunch(process.env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI) : null;
const serverEnvironment = buildPaperclipServerEnvironment(installedRelease
  ? installedReleaseEnvironment(process.env, repositoryRoot, path.join(temporaryRoot, "provider-bin"))
  : process.env, {
  NODE_ENV: "test",
  PORT: port,
  // Keep provider caches attempt-private without changing Playwright's browser
  // cache lookup in the parent process.
  XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
  PAPERCLIP_HOME: paperclipHome,
  PAPERCLIP_CONFIG: configPath,
  PAPERCLIP_INSTANCE_ID: required("PAPERCLIP_INSTANCE_ID"),
  PAPERCLIP_AGENT_JWT_SECRET: required("PAPERCLIP_AGENT_JWT_SECRET"),
  PAPERCLIP_DECISION_SIGNING_SECRET: required(
    "PAPERCLIP_DECISION_SIGNING_SECRET",
  ),
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: required(
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  ),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  PAPERCLIP_BIND: "loopback",
  PAPERCLIP_BIND_HOST: "127.0.0.1",
  PAPERCLIP_DEPLOYMENT_MODE: process.env.PAPERCLIP_RUNNER_E2E_PUBLIC_MCP === "1" ? "authenticated" : "local_trusted",
  ...(process.env.PAPERCLIP_RUNNER_E2E_PUBLIC_MCP === "1" ? {
    PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PAPERCLIP_AUTH_BASE_URL_MODE: "explicit",
    // Use empty provider configuration as the managed homes' seed. A local
    // operator's installed plugins, MCP connections and auth are not fixtures.
    CODEX_HOME: path.join(temporaryRoot, "provider-config", "codex"),
    CLAUDE_CONFIG_DIR: path.join(temporaryRoot, "provider-config", "claude"),
  } : {}),
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  SERVE_UI: "true",
  PAPERCLIP_STORAGE_PROVIDER: "local_disk",
  PAPERCLIP_STORAGE_LOCAL_DIR: path.join(temporaryRoot, "storage"),
  PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
  PAPERCLIP_SECRETS_STRICT_MODE: "true",
  PAPERCLIP_DB_BACKUP_ENABLED: "false",
  PAPERCLIP_DB_BACKUP_DIR: path.join(temporaryRoot, "backups"),
  // Onboarding normally opens the app after listen. Browser ownership belongs
  // to Playwright in this harness, so never create a developer desktop tab.
  PAPERCLIP_OPEN_ON_LISTEN: "false",
});
assertIsolatedServerEnvironment(serverEnvironment, {
  temporaryRoot,
  paperclipHome,
  configPath,
});
const definedServerEnvironment = Object.fromEntries(
  Object.entries(serverEnvironment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

await Promise.all([
  mkdir(path.dirname(logPath), { recursive: true }),
  mkdir(controlDirectory, { recursive: true, mode: 0o700 }),
  ...(process.env.PAPERCLIP_RUNNER_E2E_PUBLIC_MCP === "1" ? [
    mkdir(path.join(temporaryRoot, "provider-config", "codex"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(temporaryRoot, "provider-config", "claude"), { recursive: true, mode: 0o700 }),
  ] : []),
]);
const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const expectedStops = new WeakSet<ChildProcess>();
const childErrors = new WeakMap<ChildProcess, Error>();
let child: ChildProcess | null = null;
let unexpectedChildFailure: Error | null = null;
let shutdownSignal: NodeJS.Signals | null = null;
let activeRestartRequestId: string | null = null;

function appendLog(message: string) {
  process.stderr.write(message);
  log.write(message);
}

function shutdownRequested() {
  return shutdownSignal !== null;
}

function childExited(candidate: ChildProcess) {
  return candidate.exitCode !== null || candidate.signalCode !== null;
}

function describeChildExit(candidate: ChildProcess) {
  const spawnError = childErrors.get(candidate);
  if (spawnError) return `server spawn failed: ${spawnError.message}`;
  return `server exited code=${String(candidate.exitCode)} signal=${String(candidate.signalCode)}`;
}

async function startServer() {
  if (shutdownRequested()) {
    throw new Error("Refusing to start Paperclip after wrapper shutdown");
  }
  // Recheck bytes and dependency resolution on every controller restart.
  const installed = await verifyInstalledCli(process.env, selectedExecutions);
  const candidate = spawn(
    process.execPath,
    installed ? [installed.entry, "onboard", "--yes", "--run"] : runnerE2ETypeScriptProcessArgs(repositoryRoot, paperclipCli, ["onboard", "--yes", "--run"]),
    {
      cwd: installedRelease?.cwd ?? repositoryRoot,
      env: definedServerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      // Playwright signals the wrapper's group. Keep that signal from bypassing
      // our single graceful stop; the launcher still tracks descendant groups.
      detached: runnerE2EServerDetached,
    },
  );
  child = candidate;

  candidate.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  candidate.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
  candidate.once("error", (error) => {
    childErrors.set(candidate, error);
    if (!expectedStops.has(candidate) && !shutdownRequested()) {
      unexpectedChildFailure = new Error(
        `Paperclip server spawn failed: ${error.message}`,
      );
    }
  });
  candidate.once("exit", () => {
    appendLog(`\n${describeChildExit(candidate)}\n`);
    if (!expectedStops.has(candidate) && !shutdownRequested()) {
      unexpectedChildFailure = new Error(
        `Paperclip server stopped unexpectedly: ${describeChildExit(candidate)}`,
      );
    }
  });

  // A shutdown may arrive in the synchronous interval around spawn. Never let
  // that race create an unowned replacement server.
  if (shutdownSignal) {
    // The main/error path awaits this same promise and reports any failure.
    void stopServer(candidate, shutdownSignal).catch(() => {});
  }
  await stopServer.watch(candidate);
  return candidate;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const stopServer = createRunnerE2EServerStopper({
  gracefulTimeoutMs: gracefulStopTimeoutMs,
  forcedTimeoutMs: 5_000,
  hasSpawnError: (candidate) => childErrors.has(candidate),
  markExpectedStop: (candidate) => { expectedStops.add(candidate); },
  log: appendLog,
});

async function waitForHealth(candidate: ChildProcess) {
  const deadline = Date.now() + restartTimeoutMs;
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    if (shutdownRequested()) {
      throw new Error("Wrapper shutdown interrupted the Paperclip restart");
    }
    if (childErrors.has(candidate) || childExited(candidate)) {
      throw new Error(
        `Replacement Paperclip server could not start: ${describeChildExit(candidate)}`,
      );
    }
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The replacement process may still be booting.
    }
    await delay(250);
  }
  throw new Error(
    `Replacement Paperclip server did not become healthy within ${restartTimeoutMs}ms`,
  );
}

async function waitForHealthToStop() {
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + gracefulStopTimeoutMs;
  while (Date.now() < deadline) {
    if (shutdownRequested()) {
      throw new Error("Wrapper shutdown interrupted the Paperclip restart");
    }
    try {
      await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(
    "The old Paperclip server remained healthy after its launcher exited",
  );
}

interface RestartRequest {
  requestId: string;
  preserveRunner?: RestartRunnerIdentity;
}

async function readRestartRequest(): Promise<RestartRequest | null> {
  let encoded: string;
  try {
    encoded = await readFile(restartRequestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    // The writer may not have completed its atomic replacement yet.
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const requestId = (value as { requestId?: unknown }).requestId;
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)
  ) {
    return null;
  }
  const preserveRunner = (value as { preserveRunner?: unknown }).preserveRunner;
  return { requestId, ...(preserveRunner === undefined ? {} : { preserveRunner: parseRestartRunnerIdentity(preserveRunner) }) };
}

async function writeRestartAck(
  requestId: string,
  status: "ready" | "failed",
  message?: string,
) {
  const temporaryAckPath = `${restartAckPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryAckPath,
    `${JSON.stringify({
      requestId,
      status,
      completedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryAckPath, restartAckPath);
}

async function restartServer({ requestId, preserveRunner }: RestartRequest) {
  activeRestartRequestId = requestId;
  appendLog(`\nRestart request ${requestId}: stopping Paperclip\n`);
  const previous = child;
  if (!previous) throw new Error("No Paperclip server is available to restart");
  if (preserveRunner) await stopServer.forRestart(previous, preserveRunner);
  else await stopServer(previous);
  if (child === previous) child = null;
  // Do not mistake an orphaned old server for a healthy replacement. The port
  // must stop answering before the next launcher is allowed to start.
  await waitForHealthToStop();
  if (shutdownRequested()) {
    throw new Error("Wrapper shutdown interrupted the Paperclip restart");
  }

  appendLog(`Restart request ${requestId}: starting Paperclip\n`);
  const replacement = await startServer();
  await waitForHealth(replacement);
  if (shutdownRequested()) {
    throw new Error("Wrapper shutdown interrupted the Paperclip restart");
  }
  await writeRestartAck(requestId, "ready");
  appendLog(`Restart request ${requestId}: Paperclip is healthy\n`);
  activeRestartRequestId = null;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    if (!child) return;
    // Begin immediately, including during a health/restart wait. The final
    // cleanup joins this promise instead of sending a second graceful signal.
    void stopServer(child, signal).catch(() => {});
  });
}

async function supervise() {
  const executionIds: string[] = JSON.parse(process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "[]");
  if (executionIds.some(id => id.includes(".legacy-claude.local.") || /\.assistant-claude-(?:haiku|sonnet)\.local\./.test(id))) {
    definedServerEnvironment.PATH = await qualifyLegacyClaudeCli(temporaryRoot, definedServerEnvironment);
  }
  const databaseReservation = await prepareRunnerE2EServerConfig({
    temporaryRoot,
    configPath,
    serverPort: Number(port),
  });
  // Postgres needs the socket itself; release immediately before child spawn.
  await databaseReservation?.close();
  await startServer();
  let lastRestartRequestId: string | null = null;
  while (!shutdownRequested()) {
    if (unexpectedChildFailure) throw unexpectedChildFailure;
    const request = await readRestartRequest();
    if (request && request.requestId !== lastRestartRequestId) {
      lastRestartRequestId = request.requestId;
      await restartServer(request);
    }
    await delay(200);
  }

  await stopServer.stopAll(shutdownSignal ?? "SIGTERM");
}

let exitCode = 0;
try {
  await supervise();
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  appendLog(`\nPaperclip E2E server supervisor failed: ${message}\n`);
  if (activeRestartRequestId) {
    try {
      await writeRestartAck(activeRestartRequestId, "failed", message);
    } catch (ackError) {
      appendLog(
        `Failed to write restart acknowledgement: ${ackError instanceof Error ? ackError.message : String(ackError)}\n`,
      );
    }
  }
  try {
    await stopServer.stopAll();
  } catch (stopError) {
    appendLog(`Failed to stop Paperclip after supervisor failure: ${stopError instanceof Error ? stopError.message : String(stopError)}\n`);
  }
}

await new Promise<void>((resolve) => log.end(resolve));
process.exitCode = exitCode;
