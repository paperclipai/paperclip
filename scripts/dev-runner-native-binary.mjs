import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runnerBinaryTarget } from "../packages/paperclip-runner/src/live/runner-binary.ts";

export function resolveNativeRunnerRequirement({ exitCode, stdout }) {
  if (exitCode !== 0) {
    return { nativeRunnerRequired: true, valid: false };
  }

  const jsonLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  for (let index = jsonLines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(jsonLines[index]);
      if (typeof payload?.nativeRunnerRequired === "boolean") {
        return { nativeRunnerRequired: payload.nativeRunnerRequired, valid: true };
      }
    } catch {
      // Keep scanning earlier JSON-looking output from pnpm and runtime logging.
    }
  }

  // An unknown state must not strand a persisted native run without runnerd.
  return { nativeRunnerRequired: true, valid: false };
}

function newestMtimeMs(target) {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest = stat.mtimeMs;
  for (const entry of readdirSync(target)) {
    const childNewest = newestMtimeMs(path.join(target, entry));
    if (childNewest > newest) newest = childNewest;
  }
  return newest;
}

export function resolveNativeRunnerDevBinary({
  repoRoot,
  platform = process.platform,
  architecture = process.arch,
}) {
  const executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  const target = path.join(packageRoot, "dist", "bin", `${platform}-${architecture}`, executable);
  const flat = path.join(packageRoot, "dist", "bin", executable);
  const targetStat = statSync(target, { throwIfNoEntry: false });
  const flatStat = statSync(flat, { throwIfNoEntry: false });
  if (flatStat?.isFile() && (!targetStat?.isFile() || flatStat.mtimeMs > targetStat.mtimeMs)
    && runnerBinaryTarget(readFileSync(flat)) === `${platform}-${architecture}`) {
    return { binary: flat, sourceBuild: true };
  }
  return targetStat?.isFile() ? { binary: target, sourceBuild: false } : null;
}

export function paperclipRunnerBinaryNeedsBuild({
  repoRoot,
  nativeRunnerRequired,
  configuredBinary,
  platform = process.platform,
  architecture = process.arch,
}) {
  if (!nativeRunnerRequired) return false;
  if (configuredBinary?.trim()) return false;

  const selected = resolveNativeRunnerDevBinary({ repoRoot, platform, architecture });
  if (!selected) return true;
  const binaryStat = statSync(selected.binary);
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");

  const runnerRoot = path.join(packageRoot, "runner");
  const buildInputs = [
    path.join(packageRoot, "antigravity-distributions.json"),
    path.join(packageRoot, "rust-toolchain.toml"),
    path.join(packageRoot, "protocol"),
    path.join(runnerRoot, "Cargo.toml"),
    path.join(runnerRoot, "Cargo.lock"),
    path.join(runnerRoot, ".cargo"),
    path.join(runnerRoot, "rust-toolchain"),
    path.join(runnerRoot, "rust-toolchain.toml"),
    path.join(runnerRoot, "crates"),
  ];

  return buildInputs.some((input) => newestMtimeMs(input) > binaryStat.mtimeMs);
}
