import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isImmutableDaytonaImage, runnerMatrix } from "./catalog.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { packageEvidence } from "./evidence.js";
import { classifyFailure, shouldRetryFailure } from "./failure-classifier.js";
import { buildRunnerCampaign } from "./history.js";
import {
  buildRunnerE2EProcessEnvironment,
  resolvePaperclipRemoteRunnerBinaryForHarness,
  resolvePaperclipRunnerBinaryForHarness,
} from "./harness-env.js";
import { assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import {
  assertSecretFree,
  findSecretLeakInDirectory,
  isEphemeralCodexRuntimeAuthFile,
  normalizedSecrets,
  sanitizeJson,
} from "./redaction.js";
import {
  buildMatrixJobs,
  parseRunnerSelectors,
  RunnerSelectorError,
  selectRunnerExecutions,
} from "./selectors.js";
import { resolveRunnerE2ESource } from "./source.js";
import {
  CREDENTIAL_NAMES,
  type MatrixExecution,
  type RunnerE2EResult,
} from "./types.js";
import {
  reapNewDetachedDarwinSharedMemory,
  snapshotDarwinSharedMemory,
} from "./shared-memory.js";
import { reserveRunnerE2EServerPort } from "./ports.js";
import {
  createResultExitGuard,
  enforceResultProcessIntegrity,
} from "./result-exit-guard.js";
import {
  observeDescendantProcessTree,
  refreshContinuouslyLiveProcessGroups,
  revalidateObservedProcessGroups,
  safeProcessGroupTerminationOrder,
  type ObservedProcessGroup,
  type ProcessObservation,
} from "./process-tree.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const localEnvPath = path.join(repositoryRoot, ".env.runner-e2e.local");
const resultsRoot = path.join(repositoryRoot, "tests/runner-e2e/results");
const activeProcessGroups = new Set<number>();
const activeProcessCleanup = new Map<number, Promise<string | null>>();
const activeProcessTerminators = new Map<number, () => void>();
const completedResultExitGraceMs = 120_000;
const diagnosticProcessKinds = new Set([
  "bash",
  "chrome",
  "codex",
  "google-chrome",
  "node",
  "paperclip-runnerd",
  "playwright",
  "pnpm",
  "postgres",
  "sh",
  "tsx",
]);
let cancelled = false;

function cleanId(value: string) {
  const result = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result)
    throw new Error(
      `Invalid empty identifier derived from ${JSON.stringify(value)}`,
    );
  return result;
}

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

async function makeDirectoryTreeRemovable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) =>
        makeDirectoryTreeRemovable(path.join(directory, entry.name)),
      ),
  );
}

function stopProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process tree already exited.
  }
}

function processGroupIsAlive(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessGroup(pid: number) {
  stopProcessGroup(pid, "SIGTERM");
  const gracefulDeadline = Date.now() + 5_000;
  while (processGroupIsAlive(pid) && Date.now() < gracefulDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!processGroupIsAlive(pid)) return null;
  stopProcessGroup(pid, "SIGKILL");
  const forcedDeadline = Date.now() + 5_000;
  while (processGroupIsAlive(pid) && Date.now() < forcedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return processGroupIsAlive(pid)
    ? `Paperclip/Playwright process group ${pid} survived SIGKILL`
    : null;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

interface ProcessTreeDiagnostic {
  summary: string;
  groups: ObservedProcessGroup[];
}

function observedGroupsSelectedForTermination(
  groups: readonly ObservedProcessGroup[],
  processGroupIds: readonly number[],
) {
  const selected = new Set(processGroupIds);
  return groups.filter((group) => selected.has(group.processGroupId));
}

async function readProcessTable(): Promise<ProcessObservation[] | null> {
  if (process.platform === "win32") {
    return null;
  }
  return await new Promise<ProcessObservation[] | null>((resolve) => {
    const inspector = spawn(
      "ps",
      ["-e", "-o", "pid=,ppid=,pgid=,lstart=,comm="],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    let settled = false;
    const finish = (value: ProcessObservation[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(inspectionTimeout);
      resolve(value);
    };
    const inspectionTimeout = setTimeout(() => {
      inspector.kill("SIGKILL");
      finish(null);
    }, 5_000);
    inspectionTimeout.unref();
    inspector.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(-1024 * 1024);
    });
    inspector.once("error", () => finish(null));
    inspector.once("close", () => {
      const observations = output
        .split(/\r?\n/)
        .map((line) =>
          /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
            line,
          ),
        )
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match): ProcessObservation => {
          // A target process can choose its own argv and process name. Emit a
          // fixed category instead of target-controlled text so diagnostics
          // can never turn that metadata into a secret-exfiltration channel.
          const command = path.basename(match[5]!);
          const kind = diagnosticProcessKinds.has(command) ? command : "other";
          return {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            started: match[4]!,
            kind,
          };
        });
      finish(observations);
    });
  }).catch(() => null);
}

