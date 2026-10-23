import { execFile } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve tools from the host once, then expose only the fixture's tool set.
// The caller owns root and removes it after all sandbox commands have exited.
export async function createSandboxToolPath(root: string): Promise<string> {
  const bin = path.join(root, "sandbox-tools");
  await mkdir(bin);
  for (const tool of [
    "sh", "mkdir", "rm", "mv", "cp", "cat", "base64", "sleep", "find", "tar", "chmod",
    "nohup", "basename", "wc", "head", "dd", "tee",
  ]) {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v "$1"', "fixture-tool", tool]);
    await symlink(stdout.trim(), path.join(bin, tool));
  }
  await symlink(process.execPath, path.join(bin, "node"));
  return bin;
}
