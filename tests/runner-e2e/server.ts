import { readRestartRequest, type RestartRequest } from "./server-restart-request.js";
import { startCursorCloudCallbackProxy } from "./cursor-cloud-callback-proxy.js";
import { prepareControllerDatabase } from "./controller-database.js";
import { readUpgradeArtifacts, verifyUpgradeArtifact, assertServingArtifact, upgradeArtifactKey, type ServingArtifact } from "./upgrade-artifacts.js";
import { createControllerRecoveryObserver } from "./controller-recovery-observer.js";
import { readFinalizationCrashBoundary } from "./finalization-crash-boundary.js";
import { replaceController, retireControllerCache, type ControllerOutageReceipt } from "./controller-outage.js";
import { recoverInterruptedFeedback } from "./feedback-recovery.js";
import { normalizedSecrets } from "./redaction.js";
import { CREDENTIAL_NAMES } from "./types.js";
import { EVAL_OBSERVABILITY_SECRET_NAMES } from "./braintrust.js";
import { usesInstalledCli, verifyInstalledCli } from "./installed-cli.js";
import { runnerMatrix } from "./catalog.js";
import { createRunnerE2EServerStopper, runnerE2EServerDetached } from "./server-stop.js";
import { runnerE2ETypeScriptProcessArgs } from "./web-server-command.js";
import { qualifyLegacyClaudeCli } from "./legacy-claude-cli.js";
import { prepareSourceServerDependencies } from "./source-startup.js";
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
const upgradeArtifacts = await readUpgradeArtifacts(process.env[upgradeArtifactKey]);
let artifactIndex = 0;
const selectedExecutions = usesInstalledCli(process.env) || upgradeArtifacts ? executionIds.map(id => {
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
const initialCli = upgradeArtifacts?.artifacts.A.pins.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI ?? process.env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI;
const installedRelease = initialCli ? installedReleaseLaunch(initialCli) : null;
const servingArtifacts = new WeakMap<ChildProcess, ServingArtifact>();
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

await prepareSourceServerDependencies(repositoryRoot, definedServerEnvironment, Boolean(installedRelease));

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
let feedbackRecovery: Promise<void> | undefined;
let controllerDatabase: Awaited<ReturnType<typeof prepareControllerDatabase>> | undefined;

function recoverFeedbackBeforeShutdown() {
  return feedbackRecovery ??= (async () => {
    const privateDir = process.env.PAPERCLIP_RUNNER_E2E_PRIVATE_DIR;
    const campaignId = process.env.PAPERCLIP_E2E_ACCOUNTING_CAMPAIGN_ID;
    const attemptId = process.env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID;
    if (!privateDir || !campaignId || !attemptId || process.env.PAPERCLIP_RUNNER_E2E_PUBLIC_MCP === "1") return;
    const deadlineAt = Date.now() + 5_000;
    const secrets = normalizedSecrets([...CREDENTIAL_NAMES, ...EVAL_OBSERVABILITY_SECRET_NAMES,
      "PAPERCLIP_E2E_GATEWAY_TOKEN", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_DECISION_SIGNING_SECRET",
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "BETTER_AUTH_SECRET"].map(name => process.env[name]));
    for (const executionId of executionIds) {
      if (Date.now() >= deadlineAt) break;
      const execution = runnerMatrix.find(row => row.id === executionId);
      if (!execution) continue;
      try {
        await recoverInterruptedFeedback({ identity: { campaignId, attemptId, executionId },
          caseDirectory: path.join(privateDir, "cases", execution.task.id), secrets, deadlineAt,
          api: { async get<T>(endpoint: string, options?: { timeout: number }): Promise<T> {
            const base = `http://127.0.0.1:${port}`;
            const url = new URL(endpoint, base);
            if (url.origin !== base || !url.pathname.startsWith("/api/")) throw new Error("Invalid feedback recovery endpoint");
            const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(options?.timeout ?? 1_000, deadlineAt - Date.now()))) });
            if (!response.ok) { await response.body?.cancel(); throw new Error("Feedback recovery read failed"); }
            return response.json() as Promise<T>;
          } },
        });
      } catch { appendLog("Feedback recovery checkpoint unavailable; retain private recovery state.\n"); }
    }
  })();
}

