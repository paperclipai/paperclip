import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageRunnerBinary } from "./stage-runner-binary.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function shouldSkipRunnerBinary(env = process.env) {
  const value = env.PAPERCLIP_SKIP_RUNNER_BINARY?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export async function buildRunnerBinary(options = {}) {
  const env = options.env ?? process.env;
  const root = options.packageRoot ?? packageRoot;
  const skip = shouldSkipRunnerBinary(env);
  const destinationDirectory = path.join(root, "dist", "bin");
  const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  const destination = path.join(destinationDirectory, executable);

  if (skip) {
    await rm(destination, { force: true });
    await rm(destinationDirectory, { recursive: true, force: true });
    process.stdout.write(
      "[paperclip-runner] skipping native runner binary build (PAPERCLIP_SKIP_RUNNER_BINARY is set)\n",
    );
    return { skipped: true };
  }

  const cargoArgs = [
    "build",
    "--release",
    "--manifest-path",
    path.join(root, "runner", "Cargo.toml"),
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
  ];

  const spawnFn = options.spawnFn ?? spawnSync;
  const result = spawnFn("cargo", cargoArgs, {
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

  const stageFn = options.stageFn ?? stageRunnerBinary;
  await stageFn(path.join(root, "runner", "target", "release", executable), destination);
  return { skipped: false, destination };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await buildRunnerBinary();
}
