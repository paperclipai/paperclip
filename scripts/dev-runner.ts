#!/usr/bin/env -S node --import tsx
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createCapturedOutputBuffer, parseJsonResponseWithLimit } from "./dev-runner-output.ts";
import { shouldTrackDevServerPath } from "./dev-runner-paths.mjs";
import { createDevServiceIdentity, repoRoot } from "./dev-service-profile.ts";
import { bootstrapDevRunnerWorktreeEnv } from "../server/src/dev-runner-worktree.ts";
import {
  findAdoptableLocalService,
  removeLocalServiceRegistryRecord,
  touchLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "../server/src/services/local-service-supervisor.ts";

// Keep these values local so the dev runner can boot from the server package's
// tsx context without requiring workspace package resolution first.
const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
type BindMode = (typeof BIND_MODES)[number];

const worktreeEnvBootstrap = bootstrapDevRunnerWorktreeEnv(repoRoot, process.env);
if (worktreeEnvBootstrap.missingEnv) {
  console.error(
    `[paperclip] linked git worktree at ${repoRoot} is missing ${path.relative(repoRoot, worktreeEnvBootstrap.envPath)}. Run \`paperclipai worktree init\` in this worktree before starting the dev server.`,
  );
  process.exit(1);
}

function readRootEnvFileValue(key: string): string | undefined {
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) return undefined;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  const prefix = `${key}=`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(prefix)) continue;
    let value = trimmed.slice(prefix.length).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

if (process.argv[2] === "watch") {
  console.error(
    "[paperclip] Removed: tsx file-watch dev (unreliable on Windows NTFS). Use `pnpm dev`, `pnpm dev:once`, or `scripts/start-paperclip-dev-external.ps1` (prefers `dev:once`).",
  );
  process.exit(1);
}

const cliArgs = process.argv.slice(2);
const devRunnerOnceMode =
  cliArgs.includes("once") ||
  process.env.PAPERCLIP_DEV_RUNNER_ONCE === "1" ||
  process.env.PAPERCLIP_DEV_RUNNER_ONCE === "true";
const runnerCliArgs = cliArgs.filter((arg) => arg !== "once");
const scanIntervalMs = 1500;
const autoRestartPollIntervalMs = 2500;
const gracefulShutdownTimeoutMs = 10_000;
const changedPathSampleLimit = 5;
const devServerStatusFilePath = path.join(repoRoot, ".paperclip", "dev-server-status.json");
const devServerStatusToken = randomUUID();
const devServerStatusTokenHeader = "x-paperclip-dev-server-status-token";

const watchedDirectories = [
  "cli",
  "scripts",
  "server",
  "packages/adapter-utils",
  "packages/adapters",
  "packages/db",
  "packages/plugins/sdk",
  "packages/shared",
].map((relativePath) => path.join(repoRoot, relativePath));

const watchedFiles = [
  ".env",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
].map((relativePath) => path.join(repoRoot, relativePath));

const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "ui-dist",
]);

const ignoredRelativePaths = new Set([
  ".paperclip/dev-server-status.json",
]);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
let bindMode: BindMode | null = null;
let bindHost: string | null = null;
const forwardedArgs: string[] = [];

