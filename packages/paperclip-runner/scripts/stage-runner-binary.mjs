import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export async function stageRunnerBinary(source, destination) {
  const destinationDirectory = path.dirname(destination);
  await mkdir(destinationDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(destinationDirectory, ".runnerd-stage-"));
  const staged = path.join(stagingDirectory, path.basename(destination));
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") await chmod(staged, 0o755);
    // Sign the new inode before publication. Replacing the pathname atomically
    // preserves a running old executable instead of truncating its live inode.
    if (process.platform === "darwin") {
      await execFileAsync("codesign", ["--force", "--sign", "-", staged], { timeout: 30_000 });
      await execFileAsync("codesign", ["--verify", "--strict", staged], { timeout: 30_000 });
    }
    await rename(staged, destination);
  } finally {
    // This fresh directory is the only cleanup target, never the destination.
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  await stageRunnerBinary(
    path.join(packageRoot, "runner", "target", "release", executable),
    path.join(packageRoot, "dist", "bin", executable),
  );
}
