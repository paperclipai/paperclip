import { readdirSync, statSync } from "node:fs";
import path from "node:path";

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

export function paperclipRunnerBinaryNeedsBuild({
  repoRoot,
  nativeRunnerRequired,
  configuredBinary,
  platform = process.platform,
}) {
  if (!nativeRunnerRequired) return false;
  if (configuredBinary?.trim()) return false;

  const executable = platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  const stagedBinary = path.join(packageRoot, "dist", "bin", executable);
  const binaryStat = statSync(stagedBinary, { throwIfNoEntry: false });
  if (!binaryStat?.isFile()) return true;

  const runnerRoot = path.join(packageRoot, "runner");
  const buildInputs = [
    path.join(runnerRoot, "Cargo.toml"),
    path.join(runnerRoot, "Cargo.lock"),
    path.join(runnerRoot, ".cargo"),
    path.join(runnerRoot, "rust-toolchain"),
    path.join(runnerRoot, "rust-toolchain.toml"),
    path.join(runnerRoot, "crates"),
  ];

  return buildInputs.some((input) => newestMtimeMs(input) > binaryStat.mtimeMs);
}