async function stopWithFeedback(candidate: ChildProcess, signal: NodeJS.Signals) {
  await recoverFeedbackBeforeShutdown();
  await stopServer(candidate, signal);
}

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
  const selected = upgradeArtifacts?.sequence[artifactIndex];
  if (upgradeArtifacts && !selected) throw new Error("Upgrade artifact sequence exhausted");
  const verified = selected ? await verifyUpgradeArtifact(upgradeArtifacts!.artifacts[selected], process.env, selectedExecutions) : undefined;
  const installed = verified?.installed ?? await verifyInstalledCli(process.env, selectedExecutions);
  const launch = installed ? installedReleaseLaunch(installed.entry) : null;
  // The serving process must report its baked-in revision, never a test-supplied SHA.
  const environment = { ...definedServerEnvironment };
  if (upgradeArtifacts) {
    delete environment.PAPERCLIP_BUILD_COMMIT;
    delete environment[upgradeArtifactKey];
    environment.GIT_CEILING_DIRECTORIES = upgradeArtifacts.artifacts[selected!].root;
  }
  const candidate = spawn(
    process.execPath,
    installed ? [installed.entry, "onboard", "--yes", "--run"] : runnerE2ETypeScriptProcessArgs(repositoryRoot, paperclipCli, ["onboard", "--yes", "--run"]),
    {
      cwd: launch?.cwd ?? repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      // Playwright signals the wrapper's group. Keep that signal from bypassing
      // our single graceful stop; the launcher still tracks descendant groups.
      detached: runnerE2EServerDetached,
    },
  );
  child = candidate;
  if (verified) servingArtifacts.set(candidate, verified.receipt);

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
    void stopWithFeedback(candidate, shutdownSignal).catch(() => {});
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
      if (response.ok) {
        const artifact = servingArtifacts.get(candidate);
        if (artifact) assertServingArtifact(await response.json(), artifact);
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("serving server revision")) throw error;
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


