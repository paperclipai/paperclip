import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveTsxLoaderPath(repoRoot) {
  const candidates = [
    path.join(repoRoot, "packages", "db", "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "loader.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function shouldWrapWithSharedPostgres({
  repoRoot,
  dryRun,
  hasSharedTestDatabase,
  usesPostgres,
  hasScheduledSuites,
  env = process.env,
}) {
  if (dryRun) return false;
  if (env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim()) return false;
  if (hasSharedTestDatabase) return false;
  const sharedOverride = env.PAPERCLIP_TEST_POSTGRES_SHARED?.trim().toLowerCase();
  if (sharedOverride === "0" || sharedOverride === "false") return false;
  // Mocked-pnpm node:test harnesses run under NODE_TEST_CONTEXT; don't boot a
  // real Postgres cluster for unit tests unless explicitly opted in.
  if (env.NODE_TEST_CONTEXT && sharedOverride !== "1" && sharedOverride !== "true") return false;
  if (!usesPostgres) return false;
  if (!hasScheduledSuites) return false;
  const wrapperScript = path.join(repoRoot, "packages", "db", "src", "test-postgres-command.ts");
  if (!existsSync(wrapperScript)) return false;
  return resolveTsxLoaderPath(repoRoot) !== null;
}

export async function runUnderSharedPostgres({
  repoRoot,
  runnerScriptPath,
  argv = process.argv.slice(2),
  env = process.env,
}) {
  const tsxLoader = resolveTsxLoaderPath(repoRoot);
  const wrapperScript = path.join(repoRoot, "packages", "db", "src", "test-postgres-command.ts");
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(tsxLoader).href,
      wrapperScript,
      "--",
      process.execPath,
      runnerScriptPath,
      ...argv,
    ],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // Ignore ESRCH if child already exited.
      }
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  process.on("SIGHUP", forwardSignal);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) resolve(128 + (os.constants.signals[signal] ?? 1));
        else resolve(code ?? 1);
      });
    });
    process.exitCode = status;
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
    process.removeListener("SIGHUP", forwardSignal);
  }
}
