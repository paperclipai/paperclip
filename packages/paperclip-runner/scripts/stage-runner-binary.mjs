import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
// Match Cargo's explicit target directory so isolated qualification builds
// cannot accidentally stage an older default-target executable.
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.cwd(), process.env.CARGO_TARGET_DIR)
  : path.join(packageRoot, "runner", "target");
const source = path.join(targetDirectory, "release", executable);
const destinationDirectory = path.join(packageRoot, "dist", "bin");
const destination = path.join(destinationDirectory, executable);

await mkdir(destinationDirectory, { recursive: true });
// Existing agents can keep this executable mapped for days. Never overwrite
// their inode (including during code signing); publish a new one atomically.
const temporary = `${destination}.${randomUUID()}.tmp`;
try {
  await copyFile(source, temporary);
  if (process.platform !== "win32") await chmod(temporary, 0o755);
  // Rust's linker emits an ad-hoc Mach-O signature. Copying that executable to
  // its package location preserves the bytes but can leave the kernel rejecting
  // the new inode with SIGKILL. Re-sign the staged inode so local packaged-runner
  // evals execute the same artifact that was just built.
  if (process.platform === "darwin") {
    // The staging filename is random, but the signed identifier must be
    // stable: identical code must retain its artifact digest across rebuilds.
    await execFileAsync("codesign", ["--force", "--sign", "-", "--identifier", "paperclip-runnerd", temporary]);
  }
  await rename(temporary, destination);
} finally { await rm(temporary, { force: true }); }
