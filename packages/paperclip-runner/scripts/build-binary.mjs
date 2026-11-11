// The binary step of the Runner package's `build`. By default it runs the
// package's `build:binary` script, the one command that builds and stages
// paperclip-runnerd. With PAPERCLIP_SKIP_RUNNER_BINARY set, it removes any
// staged binary instead, so a source build works without a Rust toolchain.
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function shouldSkipRunnerBinary(env = process.env) {
  const value = env.PAPERCLIP_SKIP_RUNNER_BINARY?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * The pnpm that is running this script, the same rule as the server's
 * prepare-runner-vendor.mjs: pnpm sets npm_execpath to its own entry, which is a
 * JavaScript file for a normal install (run through this Node) or a native
 * executable for a standalone pnpm (run directly). The pnpm entry is not always
 * on PATH in a script (corepack, for one). Outside a pnpm script, `pnpm` on PATH
 * is the only option, and on Windows that is pnpm.cmd, which needs the shell.
 */
export function resolvePnpmInvocation(env = process.env, nodeExecPath = process.execPath, platform = process.platform) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && npmExecPath.toLowerCase().includes("pnpm")) {
    if (/\.(cjs|mjs|js)$/i.test(npmExecPath)) {
      return { command: nodeExecPath, argsPrefix: [npmExecPath], shell: false };
    }
    return { command: npmExecPath, argsPrefix: [], shell: false };
  }
  return { command: "pnpm", argsPrefix: [], shell: platform === "win32" };
}

export async function buildRunnerBinary(options = {}) {
  const env = options.env ?? process.env;
  const root = options.packageRoot ?? packageRoot;
  const destinationDirectory = path.join(root, "dist", "bin");

  if (shouldSkipRunnerBinary(env)) {
    await rm(destinationDirectory, { recursive: true, force: true });
    process.stdout.write(
      "[paperclip-runner] skipping native runner binary build (PAPERCLIP_SKIP_RUNNER_BINARY is set)\n",
    );
    return { skipped: true };
  }

  const spawnFn = options.spawnFn ?? spawnSync;
  const pnpm = resolvePnpmInvocation(env, options.nodeExecPath, options.platform);
  const result = spawnFn(pnpm.command, [...pnpm.argsPrefix, "run", "build:binary"], {
    cwd: root,
    stdio: options.stdio ?? "inherit",
    env,
    shell: pnpm.shell,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return { skipped: false };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await buildRunnerBinary();
}
