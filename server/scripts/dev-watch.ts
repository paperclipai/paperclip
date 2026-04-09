import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);
const serverPort = Number.parseInt(process.env.PORT ?? "3100", 10) || 3100;
const healthUrl = `http://127.0.0.1:${serverPort}/api/health`;
const healthCheckEnabled = process.env.PAPERCLIP_DEV_WATCH_HEALTH_CHECK !== "false";
const healthCheckIntervalMs = 5_000;
const healthCheckTimeoutMs = 2_000;
const healthCheckFailureThreshold = 4;
const startupGraceMs = 60_000;
const childShutdownTimeoutMs = 10_000;
const shouldClearViteCacheOnRestart = process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true";

let child: ChildProcess | null = null;
let childExitPromise: Promise<{ code: number; signal: NodeJS.Signals | null }> | null = null;
let childExitWasExpected = false;
let restarting = false;
let shuttingDown = false;
let childStartAt = 0;
let childReachedHealthyState = false;
let consecutiveHealthFailures = 0;
let healthTimer: ReturnType<typeof setInterval> | null = null;

function exitForSignal(signal: NodeJS.Signals) {
  if (signal === "SIGINT") {
    process.exit(130);
  }
  if (signal === "SIGTERM") {
    process.exit(143);
  }
  process.exit(1);
}

function clearViteCacheForRespawn() {
  if (!shouldClearViteCacheOnRestart) return;

  const cacheRoots = [
    path.resolve(serverRoot, "../ui/node_modules/.vite"),
    path.resolve(serverRoot, "../ui/node_modules/.vite-temp"),
    path.resolve(serverRoot, "../ui/.vite"),
  ];

  let removedAny = false;
  for (const cacheRoot of cacheRoots) {
    if (!fs.existsSync(cacheRoot)) continue;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    removedAny = true;
  }

  if (removedAny) {
    console.warn("[paperclip] cleared stale Vite cache before restarting dev server");
  }
}

function resetChildHealthState() {
  childStartAt = Date.now();
  childReachedHealthyState = false;
  consecutiveHealthFailures = 0;
}

function waitForChildExit() {
  if (!childExitPromise) {
    return Promise.resolve({ code: 0, signal: null });
  }
  return childExitPromise;
}

function spawnWatchChild() {
  clearViteCacheForRespawn();
  resetChildHealthState();
  child = spawn(
    process.execPath,
    [tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"],
    {
      cwd: serverRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  childExitPromise = new Promise((resolve, reject) => {
    child?.on("error", reject);
    child?.on("exit", (code, signal) => {
      const expected = childExitWasExpected;
      childExitWasExpected = false;
      child = null;
      childExitPromise = null;
      resolve({ code: code ?? 0, signal });

      if (restarting || expected || shuttingDown) {
        return;
      }
      if (signal) {
        exitForSignal(signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });
}

async function stopWatchChild(signal: NodeJS.Signals = "SIGTERM") {
  if (!child) return { code: 0, signal: null };

  childExitWasExpected = true;
  child.kill(signal);
  const killTimer = setTimeout(() => {
    if (child) {
      child.kill("SIGKILL");
    }
  }, childShutdownTimeoutMs);
  try {
    return await waitForChildExit();
  } finally {
    clearTimeout(killTimer);
  }
}

async function restartWatchChild(reason: string) {
  if (!child || restarting || shuttingDown) return;

  restarting = true;
  console.warn(`[paperclip] ${reason}; restarting dev server watcher`);
  try {
    await stopWatchChild();
    if (!shuttingDown) {
      spawnWatchChild();
    }
  } finally {
    restarting = false;
  }
}

async function probeHealth() {
  if (!healthCheckEnabled || restarting || shuttingDown || !child) return;

  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`health returned ${response.status}`);
    }
    childReachedHealthyState = true;
    consecutiveHealthFailures = 0;
  } catch (error) {
    const withinStartupGrace = !childReachedHealthyState && Date.now() - childStartAt < startupGraceMs;
    if (withinStartupGrace) {
      return;
    }

    consecutiveHealthFailures += 1;
    if (consecutiveHealthFailures < healthCheckFailureThreshold) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    await restartWatchChild(`dev server health check failed ${consecutiveHealthFailures} times (${detail})`);
  }
}

function installHealthTimer() {
  if (!healthCheckEnabled) return;
  healthTimer = setInterval(() => {
    void probeHealth();
  }, healthCheckIntervalMs);
  healthTimer.unref?.();
}

function clearHealthTimer() {
  if (!healthTimer) return;
  clearInterval(healthTimer);
  healthTimer = null;
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearHealthTimer();

  if (!child) {
    if (signal) {
      exitForSignal(signal);
      return;
    }
    process.exit(0);
    return;
  }

  const exit = await stopWatchChild(signal);
  if (exit.signal) {
    exitForSignal(signal);
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

spawnWatchChild();
installHealthTimer();