async function processTreeDiagnostic(
  rootPid: number,
): Promise<ProcessTreeDiagnostic> {
  const table = await readProcessTable();
  if (!table) {
    return {
      summary: `process tree ${rootPid} (member inspection unavailable)`,
      groups: [],
    };
  }
  const observed = observeDescendantProcessTree(table, rootPid);
  const members = observed.members
    .slice(0, 64)
    .map(
      ({ process: candidate, depth }) =>
        `pid=${candidate.pid} ppid=${candidate.parentPid} pgid=${candidate.processGroupId} depth=${depth} kind=${candidate.kind}`,
    );
  const descendantGroupIds = observed.groups
    .filter((group) => group.processGroupId !== rootPid)
    .map((group) => group.processGroupId);
  return {
    summary:
      members.length > 0
        ? `process tree ${rootPid}: ${members.join("; ")}; descendant pgids=${descendantGroupIds.join(",") || "none"}`
        : `process tree ${rootPid}: no members reported`,
    groups: observed.groups,
  };
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cancelled = true;
    for (const pid of activeProcessGroups) {
      const terminate = activeProcessTerminators.get(pid);
      if (terminate) {
        terminate();
        continue;
      }
      activeProcessCleanup.set(pid, terminateProcessGroup(pid));
    }
  });
}