for (let index = 0; index < runnerCliArgs.length; index += 1) {
  const arg = runnerCliArgs[index];
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  if (arg === "--bind") {
    const value = runnerCliArgs[index + 1];
    if (!value || value.startsWith("--") || !BIND_MODES.includes(value as BindMode)) {
      console.error(`[paperclip] invalid --bind value. Use one of: ${BIND_MODES.join(", ")}`);
      process.exit(1);
    }
    bindMode = value as BindMode;
    index += 1;
    continue;
  }
  if (arg === "--bind-host") {
    const value = runnerCliArgs[index + 1];
    if (!value || value.startsWith("--")) {
      console.error("[paperclip] --bind-host requires a value");
      process.exit(1);
    }
    bindHost = value;
    index += 1;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}
if (!bindMode && process.env.npm_config_bind && BIND_MODES.includes(process.env.npm_config_bind as BindMode)) {
  bindMode = process.env.npm_config_bind as BindMode;
}
if (!bindHost && process.env.npm_config_bind_host) {
  bindHost = process.env.npm_config_bind_host;
}
if (bindMode === "custom" && !bindHost) {
  console.error("[paperclip] --bind custom requires --bind-host <host>");
  process.exit(1);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
};

if (env.PAPERCLIP_STRICT_PORTS === undefined) {
  const fromRootDotenv = readRootEnvFileValue("PAPERCLIP_STRICT_PORTS");
  if (fromRootDotenv !== undefined) {
    env.PAPERCLIP_STRICT_PORTS = fromRootDotenv;
  }
}
if (env.PAPERCLIP_STRICT_PORTS === undefined) {
  env.PAPERCLIP_STRICT_PORTS = "true";
}

env.PAPERCLIP_DEV_SERVER_STATUS_FILE = devServerStatusFilePath;
env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN = devServerStatusToken;
env.PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true";

if (tailscaleAuth || bindMode) {
  const effectiveBind = bindMode ?? "lan";
  if (tailscaleAuth) {
    console.log("[paperclip] note: --tailscale-auth/--authenticated-private are legacy aliases for --bind lan");
  }
  env.PAPERCLIP_BIND = effectiveBind;
  if (bindHost) {
    env.PAPERCLIP_BIND_HOST = bindHost;
  } else {
    delete env.PAPERCLIP_BIND_HOST;
  }
  if (effectiveBind === "loopback" && !tailscaleAuth) {
    delete env.PAPERCLIP_DEPLOYMENT_MODE;
    delete env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
    delete env.PAPERCLIP_AUTH_BASE_URL_MODE;
    console.log("[paperclip] dev mode: local_trusted (bind=loopback)");
  } else {
    env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
    console.log(
      `[paperclip] dev mode: authenticated/private (bind=${effectiveBind}${bindHost ? `:${bindHost}` : ""})`,
    );
  }
} else {
  delete env.PAPERCLIP_BIND;
  delete env.PAPERCLIP_BIND_HOST;
  delete env.PAPERCLIP_DEPLOYMENT_MODE;
  delete env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  delete env.PAPERCLIP_AUTH_BASE_URL_MODE;
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const serverPort = Number.parseInt(env.PORT ?? process.env.PORT ?? "3100", 10) || 3100;
const devService = createDevServiceIdentity({
  forwardedArgs,
  networkProfile: tailscaleAuth ? `legacy:${bindMode ?? "lan"}` : (bindMode ?? "default"),
  port: serverPort,
});

const existingRunner = await findAdoptableLocalService({
  serviceKey: devService.serviceKey,
  cwd: repoRoot,
  envFingerprint: devService.envFingerprint,
  port: serverPort,
});
if (existingRunner) {
  console.log(
    `[paperclip] ${devService.serviceName} already running (pid ${existingRunner.pid}${typeof existingRunner.metadata?.childPid === "number" ? `, child ${existingRunner.metadata.childPid}` : ""})`,
  );
  process.exit(0);
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let previousSnapshot = collectWatchedSnapshot();
let dirtyPaths = new Set<string>();
let pendingMigrations: string[] = [];
let lastChangedAt: string | null = null;
let lastRestartAt: string | null = null;
let scanInFlight = false;
let restartInFlight = false;
let shuttingDown = false;
let childExitWasExpected = false;
let child: ReturnType<typeof spawn> | null = null;
let childExitPromise: Promise<{ code: number; signal: NodeJS.Signals | null }> | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let autoRestartTimer: ReturnType<typeof setInterval> | null = null;

function toError(error: unknown, context = "Dev runner command failed") {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

process.on("uncaughtException", async (error) => {
  await removeLocalServiceRegistryRecord(devService.serviceKey);
  const err = toError(error, "Uncaught exception in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  await removeLocalServiceRegistryRecord(devService.serviceKey);
  const err = toError(reason, "Unhandled promise rejection in dev runner");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});

function formatPendingMigrationSummary(migrations: string[]) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

function exitForSignal(signal: NodeJS.Signals) {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  process.exit(1);
}

function toRelativePath(absolutePath: string) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function readSignature(absolutePath: string) {
  const stats = statSync(absolutePath);
  return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
}

function addFileToSnapshot(snapshot: Map<string, string>, absolutePath: string) {
  const relativePath = toRelativePath(absolutePath);
  if (ignoredRelativePaths.has(relativePath)) return;
  if (!shouldTrackDevServerPath(relativePath)) return;
  snapshot.set(relativePath, readSignature(absolutePath));
}

function walkDirectory(snapshot: Map<string, string>, absoluteDirectory: string) {
  if (!existsSync(absoluteDirectory)) return;

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (ignoredDirectoryNames.has(entry.name)) continue;

    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(snapshot, absolutePath);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      addFileToSnapshot(snapshot, absolutePath);
    }
  }
}

function collectWatchedSnapshot() {
  const snapshot = new Map<string, string>();

  for (const absoluteDirectory of watchedDirectories) {
    walkDirectory(snapshot, absoluteDirectory);
  }
  for (const absoluteFile of watchedFiles) {
    if (!existsSync(absoluteFile)) continue;
    addFileToSnapshot(snapshot, absoluteFile);
  }

  return snapshot;
}

function diffSnapshots(previous: Map<string, string>, next: Map<string, string>) {
  const changed = new Set<string>();

  for (const [relativePath, signature] of next) {
    if (previous.get(relativePath) !== signature) {
      changed.add(relativePath);
    }
  }
  for (const relativePath of previous.keys()) {
    if (!next.has(relativePath)) {
      changed.add(relativePath);
    }
  }

  return [...changed].sort();
}

function ensureDevStatusDirectory() {
  mkdirSync(path.dirname(devServerStatusFilePath), { recursive: true });
}

function writeDevServerStatus() {
  ensureDevStatusDirectory();
  const changedPaths = [...dirtyPaths].sort();
  writeFileSync(
    devServerStatusFilePath,
    `${JSON.stringify({
      dirty: changedPaths.length > 0 || pendingMigrations.length > 0,
      lastChangedAt,
      changedPathCount: changedPaths.length,
      changedPathsSample: changedPaths.slice(0, changedPathSampleLimit),
      pendingMigrations,
      lastRestartAt,
    }, null, 2)}\n`,
    "utf8",
  );
}

function clearDevServerStatus() {
  rmSync(devServerStatusFilePath, { force: true });
}

async function updateDevServiceRecord(extra?: Record<string, unknown>) {
  await writeLocalServiceRegistryRecord({
    version: 1,
    serviceKey: devService.serviceKey,
    profileKind: "paperclip-dev",
    serviceName: devService.serviceName,
    command: "dev-runner.ts",
    cwd: repoRoot,
    envFingerprint: devService.envFingerprint,
    port: serverPort,
    url: `http://127.0.0.1:${serverPort}`,
    pid: process.pid,
    processGroupId: null,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: lastRestartAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    metadata: {
      repoRoot,
      childPid: child?.pid ?? null,
      url: `http://127.0.0.1:${serverPort}`,
      ...extra,
    },
  });
}

async function runPnpm(args: string[], options: {
  stdio?: "inherit" | ["ignore", "pipe", "pipe"];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  return await new Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const spawned = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
      shell: process.platform === "win32",
    });

    const stdoutBuffer = createCapturedOutputBuffer();
    const stderrBuffer = createCapturedOutputBuffer();

    if (spawned.stdout) {
      spawned.stdout.on("data", (chunk) => {
        stdoutBuffer.append(chunk);
      });
    }
    if (spawned.stderr) {
      spawned.stderr.on("data", (chunk) => {
        stderrBuffer.append(chunk);
      });
    }

    spawned.on("error", reject);
    spawned.on("exit", (code, signal) => {
      const stdout = stdoutBuffer.finish();
      const stderr = stderrBuffer.finish();
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
      });
    });
  });
}

