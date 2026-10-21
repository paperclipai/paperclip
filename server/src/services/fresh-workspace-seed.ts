import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { materializeIsolatedTaskDirectory } from "./isolated-task-directory.js";

const execFile = promisify(execFileCallback);
const gitOptions = { timeout: 120_000, maxBuffer: 1024 * 1024 };

/** Seed from committed objects, never from a possibly changing old directory.
 * --no-local also prevents shared objects/hardlinks and copied Git authority.
 * The caller authorizes the source before calling this function. */
export async function materializeFreshWorkspaceSeed(input: {
  companyId: string; issueId: string; runId: string; sourceCwd: string; baseRef?: string | null; repoUrl?: string | null;
  beforeCopy?(sourceCwd: string, targetCwd: string): Promise<void>;
}) {
  const root = await materializeIsolatedTaskDirectory({
    companyId: input.companyId, issueId: input.issueId, attemptId: input.runId,
  });
  const destination = path.join(root, "workspace");
  const receiptPath = path.join(root, "seed.json");
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(destination) !== destination)
      throw new Error("Fresh workspace identity changed");
    const receiptStat = await lstat(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw new Error("Fresh workspace seed receipt changed");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.runId !== input.runId || receipt.companyId !== input.companyId || receipt.issueId !== input.issueId)
      throw new Error("Fresh workspace seed receipt changed");
    return destination;
  }
  const staging = await mkdtemp(path.join(root, ".seed-"));
  try {
    await input.beforeCopy?.(input.sourceCwd, destination);
    const probe = await execFile("git", ["-C", input.sourceCwd, "rev-parse", "--git-dir"],
      { ...gitOptions, env: { ...process.env, LC_ALL: "C" } })
      .then(() => true, (error: { code?: number; stderr?: string }) => {
        if (error.code === 128 && error.stderr?.startsWith("fatal: not a git repository")) return false;
        // Permission, corruption and transport failures are not permission to
        // replace a recorded repository with an empty workspace.
        throw error;
      });
    let commit: string | null = null;
    if (probe) {
      const ref = input.baseRef || "HEAD";
      const resolved = await execFile("git", ["-C", input.sourceCwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], gitOptions);
      commit = resolved.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid fresh workspace seed commit");
      await execFile("git", ["clone", "--no-local", "--no-checkout", "--", input.sourceCwd, staging], gitOptions);
      await execFile("git", ["-C", staging, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], gitOptions);
      // The old local directory is not a publication target for this attempt.
      await execFile("git", ["-C", staging, "remote", "remove", "origin"], gitOptions);
      if (input.repoUrl) await execFile("git", ["-C", staging, "remote", "add", "origin", input.repoUrl], gitOptions);
    }
    await writeFile(receiptPath, JSON.stringify({
      schema: "paperclip.fresh-workspace-seed.v1", companyId: input.companyId,
      issueId: input.issueId, runId: input.runId, commit,
    }), { mode: 0o600 });
    await rename(staging, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
