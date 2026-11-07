import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Every restart re-runs the control plane from this worktree. A build or a
 * branch switch during a wave would make later restarts run different code
 * (RC-32 was a runner `dist` rebuilt mid-wave), so the wave fingerprints the
 * checkout and the runner build output at start and re-checks after each fault.
 */
export function worktreeFingerprint(repositoryRoot: string, outputDirectories: readonly string[] = ["packages/paperclip-runner/dist"]): string {
  const hash = createHash("sha256");
  const git = (args: string[]) => {
    try { return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }); } catch { return "git-unavailable"; }
  };
  hash.update(git(["rev-parse", "HEAD"]));
  // Untracked results and gitignored build output are excluded here; the walk below covers build output.
  hash.update(git(["status", "--porcelain"]));
  for (const directory of outputDirectories) {
    const root = path.join(repositoryRoot, directory);
    const walk = (current: string) => {
      let entries: string[];
      try { entries = readdirSync(current).sort(); } catch { hash.update(`missing:${path.relative(root, current)}`); return; }
      for (const name of entries) {
        const full = path.join(current, name);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isDirectory()) walk(full);
        else hash.update(`${path.relative(repositoryRoot, full)}:${stat.size}:${stat.mtimeMs}\n`);
      }
    };
    walk(root);
  }
  return hash.digest("hex");
}