async function writeRestartAck(
  requestId: string,
  status: "ready" | "failed",
  message?: string,
  controllerCacheDiscarded = false,
  crashBoundary?: Awaited<ReturnType<typeof readFinalizationCrashBoundary>>,
  controllerOutage?: ControllerOutageReceipt,
) {
  const temporaryAckPath = `${restartAckPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryAckPath,
    `${JSON.stringify({
      requestId,
      status,
      controllerCacheDiscarded,
      completedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
      ...(crashBoundary ? { crashBoundary } : {}),
      ...(controllerOutage ? { controllerOutage } : {}),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryAckPath, restartAckPath);
}

async function restartServer({ requestId, preserveRunner, discardControllerCache, crashAfterResult, controllerOutage, recoveryBinding, controllerDowntimeMs = 0 }: RestartRequest) {
  activeRestartRequestId = requestId;
  appendLog(`\nRestart request ${requestId}: stopping Paperclip\n`);
  const previous = child;
  if (!previous) throw new Error("No Paperclip server is available to restart");
  const discardCache = async () => {
    const cache = path.join(paperclipHome, "instances", required("PAPERCLIP_INSTANCE_ID"), "runtime", "paperclip-runner");
    await retireControllerCache(cache, path.join(controlDirectory, `retired-controller-cache-${requestId}`));
    appendLog(`Restart request ${requestId}: old controller cache made unavailable\n`);
  };
  if (controllerOutage) {
    if (upgradeArtifacts) artifactIndex += 1;
    const previousArtifact = servingArtifacts.get(previous);
    const observer = recoveryBinding ? await createControllerRecoveryObserver(configPath, recoveryBinding) : undefined;
    try {
      const receipt = await replaceController({ requestId, previousPid: previous.pid!, outage: controllerOutage,
        stop: async signal => {
          if (signal === "SIGKILL") await stopServer.crashForRestart(previous);
          else await stopServer(previous);
          if (child === previous) child = null;
        },
        waitForUnhealthy: waitForHealthToStop, discardCache, start: startServer, waitForReady: waitForHealth,
        ...(previousArtifact ? { previousArtifact, replacementArtifact: () => child && servingArtifacts.get(child) || undefined } : {}),
        cancelled: shutdownRequested,
        afterStopped: observer?.stopped,
        afterReady: observer ? (receipt, record) => observer.recovered(receipt, record, shutdownRequested) : undefined,
        record: async receipt => {
          const target = path.join(controlDirectory, `controller-outage-${requestId}.json`);
          await writeFile(`${target}.tmp`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
          await rename(`${target}.tmp`, target);
        },
      });
      await writeRestartAck(requestId, "ready", undefined, true, undefined, receipt);
      appendLog(`Restart request ${requestId}: Paperclip is healthy after ${Math.round(receipt.readyAfterMs!)}ms\n`);
      activeRestartRequestId = null;
      return;
    } finally { await observer?.close(); }
  }
  const crashBoundary = crashAfterResult ? await readFinalizationCrashBoundary(async route => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!response.ok) throw new Error("Finalization crash boundary could not be read");
    return response.json();
  }, crashAfterResult) : undefined;
  if (crashBoundary) await stopServer.crashForRestart(previous);
  else if (preserveRunner) await stopServer.forRestart(previous, preserveRunner);
  else await stopServer(previous);
  if (child === previous) child = null;
  // Do not mistake an orphaned old server for a healthy replacement. The port
  // must stop answering before the next launcher is allowed to start.
  await waitForHealthToStop();
  const downtimeDeadline = Date.now() + controllerDowntimeMs;
  while (Date.now() < downtimeDeadline) {
    if (shutdownRequested()) throw new Error("Wrapper shutdown interrupted controller downtime");
    await delay(Math.min(250, downtimeDeadline - Date.now()));
  }
  if (discardControllerCache) {
    await discardCache();
  }
  if (shutdownRequested()) {
    throw new Error("Wrapper shutdown interrupted the Paperclip restart");
  }

  appendLog(`Restart request ${requestId}: starting Paperclip\n`);
  const replacement = await startServer();
  await waitForHealth(replacement);
  if (shutdownRequested()) {
    throw new Error("Wrapper shutdown interrupted the Paperclip restart");
  }
  await writeRestartAck(requestId, "ready", undefined, discardControllerCache, crashBoundary);
  appendLog(`Restart request ${requestId}: Paperclip is healthy\n`);
  activeRestartRequestId = null;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    if (!child) return;
    void stopWithFeedback(child, signal).catch(() => {});
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
  if (upgradeArtifacts || executionIds.some(id => id.endsWith(".recover-controller"))) {
    // The wrapper owns this sibling process. Killing the serving child must
    // leave Postgres available to the stopped-controller observer and successor.
    controllerDatabase = await prepareControllerDatabase(configPath, temporaryRoot);
  }
  const initial = await startServer();
  if (upgradeArtifacts) await waitForHealth(initial);
  let lastRestartRequestId: string | null = null;
  while (!shutdownRequested()) {
    if (unexpectedChildFailure) throw unexpectedChildFailure;
    const request = await readRestartRequest(restartRequestPath, executionIds);
    if (request && request.requestId !== lastRestartRequestId) {
      lastRestartRequestId = request.requestId;
      await restartServer(request);
    }
    await delay(200);
  }

  await recoverFeedbackBeforeShutdown();
  await stopServer.stopAll(shutdownSignal ?? "SIGTERM");
}

let exitCode = 0;
let closeCursorCloudCallbackProxy: (() => Promise<void>) | undefined;
try {
  if (executionIds.some(id => id.startsWith("cursor-cloud."))) closeCursorCloudCallbackProxy = await startCursorCloudCallbackProxy({ port: Number(required("PAPERCLIP_CURSOR_CLOUD_CALLBACK_PORT")), appPort: Number(port) });
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
    await recoverFeedbackBeforeShutdown();
    await stopServer.stopAll();
  } catch (stopError) {
    appendLog(`Failed to stop Paperclip after supervisor failure: ${stopError instanceof Error ? stopError.message : String(stopError)}\n`);
  }
}

try { await controllerDatabase?.cleanup(); }
catch (error) {
  exitCode = 1;
  appendLog(`Qualification database cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
}
await closeCursorCloudCallbackProxy?.();
await new Promise<void>((resolve) => log.end(resolve));
process.exitCode = exitCode;