async function loadLocalEnvironment(target: NodeJS.ProcessEnv) {
  const contents = await readFile(localEnvPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (contents === null) return;
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match)
      throw new Error(
        `Invalid ${path.basename(localEnvPath)} line ${index + 1}`,
      );
    if (target[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    target[match[1]] = value;
  }
}

async function prepareProviderPath(
  temporaryRoot: string,
  inheritedPath: string | undefined,
) {
  const toolBin = path.join(temporaryRoot, "provider-bin");
  await mkdir(toolBin, { recursive: true });
  const runnerRequire = createRequire(
    path.join(repositoryRoot, "packages/paperclip-runner/package.json"),
  );
  const codexAcpPackage = runnerRequire.resolve(
    "@agentclientprotocol/codex-acp/package.json",
  );
  const codexRequire = createRequire(codexAcpPackage);
  const codexPackage = codexRequire.resolve("@openai/codex/package.json");
  const codexManifest = JSON.parse(await readFile(codexPackage, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const codexBin =
    typeof codexManifest.bin === "string"
      ? codexManifest.bin
      : codexManifest.bin?.codex;
  if (!codexBin)
    throw new Error(
      "Production Codex ACP dependency does not expose its pinned Codex executable",
    );
  await symlink(
    path.resolve(path.dirname(codexPackage), codexBin),
    path.join(toolBin, "codex"),
  );
  const packageBin = path.join(
    repositoryRoot,
    "packages/paperclip-runner/node_modules/.bin",
  );
  return [toolBin, packageBin, inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
}

async function runProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number | null,
  logPath: string,
  completionPaths: readonly string[],
  interactive: boolean,
) {
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (!child.pid) throw new Error("Failed to start Playwright");
  activeProcessGroups.add(child.pid);
  let outputTail = "";
  const recordOutput = (chunk: Buffer, destination: NodeJS.WriteStream) => {
    destination.write(chunk);
    log.write(chunk);
    outputTail += chunk.toString("utf8");
    if (outputTail.length > 1024 * 1024)
      outputTail = outputTail.slice(-1024 * 1024);
  };
  child.stdout?.on("data", (chunk: Buffer) =>
    recordOutput(chunk, process.stdout),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    recordOutput(chunk, process.stderr),
  );
  let childSettled = false;
  let postResultStallError: string | null = null;
  let boundedCleanup: Promise<string | null> | undefined;
  const forceStopDirectChild = () => {
    if (!childSettled && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };
  const stopChildTree = (diagnostic?: ProcessTreeDiagnostic) => {
    if (boundedCleanup) return;
    const rootProcessGroupId = child.pid!;
    boundedCleanup = (async () => {
      const snapshot = diagnostic ?? (await processTreeDiagnostic(child.pid!));
      const validationTable = await readProcessTable();
      const currentProcessGroupId = validationTable
        ? (validationTable.find((candidate) => candidate.pid === process.pid)
            ?.processGroupId ?? null)
        : null;
      const observedGroups = validationTable
        ? revalidateObservedProcessGroups(snapshot.groups, validationTable)
        : [];
      const terminationOrder = safeProcessGroupTerminationOrder({
        rootProcessGroupId,
        currentProcessGroupId,
        groups: observedGroups,
      });
      const verifiedGroups = observedGroupsSelectedForTermination(
        observedGroups,
        terminationOrder,
      );
      if (verifiedGroups.length === 0) {
        forceStopDirectChild();
        return "Could not revalidate an owned process group before cleanup";
      }
      for (const processGroupId of terminationOrder) {
        stopProcessGroup(processGroupId, "SIGTERM");
      }

      let remainingGroups = verifiedGroups;
      const gracefulDeadline = Date.now() + 5_000;
      while (remainingGroups.length > 0 && Date.now() < gracefulDeadline) {
        const table = await readProcessTable();
        if (table) {
          remainingGroups = refreshContinuouslyLiveProcessGroups(
            remainingGroups,
            table,
          );
        }
        if (remainingGroups.length > 0) await wait(50);
      }
      const remainingGroupIds = new Set(
        remainingGroups.map((group) => group.processGroupId),
      );
      const forcedOrder = safeProcessGroupTerminationOrder({
        rootProcessGroupId,
        currentProcessGroupId,
        groups: remainingGroups,
      }).filter((processGroupId) => remainingGroupIds.has(processGroupId));
      for (const processGroupId of forcedOrder) {
        stopProcessGroup(processGroupId, "SIGKILL");
      }

      const forcedDeadline = Date.now() + 5_000;
      let forcedVerificationUnavailable = false;
      while (Date.now() < forcedDeadline) {
        const table = await readProcessTable();
        if (!table) {
          forcedVerificationUnavailable = true;
          await wait(50);
          continue;
        }
        forcedVerificationUnavailable = false;
        remainingGroups = refreshContinuouslyLiveProcessGroups(
          remainingGroups,
          table,
        );
        if (remainingGroups.length === 0) return null;
        await wait(50);
      }
      if (forcedVerificationUnavailable) {
        return "Could not verify descendant process exit after SIGKILL";
      }
      return `Verified descendant process groups ${remainingGroups
        .map((group) => group.processGroupId)
        .join(",")} survived SIGKILL`;
    })();
    activeProcessCleanup.set(rootProcessGroupId, boundedCleanup);
  };
  activeProcessTerminators.set(child.pid, stopChildTree);
  const resultExitGuard = createResultExitGuard({
    resultPaths: completionPaths,
    interactive,
    graceMs: completedResultExitGraceMs,
    now: Date.now,
    pathExists: (candidate) =>
      access(candidate).then(
        () => true,
        () => false,
      ),
    onExpired: async () => {
      const diagnostic = await processTreeDiagnostic(child.pid!);
      if (childSettled) return;
      postResultStallError = `Playwright remained alive for ${completedResultExitGraceMs}ms after every result was written`;
      recordOutput(
        Buffer.from(
          `\n${postResultStallError}; forcing bounded cleanup. ${diagnostic.summary}\n`,
        ),
        process.stderr,
      );
      stopChildTree(diagnostic);
    },
  });
  const completionPoll = resultExitGuard.enabled
    ? setInterval(() => {
        void resultExitGuard.poll().catch(() => {
          if (childSettled || postResultStallError) return;
          postResultStallError =
            "Completed-result exit guard failed during bounded inspection";
          recordOutput(
            Buffer.from(`\n${postResultStallError}; forcing cleanup.\n`),
            process.stderr,
          );
          stopChildTree();
        });
      }, 500)
    : undefined;
  completionPoll?.unref();
  let timedOut = false;
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stopChildTree();
        }, timeoutMs);
  timer?.unref();
  let spawnError: string | null = null;
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      childSettled = true;
      resolve(code ?? 1);
    });
  }).catch((error) => {
    childSettled = true;
    spawnError = error instanceof Error ? error.message : String(error);
    return 1;
  });
  if (timer) clearTimeout(timer);
  if (completionPoll) clearInterval(completionPoll);
  const processCleanupError = child.pid
    ? await (boundedCleanup ??
        activeProcessCleanup.get(child.pid) ??
        terminateProcessGroup(child.pid))
    : null;
  if (child.pid) {
    activeProcessGroups.delete(child.pid);
    activeProcessCleanup.delete(child.pid);
    activeProcessTerminators.delete(child.pid);
  }
  await new Promise<void>((resolve) => log.end(resolve));
  return {
    exitCode,
    timedOut,
    postResultStallError,
    processCleanupError,
    spawnError,
    outputTail,
  };
}

