import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Every restart re-runs the control plane from this worktree. A build, an
 * install or a branch switch during a wave would make later restarts run
 * different code (RC-32 was a runner `dist` rebuilt mid-wave), so the wave
 * fingerprints the checkout and the runner outputs after its own setup and
 * re-checks after each fault.
 */
export function guardedRunnerOutputs(repositoryRoot: string): string[] {
  const runner = process.env.PAPERCLIP_RUNNER_BINARY
    ?? path.join(repositoryRoot, "packages/paperclip-runner/runner/target/debug/paperclip-runnerd");
  return ["packages/paperclip-runner/dist", path.relative(repositoryRoot, runner)];
}

export function worktreeFingerprint(repositoryRoot: string, outputs: readonly string[] = ["packages/paperclip-runner/dist"]): string {
  const hash = createHash("sha256");
  const git = (args: string[]) => {
    try { return execFileSync("git", args, { cwd: repositoryRoot, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }); }
    catch { return Buffer.from("git-unavailable"); }
  };
  hash.update(git(["rev-parse", "HEAD"]));
  // Contents, not just paths: re-editing an already-dirty file must change the fingerprint.
  hash.update(git(["diff", "--binary", "HEAD"]));
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort()) {
    hash.update(`untracked:${file}:`);
    try { hash.update(readFileSync(path.join(repositoryRoot, file))); } catch { hash.update("unreadable"); }
  }
  // Ignored build outputs (runner dist and the runnerd binary) are covered by size and mtime.
  for (const output of outputs) {
    const walk = (current: string) => {
      const stat = statSync(current, { throwIfNoEntry: false });
      if (!stat) { hash.update(`missing:${path.relative(repositoryRoot, current)}\n`); return; }
      if (!stat.isDirectory()) { hash.update(`${path.relative(repositoryRoot, current)}:${stat.size}:${stat.mtimeMs}\n`); return; }
      for (const name of readdirSync(current).sort()) walk(path.join(current, name));
    };
    walk(path.join(repositoryRoot, output));
  }
  return hash.digest("hex");
}
