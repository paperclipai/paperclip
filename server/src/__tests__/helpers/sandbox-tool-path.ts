import { execFile } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createSandboxToolPath(root: string): Promise<string> {
  const bin = path.join(root, "sandbox-tools");
  await mkdir(bin);
  for (const tool of [
    "sh", "mkdir", "rm", "mv", "cp", "cat", "base64", "sleep", "find", "tar", "chmod",
    "nohup", "basename", "wc", "head", "dd", "tee", "bash", "git",
  ]) {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v "$1"', "fixture-tool", tool]);
    await symlink(stdout.trim(), path.join(bin, tool));
  }
  await symlink(process.execPath, path.join(bin, "node"));
  return bin;
}