function syntheticResult(
  execution: MatrixExecution,
  attempt: number,
  startedAtMs: number,
  error: string,
  failureClass: RunnerE2EResult["failureClass"] = "transient_infrastructure",
): RunnerE2EResult {
  const finishedAtMs = Date.now();
  return {
    schema: "paperclip.runner-e2e.result/v2",
    executionId: execution.id,
    suiteId: execution.suite.id,
    suiteDefinitionHash: execution.suiteDefinitionHash,
    source: resolveRunnerE2ESource(),
    ...(execution.profile.ranking
      ? { rankingSnapshot: execution.profile.ranking }
      : {}),
    attempt,
    status: "failed",
    failureClass,
    error,
    profileId: execution.profile.id,
    environmentId: execution.environment.id,
    caseId: execution.task.id,
    provider: execution.profile.provider,
    model: execution.profile.model,
    runtimeMode: execution.profile.expectedRuntimeMode,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    cleanup: "not_started",
  };
}

async function readResult(resultPath: string, fallback: RunnerE2EResult) {
  try {
    return JSON.parse(await readFile(resultPath, "utf8")) as RunnerE2EResult;
  } catch {
    return fallback;
  }
}

async function copySharedEvidence(privateRoot: string, casePrivateDir: string) {
  for (const relative of [
    "server.log",
    "playwright.log",
    "junit.xml",
    "html-report",
    "blob-report",
    "playwright-output",
  ]) {
    await cp(
      path.join(privateRoot, relative),
      path.join(casePrivateDir, relative),
      { recursive: true, force: true },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function runAttempt(input: {
  executions: readonly MatrixExecution[];
  attempt: number;
  campaignId: string;
  options: ReturnType<typeof parseRunnerSelectors>;
}): Promise<RunnerE2EResult[]> {
  const { executions, attempt, campaignId, options } = input;
  const execution = executions[0];
  if (!execution) throw new Error("A runner E2E cell must contain a task case");
  if (
    executions.some(
      (candidate) =>
        candidate.profile.id !== execution.profile.id ||
        candidate.environment.id !== execution.environment.id,
    )
  ) {
    throw new Error(
      "One isolated runner E2E harness cannot mix profiles or environments",
    );
  }
  const startedAtMs = Date.now();
  const sharedMemoryBaseline = snapshotDarwinSharedMemory();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "paperclip-runner-e2e-"),
  );
  const publishedResults: RunnerE2EResult[] = [];
  const publishedResultPaths = new Map<string, string>();
  let attemptSecrets: string[] = [];
  try {
    const paperclipHome = path.join(temporaryRoot, "paperclip-home");
    const workspace = path.join(temporaryRoot, "workspace");
    const privateDir = path.join(temporaryRoot, "artifacts-private");
    const instanceId = `runner-e2e-${randomBytes(8).toString("hex")}`;
    const configPath = path.join(
      paperclipHome,
      "instances",
      instanceId,
      "config.json",
    );
    const port = await reserveRunnerE2EServerPort();
    await Promise.all([
      mkdir(paperclipHome, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(privateDir, { recursive: true }),
    ]);
    const providerPath = await prepareProviderPath(
      temporaryRoot,
      process.env.PATH,
    );
    const agentJwtSecret = secret(48);
    const decisionSigningSecret = secret(48);
    const toolActionSigningSecret = secret(48);
    const betterAuthSecret = secret(48);
    const credentials = normalizedSecrets([
      ...CREDENTIAL_NAMES.map((name) => process.env[name]),
      agentJwtSecret,
      decisionSigningSecret,
      toolActionSigningSecret,
      betterAuthSecret,
    ]);
    attemptSecrets = credentials;
    const runnerBinary = resolvePaperclipRunnerBinaryForHarness(
      executions,
      repositoryRoot,
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...buildRunnerE2EProcessEnvironment(process.env, executions),
      PATH: providerPath,
      PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify(
        executions.map((candidate) => candidate.id),
      ),
      PAPERCLIP_RUNNER_E2E_ATTEMPT: String(attempt),
      PAPERCLIP_RUNNER_E2E_PORT: String(port),
      PAPERCLIP_RUNNER_E2E_TEMP_ROOT: temporaryRoot,
      PAPERCLIP_RUNNER_E2E_PRIVATE_DIR: privateDir,
      PAPERCLIP_RUNNER_E2E_WORKSPACE: workspace,
      PAPERCLIP_RUNNER_E2E_SERVER_LOG: path.join(privateDir, "server.log"),
      PAPERCLIP_RUNNER_BINARY: runnerBinary,
      PAPERCLIP_RUNNER_REMOTE_BINARY_PATH:
        resolvePaperclipRemoteRunnerBinaryForHarness(executions, runnerBinary),
      // Vite's optimized dependency cache embeds revision query strings. A
      // private per-attempt cache prevents an earlier cell or local rebuild
      // from producing `504 Outdated Optimize Dep` during browser bootstrap.
      PAPERCLIP_VITE_CACHE_DIR: path.join(temporaryRoot, "vite-cache"),
      PAPERCLIP_RUNNER_E2E_TEST_TIMEOUT_MS: String(
        Math.max(
          ...executions.map(
            (candidate) =>
              candidate.task.attemptTimeoutMs[candidate.environment.id],
          ),
        ) + 90_000,
      ),
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: instanceId,
      PAPERCLIP_CONFIG: configPath,
      PAPERCLIP_AGENT_JWT_SECRET: agentJwtSecret,
      PAPERCLIP_DECISION_SIGNING_SECRET: decisionSigningSecret,
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: toolActionSigningSecret,
      BETTER_AUTH_SECRET: betterAuthSecret,
    };
    // The database URLs are stripped here and again at the Playwright web-server
    // boundary so a developer's shell can never redirect this paid test.
    delete childEnv.DATABASE_URL;
    delete childEnv.DATABASE_MIGRATION_URL;

    const playwrightArgs = [
      "exec",
      "playwright",
      "test",
      "--config",
      "tests/runner-e2e/playwright.config.ts",
      ...(options.headed ? ["--headed"] : []),
      ...(options.ui ? ["--ui"] : []),
      ...(options.debug ? ["--debug"] : []),
    ];
    const watchdog =
      options.ui || options.debug
        ? null
        : executions.reduce(
            (total, candidate) =>
              total +
              candidate.task.attemptTimeoutMs[candidate.environment.id] +
              90_000,
            0,
          ) +
          5 * 60_000;
    const processResult = await runProcess(
      playwrightArgs,
      childEnv,
      watchdog,
      path.join(privateDir, "playwright.log"),
      executions.map((candidate) =>
        path.join(privateDir, "cases", candidate.task.id, "result.json"),
      ),
      options.ui || options.debug,
    );
    const processFailure = processResult.spawnError
      ? `Playwright failed to start: ${processResult.spawnError}`
      : processResult.timedOut
        ? `Harness process exceeded ${Math.round((watchdog ?? 0) / 1000)} seconds`
        : `Playwright exited ${processResult.exitCode} before writing a result`;
    const processFailureClass =
      processResult.spawnError || processResult.timedOut
        ? "transient_infrastructure"
        : classifyFailure(
            new Error(
              processResult.outputTail
                ? `${processFailure}\n${processResult.outputTail}`
                : processFailure,
            ),
          );
    const results = await Promise.all(
      executions.map(async (candidate) => {
        const resultPath = path.join(
          privateDir,
          "cases",
          candidate.task.id,
          "result.json",
        );
        const fallback = syntheticResult(
          candidate,
          attempt,
          startedAtMs,
          processFailure,
          processFailureClass,
        );
        const result = await readResult(resultPath, fallback);
        return enforceResultProcessIntegrity(result, processResult);
      }),
    );
    let isolationError: unknown;
    try {
      await assertEmbeddedDatabaseIsolation(configPath, temporaryRoot);
    } catch (error) {
      isolationError = error;
    }
    let persistedStateError: unknown;
    try {
      const expectedEphemeralCredentials = new Set<string>();
      for (const [label, directory] of [
        ["Paperclip home", paperclipHome],
        ["workspace", workspace],
      ] as const) {
        while (true) {
          // The managed Codex home may legitimately contain upstream source-code
          // fixtures with fake `sk-*` strings. Reject exact campaign credentials.
          const leak = await findSecretLeakInDirectory(directory, credentials, {
            includeShapes: false,
            ignoreFile: (file) => expectedEphemeralCredentials.has(file),
          });
          if (!leak) break;
          const isManagedCodexRuntimeAuth =
            label === "Paperclip home" &&
            isEphemeralCodexRuntimeAuthFile(paperclipHome, leak.file);
          if (isManagedCodexRuntimeAuth) {
            const metadata = await lstat(leak.file);
            if (metadata.isFile() && (metadata.mode & 0o777) === 0o600) {
              // Codex CLI API-key mode requires this one runtime auth file. It
              // lives only in the disposable cell root, is never published,
              // must be owner-only, and is removed with the root below.
              expectedEphemeralCredentials.add(leak.file);
              continue;
            }
          }
          throw new Error(
            `Secret leak in persisted ${label} state at ${path.relative(temporaryRoot, leak.file)}: ${leak.reason}`,
          );
        }
      }
    } catch (error) {
      persistedStateError = error;
    }
    for (const [index, candidate] of executions.entries()) {
      let result = results[index];
      if (
        isolationError &&
        result.failureClass !== "cleanup_failure" &&
        result.failureClass !== "secret_leak"
      ) {
        const isolationMessage =
          isolationError instanceof Error
            ? isolationError.message
            : String(isolationError);
        const configWasUnavailableDuringTransientBootstrap =
          result.failureClass === "transient_infrastructure" &&
          typeof isolationError === "object" &&
          isolationError !== null &&
          "code" in isolationError &&
          isolationError.code === "ENOENT";
        result = {
          ...result,
          status: "failed",
          failureClass: configWasUnavailableDuringTransientBootstrap
            ? result.failureClass
            : "permanent_infrastructure",
          error: configWasUnavailableDuringTransientBootstrap
            ? `${result.error}; isolated config could not be inspected after bootstrap failure: ${isolationMessage}`
            : isolationMessage,
        };
      }
      if (persistedStateError) {
        const persistedStateMessage =
          persistedStateError instanceof Error
            ? persistedStateError.message
            : String(persistedStateError);
        const persistedStateClass = classifyFailure(persistedStateError);
        if (
          persistedStateClass === "secret_leak" ||
          (result.failureClass !== "secret_leak" &&
            result.failureClass !== "cleanup_failure")
        ) {
          result = {
            ...result,
            status: "failed",
            failureClass:
              persistedStateClass === "secret_leak"
                ? "secret_leak"
                : "permanent_infrastructure",
            error: persistedStateMessage,
          };
        } else {
          result = {
            ...result,
            error: `${result.error}; persisted-state scan also failed: ${persistedStateMessage}`,
          };
        }
      }
      const casePrivateDir = path.join(privateDir, "cases", candidate.task.id);
      const resultPath = path.join(casePrivateDir, "result.json");
      const uploadDir = path.join(
        resultsRoot,
        campaignId,
        candidate.suite.id,
        candidate.profile.id,
        candidate.environment.id,
        candidate.task.id,
        `attempt-${attempt}`,
      );
      await mkdir(casePrivateDir, { recursive: true });
      await copySharedEvidence(privateDir, casePrivateDir);
      await writeFile(
        resultPath,
        `${JSON.stringify(sanitizeJson(result, credentials), null, 2)}\n`,
        "utf8",
      );
      let evidence = await packageEvidence({
        privateDir: casePrivateDir,
        uploadDir,
        secrets: credentials,
        expectPassScreenshot: result.status === "passed",
      });
      if (evidence.leaks.length > 0 || evidence.missing.length > 0) {
        result = {
          ...result,
          status: "failed",
          failureClass:
            evidence.leaks.length > 0
              ? "secret_leak"
              : "permanent_infrastructure",
          error:
            evidence.leaks.length > 0
              ? `Secret leak rejected from evidence: ${evidence.leaks.map((leak) => leak.file).join(", ")}`
              : `Required evidence missing: ${evidence.missing.join(", ")}`,
        };
        await writeFile(
          resultPath,
          `${JSON.stringify(sanitizeJson(result, credentials), null, 2)}\n`,
          "utf8",
        );
        evidence = await packageEvidence({
          privateDir: casePrivateDir,
          uploadDir,
          secrets: credentials,
          expectPassScreenshot: false,
        });
      }
      console.log(
        `${result.status === "passed" ? "PASS" : "FAIL"} ${candidate.id} attempt ${attempt} -> ${uploadDir}`,
      );
      publishedResults.push(result);
      publishedResultPaths.set(
        candidate.id,
        path.join(uploadDir, "result.json"),
      );
    }
    return [...publishedResults];
  } finally {
    reapNewDetachedDarwinSharedMemory(sharedMemoryBaseline);
    let cleanupError: unknown;
    if (
      temporaryRoot.startsWith(`${os.tmpdir()}${path.sep}paperclip-runner-e2e-`)
    ) {
      for (let cleanupAttempt = 1; cleanupAttempt <= 3; cleanupAttempt += 1) {
        try {
          await rm(temporaryRoot, { recursive: true, force: true });
          cleanupError = undefined;
          break;
        } catch (error) {
          cleanupError = error;
          if (cleanupAttempt < 3) {
            await makeDirectoryTreeRemovable(temporaryRoot).catch(() => {});
            await new Promise((resolve) =>
              setTimeout(resolve, cleanupAttempt * 250),
            );
          }
        }
      }
    } else {
      cleanupError = new Error(
        `Refusing to remove unexpected temporary path ${temporaryRoot}`,
      );
    }
    if (cleanupError) {
      const message = `Temporary runner E2E state cleanup failed at ${temporaryRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      for (const publishedResult of publishedResults) {
        const publishedResultPath = publishedResultPaths.get(
          publishedResult.executionId,
        );
        if (!publishedResultPath) continue;
        Object.assign(publishedResult, {
          status: "failed",
          failureClass: "cleanup_failure",
          error: message,
          cleanup: "failed",
        } satisfies Partial<RunnerE2EResult>);
        const safeResult = `${JSON.stringify(
          sanitizeJson(publishedResult, attemptSecrets),
          null,
          2,
        )}\n`;
        assertSecretFree(safeResult, attemptSecrets, publishedResultPath);
        await writeFile(publishedResultPath, safeResult, "utf8");
      }
      // Cleanup failure is a failed cell, but must not suppress later cells in
      // the same campaign. The result above carries the terminal failure.
      console.error(message);
    }
  }
}

function printList(executions: readonly MatrixExecution[]) {
  console.log("ID\tSUITE\tGENERATION\tPROVIDER\tMODEL\tCREDENTIALS");
  for (const execution of executions) {
    console.log(
      [
        execution.id,
        execution.suite.id,
        execution.profile.generation,
        execution.profile.provider,
        execution.profile.model,
        execution.requiredCredentials.join(","),
      ].join("\t"),
    );
  }
}

async function runExecutionWithRetry(input: {
  execution: MatrixExecution;
  campaignId: string;
  options: ReturnType<typeof parseRunnerSelectors>;
}): Promise<RunnerE2EResult> {
  const { execution, campaignId, options } = input;
  const [firstResult] = await runAttempt({
    executions: [execution],
    attempt: 1,
    campaignId,
    options,
  });
  if (!firstResult) throw new Error(`No result produced for ${execution.id}`);
  if (
    options.ui ||
    options.debug ||
    firstResult.status !== "failed" ||
    !firstResult.failureClass ||
    !shouldRetryFailure(firstResult.failureClass)
  ) {
    return firstResult;
  }
  if (cancelled) throw new Error("Runner E2E campaign cancelled");
  console.warn(
    `Retrying ${execution.id} in a fresh isolated harness after ${firstResult.failureClass.replaceAll("_", " ")}`,
  );
  const [retryResult] = await runAttempt({
    executions: [execution],
    attempt: 2,
    campaignId,
    options,
  });
  if (!retryResult)
    throw new Error(`No retry result produced for ${execution.id}`);
  return retryResult;
}

async function runWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        if (cancelled) throw new Error("Runner E2E campaign cancelled");
        results[index] = await worker(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main() {
  let options: ReturnType<typeof parseRunnerSelectors>;
  try {
    options = parseRunnerSelectors(process.argv.slice(2));
  } catch (error) {
    if (error instanceof RunnerSelectorError)
      throw new Error(`${error.message}\nUse --list to inspect valid cells.`);
    throw error;
  }
  const executions = selectRunnerExecutions(options, runnerMatrix);
  if (options.list) {
    printList(executions);
    return;
  }
  if (options.matrixJson) {
    const jobs = buildMatrixJobs(executions);
    console.log(
      JSON.stringify({
        include: jobs,
        needsDaytona: jobs.some((job) => job.needsDaytona),
        executionIds: executions.map((execution) => execution.id),
      }),
    );
    return;
  }

  await loadLocalEnvironment(process.env);
  const missingCredentials = [
    ...new Set(
      executions.flatMap((execution) => execution.requiredCredentials),
    ),
  ].filter((name) => !process.env[name]?.trim());
  if (missingCredentials.length > 0) {
    throw new Error(
      `Missing runner E2E credentials: ${missingCredentials.join(", ")}`,
    );
  }
  if (
    executions.some((execution) => execution.environment.id === "daytona") &&
    !isImmutableDaytonaImage(process.env.PAPERCLIP_E2E_DAYTONA_IMAGE)
  ) {
    throw new Error(
      "PAPERCLIP_E2E_DAYTONA_IMAGE must be an immutable image@sha256 digest for Daytona cells",
    );
  }

  const campaignId = cleanId(
    process.env.PAPERCLIP_E2E_CAMPAIGN_ID ??
      `local-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const requestedParallelism =
    options.headed || options.ui || options.debug ? 1 : options.maxParallel;
  console.log(
    `Running ${executions.length} isolated execution(s) with max parallelism ${requestedParallelism}`,
  );
  const finalResults = await runWithConcurrency(
    executions,
    requestedParallelism,
    (execution) => runExecutionWithRetry({ execution, campaignId, options }),
  );

  const generatedAt = new Date().toISOString();
  const campaign = buildRunnerCampaign({
    campaignId,
    generatedAt,
    expected: executions.map((execution) => execution.id),
    results: finalResults,
  });
  const summaryDir = path.join(resultsRoot, campaignId);
  await mkdir(summaryDir, { recursive: true });
  const campaignSecrets = normalizedSecrets(
    CREDENTIAL_NAMES.map((name) => process.env[name]),
  );
  const safeCampaign = sanitizeJson(
    campaign,
    campaignSecrets,
  ) as typeof campaign;
  const campaignText = `${JSON.stringify(safeCampaign, null, 2)}\n`;
  assertSecretFree(campaignText, campaignSecrets, "campaign.json");
  await writeFile(path.join(summaryDir, "campaign.json"), campaignText, "utf8");
  const dashboard = renderRunnerE2EDashboard({
    title: `Runner E2E · ${campaignId}`,
    generatedAt,
    expected: executions.map((execution) => execution.id),
    catalog: runnerMatrix,
    campaign: safeCampaign,
    entries: safeCampaign.results.map((result) => ({
      result,
      valid: result.status === "passed" && result.cleanup === "passed",
      errors:
        result.status === "passed" && result.cleanup === "passed"
          ? []
          : [
              result.error ??
                result.failureClass ??
                `cleanup=${result.cleanup}`,
            ],
      evidenceBaseHref: [
        result.suiteId ?? "core-compatibility",
        result.profileId,
        result.environmentId,
        result.caseId,
        `attempt-${result.attempt}`,
      ].join("/"),
    })),
  });
  assertSecretFree(dashboard, campaignSecrets, "dashboard.html");
  await writeFile(path.join(summaryDir, "dashboard.html"), dashboard, "utf8");
  console.log(
    `Campaign ${campaignId}: ${safeCampaign.passed}/${safeCampaign.selected} passed`,
  );
  if (safeCampaign.failed > 0) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
