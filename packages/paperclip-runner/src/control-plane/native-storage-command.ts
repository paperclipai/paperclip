import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export function defaultStorageRunnerBinary(): string {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const name = `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`;
  const staged = resolve(root, "dist/bin", name);
  return existsSync(staged) ? staged : resolve(root, "runner/target/debug", name);
}

/** Storage-only native commands never launch a provider or inherit credentials. */
export async function nativeStorageCommand(args: string[], runnerBinary = defaultStorageRunnerBinary()): Promise<void> {
  try {
    await execute(runnerBinary, ["storage", ...args], { timeout: 30_000, maxBuffer: 8 * 1024, windowsHide: true, env: {} });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message, { cause: error });
  }
}