async function getMigrationStatusPayload() {
  const status = await runPnpm(
    ["--filter", "@paperclipai/db", "exec", "tsx", "src/migration-status.ts", "--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        `[paperclip] Command failed with code ${status.code}: pnpm --filter @paperclipai/db exec tsx src/migration-status.ts --json\n`,
    );
    process.exit(status.code);
  }

  try {
    return JSON.parse(status.stdout.trim()) as { status?: string; pendingMigrations?: string[] };
  } catch (error) {
    process.stderr.write(
      status.stderr ||
        status.stdout ||
        "[paperclip] migration-status returned invalid JSON payload\n",
    );
    throw toError(error, "Unable to parse migration-status JSON output");
  }
}

async function refreshPendingMigrations() {
  const payload = await getMigrationStatusPayload();
  pendingMigrations =
    payload.status === "needsMigrations" && Array.isArray(payload.pendingMigrations)
      ? payload.pendingMigrations.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : [];
  writeDevServerStatus();
  return payload;
}

async function maybePreflightMigrations(options: { interactive?: boolean; autoApply?: boolean; exitOnDecline?: boolean } = {}) {
  const interactive = options.interactive ?? false;
  const autoApply = options.autoApply ?? env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true";
  const exitOnDecline = options.exitOnDecline ?? false;

  const payload = await refreshPendingMigrations();
  if (payload.status !== "needsMigrations" || pendingMigrations.length === 0) {
    return;
  }

  let shouldApply = autoApply;

  if (!autoApply && interactive) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) {
    if (exitOnDecline) {
      process.stderr.write(
        `[paperclip] Pending migrations detected (${formatPendingMigrationSummary(pendingMigrations)}). Refusing to start dev server against a stale schema.\n`,
      );
      process.exit(1);
    }
    return;
  }

  const exit = await runPnpm(["db:migrate"], {
    stdio: "inherit",
    env,
    cwd: repoRoot,
  });
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }

  await refreshPendingMigrations();
}

