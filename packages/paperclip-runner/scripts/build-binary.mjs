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
  const result = spawnFn("pnpm", ["run", "build:binary"], {
    cwd: root,
    stdio: options.stdio ?? "inherit",
    env,
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