async function buildPluginSdk() {
  console.log("[paperclip] building plugin sdk...");
  const result = await runPnpm(
    ["--filter", "@paperclipai/plugin-sdk", "build"],
    { stdio: "inherit" },
  );
  if (result.signal) {
    exitForSignal(result.signal);
    return;
  }
  if (result.code !== 0) {
    console.error("[paperclip] plugin sdk build failed");
    process.exit(result.code);
  }
}

async function markChildAsCurrent() {
  previousSnapshot = collectWatchedSnapshot();
  dirtyPaths = new Set();
  lastChangedAt = null;
  lastRestartAt = new Date().toISOString();
  await refreshPendingMigrations();
  await updateDevServiceRecord();
}

async function scanForBackendChanges() {
  if (scanInFlight || restartInFlight) return;
  scanInFlight = true;
  try {
    const nextSnapshot = collectWatchedSnapshot();
    const changed = diffSnapshots(previousSnapshot, nextSnapshot);
    previousSnapshot = nextSnapshot;
    if (changed.length === 0) return;

    for (const relativePath of changed) {
      dirtyPaths.add(relativePath);
    }
    lastChangedAt = new Date().toISOString();
    await refreshPendingMigrations();
  } finally {
    scanInFlight = false;
  }
}

async function getDevHealthPayload() {
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/health`, {
    headers: devServerStatusToken ? { [devServerStatusTokenHeader]: devServerStatusToken } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Health request failed (${response.status})`);
  }
  return await parseJsonResponseWithLimit(response);
}

async function waitForChildExit() {
  if (!childExitPromise) {
    return { code: 0, signal: null };
  }
  return await childExitPromise;
}

async function stopChildForRestart() {
  if (!child) return { code: 0, signal: null };
  childExitWasExpected = true;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child) {
      child.kill("SIGKILL");
    }
  }, gracefulShutdownTimeoutMs);
  try {
    return await waitForChildExit();
  } finally {
    clearTimeout(killTimer);
  }
}

async function startServerChild() {
  await buildPluginSdk();

  const serverScript = "dev";
  child = spawn(
    pnpmBin,
    ["--filter", "@paperclipai/server", serverScript, ...forwardedArgs],
    { stdio: "inherit", env, shell: process.platform === "win32" },
  );

  childExitPromise = new Promise((resolve, reject) => {
    child?.on("error", reject);
    child?.on("exit", (code, signal) => {
      const expected = childExitWasExpected;
      childExitWasExpected = false;
      child = null;
      childExitPromise = null;
      void touchLocalServiceRegistryRecord(devService.serviceKey, {
        metadata: {
          repoRoot,
          childPid: null,
          url: `http://127.0.0.1:${serverPort}`,
        },
      });
      resolve({ code: code ?? 0, signal });

      if (restartInFlight || expected || shuttingDown) {
        return;
      }
      if (signal) {
        exitForSignal(signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });

  await markChildAsCurrent();
}

async function maybeAutoRestartChild() {
  if (restartInFlight || !child) return;
  if (dirtyPaths.size === 0 && pendingMigrations.length === 0) return;

  restartInFlight = true;
  let health: { devServer?: { enabled?: boolean; autoRestartEnabled?: boolean; activeRunCount?: number } } | null = null;
  try {
    health = await getDevHealthPayload();
  } catch {
    restartInFlight = false;
    return;
  }

  const devServer = health?.devServer;
  if (!devServer?.enabled || devServer.autoRestartEnabled !== true) {
    restartInFlight = false;
    return;
  }
  if ((devServer.activeRunCount ?? 0) > 0) {
    restartInFlight = false;
    return;
  }

  try {
    await maybePreflightMigrations({
      autoApply: true,
      interactive: false,
      exitOnDecline: false,
    });
    await stopChildForRestart();
    await startServerChild();
  } catch (error) {
    const err = toError(error, "Auto-restart failed");
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  } finally {
    restartInFlight = false;
  }
}

function installDevIntervals() {
  scanTimer = setInterval(() => {
    void scanForBackendChanges();
  }, scanIntervalMs);
  autoRestartTimer = setInterval(() => {
    void maybeAutoRestartChild();
  }, autoRestartPollIntervalMs);
}

function clearDevIntervals() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (autoRestartTimer) {
    clearInterval(autoRestartTimer);
    autoRestartTimer = null;
  }
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearDevIntervals();
  clearDevServerStatus();
  await removeLocalServiceRegistryRecord(devService.serviceKey);

  if (!child) {
    exitForSignal(signal);
    return;
  }

  childExitWasExpected = true;
  child.kill(signal);
  const exit = await waitForChildExit();
  if (exit.signal) {
    exitForSignal(exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await maybePreflightMigrations();
await startServerChild();
if (devRunnerOnceMode) {
  console.log("[paperclip] dev runner once: change scan and idle auto-restart are disabled");
} else {
  installDevIntervals();
}
